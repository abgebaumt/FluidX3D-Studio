/**
 * Mesh sealing — `POST /api/stl/:id/seal` (CONTRACT.md section 8).
 *
 * This module glues the two computational halves together and owns everything
 * around them: request validation, the result cache, the sealed upload and its
 * entry in the STL index. The heavy lifting happens in
 *
 *   ./voxel-seal.js    sealMesh()      triangles -> voxel mask
 *   ./mesh-surface.js  surfaceFromMask() mask -> triangles, writeBinaryStl()
 *
 * and runs in a worker thread, because rasterising 60 000 triangles into a
 * million cells would otherwise block the event loop for seconds and stall
 * every other request. This very file is the worker entry point: loaded with
 * `workerData.kind === WORKER_KIND` it does not register routes but executes a
 * single sealing job and posts the statistics back.
 *
 * Nothing here touches FluidX3D. The sealed STL is an ordinary upload that the
 * solver voxelises with its unmodified code path.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { DATA_DIR, GENERATED_DIR, UPLOAD_DIR, safeJoin } from "./paths.js";

/** A sealing grid larger than this is refused — 40 M cells is ~40 MB of mask. */
export const MAX_SEAL_CELLS = 40_000_000;

/** Empty cells kept around the bounding box so the shell can never touch the border. */
export const SEAL_MARGIN_CELLS = 2;

export const SEAL_MODES = ["off", "shell", "fill"];
export const CLOSE_HOLES_RANGE = { min: 0, max: 3 };
export const MIN_THICKNESS_RANGE = { min: 1, max: 5 };

const CACHE_FILE = path.join(GENERATED_DIR, "seal-cache.json");
const STL_INDEX_FILE = path.join(GENERATED_DIR, "stl-index.json");
const CACHE_VERSION = 1;
const WORKER_KIND = "fluidx3d-studio-seal";
const WORKER_TIMEOUT_MS = 10 * 60 * 1000;
/** 80 byte STL header — ASCII only, and it must not start with "solid". */
const STL_HEADER = "FluidX3D Studio sealed mesh";

/* ------------------------------------------------------------------ errors */

/** An error whose message is safe to show the user (index.js reads publicMessage). */
function publicError(message, status = 500) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

/* ------------------------------------------------------------ number output */

function fmt(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Cell sizes span several orders of magnitude, so show three significant digits. */
function fmtCell(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value);
  const digits = Math.max(0, Math.min(12, 2 - Math.floor(Math.log10(Math.abs(n)))));
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/* ------------------------------------------------------------------- grid */

/**
 * Empty cells sealMesh() needs around the object: the closing and the
 * thickening must not reach the border, or the flood fill finds no outside
 * left. Mirrors the rule in voxel-seal.js so that the grid predicted here is
 * the grid that is actually allocated.
 */
export function sealMargin(mode, closeHoles, minThickness) {
  const closeRadius = Math.min(8, Math.max(0, Math.round(closeHoles) || 0));
  const thickenRadius = mode === "shell" ? Math.max(0, Math.round(minThickness) - 1) : 0;
  return Math.max(closeRadius, thickenRadius) + SEAL_MARGIN_CELLS;
}

/**
 * The grid a sealing run would use — the same arithmetic as gridFor() in
 * voxel-seal.js: the lattice is snapped to a multiple of the cell size and
 * padded by `margin` cells on every side.
 */
export function estimateGrid(bbox, cell, margin = SEAL_MARGIN_CELLS) {
  const m = Math.max(0, Math.round(margin));
  const dims = [0, 1, 2].map((axis) => {
    const aligned = Math.floor(Number(bbox.min[axis]) / cell) * cell;
    const span = Math.max(1, Math.ceil((Number(bbox.max[axis]) - aligned) / cell));
    return span + 2 * m;
  });
  return { dims, cells: dims[0] * dims[1] * dims[2] };
}

/** Smallest cell size (rounded up a little) that keeps the grid under the limit. */
function suggestCell(bbox, cell, margin) {
  const start = estimateGrid(bbox, cell, margin);
  let candidate = cell * Math.cbrt(start.cells / MAX_SEAL_CELLS);
  for (let i = 0; i < 64 && estimateGrid(bbox, candidate, margin).cells > MAX_SEAL_CELLS; i++) {
    candidate *= 1.05;
  }
  // Round up to three significant digits so the number reads like a setting.
  const magnitude = Math.pow(10, Math.floor(Math.log10(candidate)) - 2);
  return Math.ceil(candidate / magnitude) * magnitude;
}

/* ------------------------------------------------------------- input check */

function pick(body, ...names) {
  for (const name of names) {
    if (body[name] !== undefined && body[name] !== null && body[name] !== "") return body[name];
  }
  return undefined;
}

function toNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Reads and checks the request body; `errors` is empty when everything fits. */
function readParams(body) {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const errors = [];

  const rawMode = pick(src, "mode");
  let mode = "off";
  if (rawMode === undefined) {
    errors.push(`mode is missing. Allowed: ${SEAL_MODES.join(", ")}.`);
  } else {
    const match = SEAL_MODES.find((m) => String(rawMode).trim().toLowerCase() === m);
    if (match === undefined) {
      errors.push(`mode "${String(rawMode).slice(0, 40)}" is unknown. Allowed: ${SEAL_MODES.join(", ")}.`);
    } else {
      mode = match;
    }
  }

  const closeHoles = readInt(errors, "close_holes", pick(src, "close_holes", "closeHoles"), 1, CLOSE_HOLES_RANGE);
  const minThickness = readInt(errors, "min_thickness", pick(src, "min_thickness", "minThickness"), 1, MIN_THICKNESS_RANGE);

  const rawCell = pick(src, "cell_m", "cellM", "cell");
  let cell = NaN;
  if (rawCell === undefined) {
    if (mode !== "off") errors.push("cell_m is missing. The cell size of the simulation must be given.");
  } else {
    cell = toNumber(rawCell);
    if (Number.isNaN(cell)) {
      errors.push("cell_m must be a number.");
    } else if (!(cell > 0)) {
      errors.push(`cell_m must be greater than 0 (got ${fmtCell(cell)}).`);
    } else if (cell > 1e6) {
      errors.push(`cell_m is unrealistically large (got ${fmtCell(cell)} m).`);
    }
  }

  /**
   * The mesh keeps its own units — a Blender export is often in millimetres —
   * while `cell_m` is the simulation's cell size in metres. The object is scaled
   * on its way into the domain, so the cell size has to travel the other way
   * before it can be compared against raw STL coordinates. Without this the
   * grid is off by the scale factor: a 25 metre span exported in millimetres
   * asks for three million cells per axis instead of four hundred.
   */
  const rawScale = pick(src, "mesh_scale", "meshScale", "scale");
  let meshScale = 1;
  if (rawScale !== undefined) {
    const s = toNumber(rawScale);
    if (Number.isNaN(s)) {
      errors.push("mesh_scale must be a number.");
    } else if (!(s > 0)) {
      errors.push(`mesh_scale must be greater than 0 (got ${fmt(s, 6)}).`);
    } else {
      meshScale = s;
    }
  }

  const cellMesh = cell > 0 && meshScale > 0 ? cell / meshScale : NaN;

  return { errors, mode, closeHoles, minThickness, cell, meshScale, cellMesh };
}

function readInt(errors, label, raw, fallback, range) {
  if (raw === undefined) return fallback;
  const n = toNumber(raw);
  if (Number.isNaN(n)) {
    errors.push(`${label} must be an integer between ${range.min} and ${range.max}.`);
    return fallback;
  }
  const rounded = Math.round(n);
  if (rounded < range.min || rounded > range.max) {
    errors.push(`${label} must be between ${range.min} and ${range.max} (got ${fmt(n, 0)}).`);
    return Math.min(range.max, Math.max(range.min, rounded));
  }
  return rounded;
}

/* ------------------------------------------------------------------- names */

/** `1785-body.stl` -> `1785-body-sealed.stl`; the source id is kept readable. */
function sealedNameFor(sourceId) {
  const stem = String(sourceId).replace(/\.stl$/i, "");
  return `${stem}-sealed.stl`;
}

function cacheKey(sourceId, mode, closeHoles, minThickness, cell) {
  // toPrecision keeps 0.0588 and 0.058800000000000004 on the same cache entry.
  const cellKey = Number(Number(cell).toPrecision(9)).toString();
  return crypto
    .createHash("sha1")
    .update([sourceId, mode, closeHoles, minThickness, cellKey].join("|"), "utf8")
    .digest("hex")
    .slice(0, 16);
}

/* ------------------------------------------------------------------- files */

function writeJsonAtomic(file, value, log) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log?.(`Could not write ${path.basename(file)}:`, err.message);
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------- cache */

function readCache(log) {
  const raw = readJson(CACHE_FILE, null);
  if (!raw || typeof raw !== "object" || raw.version !== CACHE_VERSION || typeof raw.entries !== "object") {
    return { version: CACHE_VERSION, entries: {} };
  }
  const entries = {};
  for (const [key, rec] of Object.entries(raw.entries)) {
    if (rec && typeof rec.sourceId === "string" && typeof rec.file === "string") entries[key] = rec;
  }
  log?.(`Sealing cache: ${Object.keys(entries).length} entries`);
  return { version: CACHE_VERSION, entries };
}

/** A cache hit only counts while the file it points at is still on disk. */
function cachedFile(rec) {
  if (!rec) return null;
  const abs = safeJoin(DATA_DIR, rec.file);
  if (!abs) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    if (Number.isFinite(rec.sizeBytes) && stat.size !== rec.sizeBytes) return null;
    return abs;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- STL index */

/**
 * The sealed upload is registered in data/generated/stl-index.json, the index
 * api-stl.js maintains. That module holds its entries in memory and rewrites
 * the file on every upload or deletion, so this one re-applies its own entries
 * on every request instead of assuming they survived — and drops derived
 * entries whose file has disappeared.
 */
function syncStlIndex(cache, log, dropIds = []) {
  const managed = new Map();
  for (const rec of Object.values(cache.entries)) {
    if (!cachedFile(rec)) continue;
    managed.set(rec.sealedId, indexEntryFor(rec));
  }
  for (const id of dropIds) managed.delete(id);

  const stored = readJson(STL_INDEX_FILE, []);
  const current = Array.isArray(stored) ? stored : [];
  const kept = current.filter((entry) => {
    if (!entry || typeof entry.id !== "string") return false;
    if (managed.has(entry.id) || dropIds.includes(entry.id)) return false;
    if (typeof entry.derivedFrom === "string") {
      const abs = safeJoin(DATA_DIR, String(entry.file || ""));
      return Boolean(abs) && fs.existsSync(abs); // forget sealed files that are gone
    }
    return true;
  });

  const merged = [...kept, ...managed.values()];
  merged.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  writeJsonAtomic(STL_INDEX_FILE, merged, log);
}

function indexEntryFor(rec) {
  return {
    id: rec.sealedId,
    name: rec.name,
    file: rec.file,
    sizeBytes: rec.sizeBytes,
    triangles: rec.triangles,
    format: "binary",
    bbox: rec.bbox,
    uploadedAt: rec.computedAt,
    derivedFrom: rec.sourceId,
    sealing: {
      mode: rec.mode,
      closeHoles: rec.closeHoles,
      minThickness: rec.minThickness,
      cellM: rec.cellM
    }
  };
}

function findSource(id) {
  const entries = readJson(STL_INDEX_FILE, []);
  if (!Array.isArray(entries)) return null;
  return entries.find((e) => e && e.id === id) || null;
}

/* ------------------------------------------------------------------ worker */

/** Runs one sealing job off the event loop. Resolves with the worker's result. */
function runSealWorker(job) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { kind: WORKER_KIND, job } });
    } catch (err) {
      reject(publicError(`Sealing could not be started: ${err.message}`, 500));
      return;
    }

    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(publicError("Sealing took too long and was aborted. Choose a larger cell size.", 504)),
      WORKER_TIMEOUT_MS
    );
    timer.unref?.();

    worker.on("message", (msg) => {
      if (msg && msg.ok) finish(null, msg.result);
      else finish(publicError(String(msg?.error || "Sealing failed."), msg?.status || 500));
    });
    worker.on("error", (err) => finish(publicError(`Sealing failed: ${err.message}`, 500)));
    worker.on("exit", (code) => {
      finish(publicError(`Sealing ended unexpectedly (code ${code}).`, 500));
    });
  });
}

/* ------------------------------------------------------------------ routes */

export function register(router, ctx) {
  const log = (...args) => ctx?.log?.(...args);

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const cache = readCache(log);
  const persistCache = () => writeJsonAtomic(CACHE_FILE, cache, log);
  // api-stl.js rebuilt the index a moment ago from the upload directory; put the
  // sealing metadata of known results back on top of it.
  if (Object.keys(cache.entries).length > 0) syncStlIndex(cache, log);

  /** One sealing run at a time — each one owns a multi-megabyte mask. */
  let queue = Promise.resolve();
  const runExclusive = (fn) => {
    const next = queue.then(() => fn(), () => fn());
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  /** Identical requests arriving while one is running share its result. */
  const inflight = new Map();

  router.post("/stl/:id/seal", (req, res, next) => {
    handleSeal(req, res).catch(next);
  });

  async function handleSeal(req, res) {
    const sourceId = req.params.id;
    const source = findSource(sourceId);
    if (!source) {
      res.status(404).json({ error: "This STL file is not known." });
      return;
    }

    const params = readParams(req.body);
    if (params.errors.length > 0) {
      res.status(400).json({ error: params.errors.join(" ") });
      return;
    }
    const { mode, closeHoles, minThickness, cell, meshScale, cellMesh } = params;

    if (mode === "off") {
      const removed = await removeSealed(sourceId);
      res.json({
        sealedId: null,
        file: null,
        sealedFile: null,
        cell_m: null,
        seconds: 0,
        cached: false,
        removed,
        stats: null
      });
      return;
    }

    const bbox = source.bbox;
    if (!bbox || !Array.isArray(bbox.min) || !Array.isArray(bbox.max)) {
      res.status(400).json({ error: "No bounding box is known for this STL file. Upload the file again." });
      return;
    }

    const margin = sealMargin(mode, closeHoles, minThickness);
    // bbox is in mesh units, so the grid has to be measured in mesh units too
    const grid = estimateGrid(bbox, cellMesh, margin);
    if (grid.cells > MAX_SEAL_CELLS) {
      const suggestionMesh = suggestCell(bbox, cellMesh, margin);
      const suggestionM = suggestionMesh * meshScale;   // report in simulation units
      res.status(400).json({
        error:
          `At a cell size of ${fmtCell(cell)} m, sealing would need a grid of ` +
          `${grid.dims[0]} × ${grid.dims[1]} × ${grid.dims[2]} cells (${fmt(grid.cells)} cells). ` +
          `At most ${fmt(MAX_SEAL_CELLS)} cells are allowed. ` +
          `A coarser domain with a cell size of at least ${fmtCell(suggestionM)} m would fit, ` +
          `giving ${fmt(estimateGrid(bbox, suggestionMesh, margin).cells)} cells.`
      });
      return;
    }

    const sourcePath = safeJoin(DATA_DIR, source.file);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      res.status(404).json({ error: "The source file is no longer in the upload directory." });
      return;
    }

    // keyed on the mesh-unit cell size: that is what actually shapes the result
    const key = cacheKey(sourceId, mode, closeHoles, minThickness, cellMesh);
    const hit = cache.entries[key];
    if (hit && cachedFile(hit)) {
      syncStlIndex(cache, log);
      res.json(responseFor(hit, true));
      return;
    }

    const pending = inflight.get(key);
    if (pending) {
      const rec = await pending;
      res.json(responseFor(rec, true));
      return;
    }

    const work = runExclusive(() => compute()).finally(() => inflight.delete(key));
    inflight.set(key, work);
    const rec = await work;
    res.json(responseFor(rec, false));

    async function compute() {
      // A second request may have finished the same job while this one queued.
      const again = cache.entries[key];
      if (again && cachedFile(again)) return again;

      const sealedId = sealedNameFor(sourceId);
      const outPath = path.join(UPLOAD_DIR, sealedId);
      const started = Date.now();

      log(`Sealing started: ${source.file} (${mode}, close_holes ${closeHoles}, min_thickness ${minThickness}, ${fmtCell(cell)} m` +
          (meshScale !== 1 ? `, mesh scale ${fmt(meshScale, 6)}` : "") + ")");

      const result = await runSealWorker({
        sourcePath,
        outPath,
        mode,
        closeHoles,
        minThickness,
        cell: cellMesh,          // the worker voxelises in the mesh's own units
        margin,
        maxCells: MAX_SEAL_CELLS
      });

      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const rec = {
        key,
        sourceId,
        sealedId,
        name: `${source.name || sourceId} (sealed)`,
        file: `uploads/${sealedId}`,
        mode,
        closeHoles,
        minThickness,
        cellM: cell,
        meshScale,
        cellMesh,
        computedAt: new Date().toISOString(),
        seconds,
        sizeBytes: result.sizeBytes,
        triangles: result.stats.trianglesOut,
        bbox: result.bbox,
        stats: result.stats
      };

      // One sealed file per source: older variants pointed at the same path.
      for (const [otherKey, other] of Object.entries(cache.entries)) {
        if (other.sourceId === sourceId && otherKey !== key) delete cache.entries[otherKey];
      }
      cache.entries[key] = rec;
      persistCache();
      syncStlIndex(cache, log);

      log(
        `Sealing finished: ${rec.file} — ${fmt(result.stats.trianglesOut)} triangles, ` +
        `grid ${result.stats.grid.join(" × ")}, ${fmt(result.stats.lostCells)} cells lost without sealing, ${fmt(seconds, 1)} s`
      );
      return rec;
    }
  }

  /** Deletes the sealed file of a source and forgets every cache entry for it. */
  async function removeSealed(sourceId) {
    const victims = Object.entries(cache.entries).filter(([, rec]) => rec.sourceId === sourceId);
    const dropIds = new Set();
    let removed = false;

    for (const [key, rec] of victims) {
      const abs = safeJoin(DATA_DIR, rec.file);
      if (abs) {
        try {
          await fsp.unlink(abs);
          removed = true;
        } catch {
          // already gone
        }
      }
      dropIds.add(rec.sealedId);
      delete cache.entries[key];
    }

    // The file may exist without a cache entry (cache lost, file kept).
    const orphan = path.join(UPLOAD_DIR, sealedNameFor(sourceId));
    if (fs.existsSync(orphan)) {
      try {
        await fsp.unlink(orphan);
        removed = true;
      } catch {
        // keep going — the index entry is dropped either way
      }
    }
    dropIds.add(sealedNameFor(sourceId));

    if (victims.length > 0) persistCache();
    syncStlIndex(cache, log, [...dropIds]);
    if (removed) log(`Sealing removed: ${sealedNameFor(sourceId)}`);
    return removed;
  }
}

function responseFor(rec, cached) {
  return {
    sealedId: rec.sealedId,
    file: rec.file,
    sealedFile: rec.file,
    derivedFrom: rec.sourceId,
    cell_m: rec.cellM,
    mode: rec.mode,
    close_holes: rec.closeHoles,
    min_thickness: rec.minThickness,
    computed_at: rec.computedAt,
    seconds: rec.seconds,
    cached,
    stats: rec.stats
  };
}

export default { register };

/* ================================================================= worker */
/* Everything below runs in the worker thread only.                          */

/**
 * Calls a helper module. The first argument list is the documented signature;
 * the remaining ones are calling conventions the module could plausibly use
 * instead, tried only when the documented call produced an unusable shape or a
 * TypeError. Anything else — a user-facing failure raised by the module itself,
 * for instance "the grid would be too large" — is passed straight on to the user.
 */
async function callModule(fn, name, variants, normalize) {
  let shapeSeen = false;
  for (let i = 0; i < variants.length; i++) {
    let out;
    try {
      out = await fn(...variants[i]);
    } catch (err) {
      const mismatch = err instanceof TypeError;
      if (!mismatch || i === variants.length - 1) {
        throw publicError(err.publicMessage || err.message || `${name}() failed.`, err.status || 500);
      }
      continue;
    }
    const value = normalize(out);
    if (value !== null && value !== undefined) return value;
    shapeSeen = true;
  }
  throw publicError(
    `${name}() from the sealing module returned ${shapeSeen ? "an unexpected result shape" : "no result"}.`,
    500
  );
}

async function loadModule(specifier, exportName) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND") {
      throw publicError(`The sealing module ${specifier} is missing from server/; sealing is not available.`, 501);
    }
    throw publicError(`The sealing module ${specifier} could not be loaded: ${err.message}`, 500);
  }
  const fn = mod[exportName] ?? mod.default?.[exportName];
  if (typeof fn !== "function") {
    throw publicError(`The sealing module ${specifier} does not provide ${exportName}().`, 500);
  }
  return fn;
}

/* ---------------------------------------------------------- STL triangles */

const BIN_HEADER = 84;
const BIN_TRIANGLE = 50;

function isSpaceByte(b) {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0b || b === 0x0c;
}

function isWordAt(buffer, start, end, word) {
  if (end - start !== word.length) return false;
  for (let i = 0; i < word.length; i++) {
    let b = buffer[start + i];
    if (b >= 0x41 && b <= 0x5a) b += 0x20;
    if (b !== word.charCodeAt(i)) return false;
  }
  return true;
}

function looksAscii(buffer) {
  let i = 0;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) i = 3;
  while (i < buffer.length && isSpaceByte(buffer[i])) i++;
  if (!isWordAt(buffer, i, i + 5, "solid")) return false;
  const probe = buffer.subarray(0, Math.min(buffer.length, 65536));
  return probe.indexOf("facet", 0, "latin1") !== -1 || probe.indexOf("endsolid", 0, "latin1") !== -1;
}

/** Flat XYZ triples, nine floats per triangle — the form sealMesh() receives. */
function readBinaryTriangles(buffer, count) {
  const positions = new Float32Array(count * 9);
  let out = 0;
  for (let t = 0; t < count; t++) {
    let off = BIN_HEADER + t * BIN_TRIANGLE + 12; // skip the stored normal
    for (let v = 0; v < 9; v++, off += 4) positions[out++] = buffer.readFloatLE(off);
  }
  return { positions, count, format: "binary" };
}

function readAsciiTriangles(buffer) {
  let capacity = 9 * 1024;
  let data = new Float32Array(capacity);
  let used = 0;
  const coord = [0, 0, 0];
  let pending = 0;
  let i = 0;
  const n = buffer.length;

  while (i < n) {
    while (i < n && isSpaceByte(buffer[i])) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpaceByte(buffer[i])) i++;

    if (pending > 0) {
      const value = Number(buffer.toString("latin1", start, i));
      if (!Number.isFinite(value)) {
        pending = 0; // malformed vertex — resynchronise on the next keyword
        continue;
      }
      coord[3 - pending] = value;
      if (--pending === 0) {
        if (used + 3 > capacity) {
          capacity *= 2;
          const bigger = new Float32Array(capacity);
          bigger.set(data.subarray(0, used));
          data = bigger;
        }
        data[used++] = coord[0];
        data[used++] = coord[1];
        data[used++] = coord[2];
      }
      continue;
    }
    if (isWordAt(buffer, start, i, "vertex")) pending = 3;
  }

  const count = Math.floor(used / 9);
  return { positions: data.slice(0, count * 9), count, format: "ascii" };
}

function readTriangles(buffer) {
  if (buffer.length >= BIN_HEADER) {
    const announced = buffer.readUInt32LE(80);
    const expected = BIN_HEADER + BIN_TRIANGLE * announced;
    if (announced > 0 && buffer.length === expected) return readBinaryTriangles(buffer, announced);
    if (looksAscii(buffer)) {
      const ascii = readAsciiTriangles(buffer);
      if (ascii.count > 0) return ascii;
    }
    if (announced > 0 && buffer.length > expected) return readBinaryTriangles(buffer, announced);
  } else if (looksAscii(buffer)) {
    const ascii = readAsciiTriangles(buffer);
    if (ascii.count > 0) return ascii;
  }
  throw publicError("The source file could not be read as either a binary or an ASCII STL.", 400);
}

/* -------------------------------------------------------------- normalise */

function isMask(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView) && value.length > 0;
}

function asDims(value) {
  if (!value) return null;
  const list = ArrayBuffer.isView(value) ? Array.from(value) : value;
  if (!Array.isArray(list) || list.length !== 3) return null;
  const dims = list.map((n) => Math.round(Number(n)));
  return dims.every((n) => Number.isFinite(n) && n > 0) ? dims : null;
}

function asVec3(value, fallback) {
  const list = ArrayBuffer.isView(value) ? Array.from(value) : value;
  if (!Array.isArray(list) || list.length !== 3) return fallback;
  const vec = list.map(Number);
  return vec.every((n) => Number.isFinite(n)) ? vec : fallback;
}

/**
 * Unifies what sealMesh() returns: `{ mask, grid: { origin, cell, dims }, stats }`
 * in voxel-seal.js, with the grid fields at the top level tolerated as well.
 */
function normalizeSeal(out, job) {
  if (!out || typeof out !== "object") return null;
  const mask = [out.mask, out.solid, out.voxels, out.data].find(isMask);
  if (!mask) return null;

  const grid = out.grid && typeof out.grid === "object" && !Array.isArray(out.grid) ? out.grid : out;
  const dims = asDims(out.dims) || asDims(grid.dims) || asDims(grid.size) ||
    asDims(Array.isArray(out.grid) ? out.grid : null) || asDims([grid.nx, grid.ny, grid.nz]);
  if (!dims) return null;
  if (mask.length !== dims[0] * dims[1] * dims[2]) return null;

  const origin = asVec3(out.origin, null) || asVec3(grid.origin, null) || asVec3(grid.min, [0, 0, 0]);
  const cell = [out.cell, grid.cell, grid.cellM, grid.cell_m]
    .map(Number)
    .find((n) => Number.isFinite(n) && n > 0);
  const stats = out.stats && typeof out.stats === "object" ? out.stats : out;
  return { mask, dims, origin, cell: cell ?? job.cell, stats, grid: { origin, cell: cell ?? job.cell, dims } };
}

/** Accepts the shapes surfaceFromMask() may return and yields flat positions. */
function normalizeSurface(out) {
  if (!out) return null;
  let positions = null;
  let indices = null;

  if (ArrayBuffer.isView(out) || Array.isArray(out)) {
    positions = out;
  } else if (typeof out === "object") {
    positions = [out.positions, out.vertices, out.triangles, out.points, out.data].find(
      (v) => ArrayBuffer.isView(v) || Array.isArray(v)
    );
    const idx = [out.indices, out.index, out.faces].find((v) => ArrayBuffer.isView(v) || Array.isArray(v));
    if (idx) indices = idx;
  }
  if (!positions) return null;

  if (indices) {
    const expanded = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) {
      const base = indices[i] * 3;
      expanded[i * 3] = positions[base];
      expanded[i * 3 + 1] = positions[base + 1];
      expanded[i * 3 + 2] = positions[base + 2];
    }
    positions = expanded;
  }

  const flat = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  if (flat.length === 0 || flat.length % 9 !== 0) return null;
  return flat;
}

function boxOf(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i + axis];
      if (v < min[axis]) min[axis] = v;
      if (v > max[axis]) max[axis] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

function countSolid(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) n++;
  return n;
}

/** Triangles whose bounding box fits inside one cell — the ones voxelisation loses. */
function countThinFaces(positions, cell) {
  let thin = 0;
  for (let t = 0; t < positions.length; t += 9) {
    let ok = true;
    for (let axis = 0; axis < 3 && ok; axis++) {
      const a = positions[t + axis];
      const b = positions[t + 3 + axis];
      const c = positions[t + 6 + axis];
      if (Math.max(a, b, c) - Math.min(a, b, c) >= cell) ok = false;
    }
    if (ok) thin++;
  }
  return thin;
}

function numberOr(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------- worker main */

async function runSealJob(job) {
  const buffer = fs.readFileSync(job.sourcePath);
  const mesh = readTriangles(buffer);
  if (mesh.count === 0) throw publicError("The source file contains no triangles.", 400);

  const sealOptions = {
    triangles: mesh.positions,
    positions: mesh.positions,
    triangleCount: mesh.count,
    count: mesh.count,
    cell: job.cell,
    cellM: job.cell,
    cell_m: job.cell,
    mode: job.mode,
    closeHoles: job.closeHoles,
    close_holes: job.closeHoles,
    minThickness: job.minThickness,
    min_thickness: job.minThickness,
    margin: job.margin,
    marginCells: job.margin,
    maxCells: job.maxCells
  };

  const sealMesh = await loadModule("./voxel-seal.js", "sealMesh");
  const seal = await callModule(
    sealMesh,
    "sealMesh",
    [[mesh.positions, sealOptions], [sealOptions]],
    (out) => normalizeSeal(out, job)
  );

  const cells = seal.dims[0] * seal.dims[1] * seal.dims[2];
  if (cells > job.maxCells) {
    throw publicError(
      `The sealing grid has ${cells.toLocaleString("en-US")} cells, more than allowed. ` +
      "Choose a larger cell size.",
      400
    );
  }

  const surfaceOptions = { mask: seal.mask, ...seal.grid, size: seal.dims };
  const surfaceFromMask = await loadModule("./mesh-surface.js", "surfaceFromMask");
  const positions = await callModule(
    surfaceFromMask,
    "surfaceFromMask",
    [[seal.mask, seal.grid], [seal.mask, seal.dims, surfaceOptions], [surfaceOptions]],
    normalizeSurface
  );
  const trianglesOut = positions.length / 9;

  const writeBinaryStl = await loadModule("./mesh-surface.js", "writeBinaryStl");
  const stlBuffer = await callModule(
    writeBinaryStl,
    "writeBinaryStl",
    [[positions, STL_HEADER], [{ triangles: positions, positions, count: trianglesOut }]],
    (out) => (Buffer.isBuffer(out) || out instanceof Uint8Array || out instanceof ArrayBuffer ? out : null)
  );
  let bytes;
  if (Buffer.isBuffer(stlBuffer)) bytes = stlBuffer;
  else if (stlBuffer instanceof Uint8Array) bytes = Buffer.from(stlBuffer.buffer, stlBuffer.byteOffset, stlBuffer.byteLength);
  else bytes = Buffer.from(stlBuffer); // ArrayBuffer

  fs.mkdirSync(path.dirname(job.outPath), { recursive: true });
  const tmp = `${job.outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, job.outPath);

  const solidCells = numberOr(seal.stats?.solidCells, NaN);
  const stats = {
    trianglesIn: mesh.count,
    trianglesOut,
    grid: seal.dims,
    cells,
    solidCells: Number.isFinite(solidCells) ? solidCells : countSolid(seal.mask),
    shellCells: numberOr(seal.stats?.shellCells, null),
    filledCells: numberOr(seal.stats?.filledCells, null),
    closed: typeof seal.stats?.closed === "boolean" ? seal.stats.closed : null,
    // triangulation fineness — kept for reference, but it says nothing about loss
    thinFaces: numberOr(seal.stats?.thinFaces, countThinFaces(mesh.positions, job.cell)),
    // measured against a replica of FluidX3D's own ray casting: the cells it would miss
    lostCells: numberOr(seal.stats?.lostCells, null),
    lostFraction: numberOr(seal.stats?.lostFraction, null),
    raycastCells: numberOr(seal.stats?.raycastCells, null)
  };

  return { stats, bbox: boxOf(positions), sizeBytes: bytes.length, format: mesh.format };
}

if (!isMainThread && workerData && workerData.kind === WORKER_KIND) {
  runSealJob(workerData.job).then(
    (result) => parentPort.postMessage({ ok: true, result }),
    (err) => parentPort.postMessage({ ok: false, error: err.publicMessage || err.message, status: err.status || 500 })
  );
}
