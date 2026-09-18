/**
 * STL upload and management — `GET/POST /api/stl`, `DELETE /api/stl/:id`,
 * `GET /api/stl/:id/raw`.
 *
 * Uploads live in data/uploads/, their metadata in data/generated/stl-index.json.
 * The index is a cache: the upload directory is the truth, and the index is
 * rebuilt from it whenever it is missing or out of date.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import multer from "multer";

import { DATA_DIR, GENERATED_DIR, UPLOAD_DIR, safeJoin } from "./paths.js";
import { parseStl } from "./stl-info.js";

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const INDEX_FILE = path.join(GENERATED_DIR, "stl-index.json");
const MAX_STEM_LENGTH = 80;

/* ------------------------------------------------------------------ naming */

/** Reduces an arbitrary client file name to `[A-Za-z0-9._-]` plus an .stl suffix. */
function sanitizeName(original) {
  const base = path.basename(String(original || "")).replace(/\\/g, "/").split("/").pop() || "";
  let clean = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/_{2,}/g, "_").replace(/^[._-]+/, "");
  let stem = clean.replace(/\.stl$/i, "");
  if (stem.length > MAX_STEM_LENGTH) stem = stem.slice(0, MAX_STEM_LENGTH);
  if (stem.length === 0) stem = "model";
  return `${stem}.stl`;
}

/** Timestamp prefix plus sanitised name, retried until the name is free. */
function uniqueName(original) {
  const clean = sanitizeName(original);
  const stamp = Date.now();
  let candidate = `${stamp}-${clean}`;
  for (let n = 1; fs.existsSync(path.join(UPLOAD_DIR, candidate)); n++) {
    candidate = `${stamp}-${n}-${clean}`;
  }
  return candidate;
}

/** Best-effort recovery of the original name from a stored file name. */
function displayName(storedName) {
  return storedName.replace(/^\d{10,}-(?:\d+-)?/, "") || storedName;
}

/* ------------------------------------------------------------------ index */

function readIndexFile() {
  try {
    const raw = fs.readFileSync(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIndexFile(entries, log) {
  try {
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    const tmp = `${INDEX_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    fs.renameSync(tmp, INDEX_FILE);
  } catch (err) {
    log?.("Could not write the STL index:", err.message);
  }
}

function isValidEntry(entry) {
  return Boolean(
    entry &&
    typeof entry.id === "string" &&
    typeof entry.file === "string" &&
    Number.isFinite(entry.sizeBytes) &&
    Number.isFinite(entry.triangles) &&
    entry.bbox && Array.isArray(entry.bbox.min) && Array.isArray(entry.bbox.max)
  );
}

function makeEntry(storedName, sizeBytes, info, uploadedAt, name) {
  return {
    id: storedName,
    name: name || displayName(storedName),
    file: `uploads/${storedName}`, // relative to data/, as the setup config expects
    sizeBytes,
    triangles: info.triangles,
    format: info.format,
    bbox: info.bbox,
    uploadedAt
  };
}

/**
 * Reconciles the cached index with the upload directory: forgets vanished
 * files, inspects unknown or changed ones. A file that cannot be parsed is
 * skipped, never deleted — it may be something the user put there on purpose.
 */
function rebuildIndex(log) {
  const cached = new Map();
  for (const entry of readIndexFile()) {
    if (isValidEntry(entry)) cached.set(entry.id, entry);
  }

  let names = [];
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    names = fs.readdirSync(UPLOAD_DIR).filter((n) => /\.stl$/i.test(n)).sort();
  } catch (err) {
    log?.("Upload directory not readable:", err.message);
    return { entries: [...cached.values()], changed: false };
  }

  const entries = [];
  let changed = cached.size !== names.length;

  for (const name of names) {
    const abs = path.join(UPLOAD_DIR, name);
    let stat;
    try {
      stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    const known = cached.get(name);
    if (known && known.sizeBytes === stat.size) {
      entries.push(known);
      continue;
    }

    try {
      const info = parseStl(fs.readFileSync(abs));
      entries.push(makeEntry(name, stat.size, info, stat.mtime.toISOString(), known?.name));
      changed = true;
    } catch (err) {
      log?.(`Skipping STL "${name}": ${err.message}`);
      changed = true;
    }
  }

  entries.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  return { entries, changed };
}

/* ------------------------------------------------------------------ multer */

const storage = multer.diskStorage({
  destination(req, file, cb) {
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    } catch (err) {
      cb(err);
    }
  },
  filename(req, file, cb) {
    try {
      cb(null, uniqueName(file.originalname));
    } catch (err) {
      cb(err);
    }
  }
});

const uploadSingle = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8 }
}).single("file");

function uploadErrorMessage(err) {
  switch (err.code) {
    case "LIMIT_FILE_SIZE":
      return { status: 413, message: "The file is larger than 250 MB." };
    case "LIMIT_FILE_COUNT":
    case "LIMIT_UNEXPECTED_FILE":
      return { status: 400, message: 'Exactly one file is expected in the "file" field.' };
    default:
      return { status: 400, message: `Upload failed: ${err.message}` };
  }
}

async function removeQuietly(absPath) {
  if (!absPath) return;
  try {
    await fsp.unlink(absPath);
  } catch {
    // already gone — nothing to clean up
  }
}

/* ------------------------------------------------------------------ routes */

export function register(router, ctx) {
  const log = (...args) => ctx?.log?.(...args);

  const initial = rebuildIndex(log);
  let entries = initial.entries;
  if (initial.changed || !fs.existsSync(INDEX_FILE)) writeIndexFile(entries, log);

  const persist = () => writeIndexFile(entries, log);
  const findEntry = (id) => entries.find((e) => e.id === id) || null;

  router.get("/stl", (req, res) => {
    res.json(entries);
  });

  router.post("/stl", (req, res, next) => {
    uploadSingle(req, res, (err) => {
      if (err) {
        const { status, message } = uploadErrorMessage(err);
        removeQuietly(req.file?.path).then(() => res.status(status).json({ error: message }));
        return;
      }
      handleUpload(req, res).catch(next);
    });
  });

  async function handleUpload(req, res) {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No file was sent in the "file" field.' });
      return;
    }

    let info;
    try {
      const buffer = await fsp.readFile(file.path);
      info = parseStl(buffer);
    } catch (err) {
      await removeQuietly(file.path);
      const message = err.publicMessage || "The file could not be read as an STL.";
      log(`Upload rejected (${file.originalname}): ${err.message}`);
      res.status(400).json({ error: message });
      return;
    }

    let sizeBytes = file.size;
    try {
      sizeBytes = (await fsp.stat(file.path)).size;
    } catch {
      // keep multer's byte count
    }

    const entry = makeEntry(file.filename, sizeBytes, info, new Date().toISOString(), sanitizeName(file.originalname));
    entries = [entry, ...entries.filter((e) => e.id !== entry.id)];
    persist();
    log(`STL uploaded: ${entry.file} (${entry.triangles} triangles, ${entry.format})`);
    res.status(201).json(entry);
  }

  router.delete("/stl/:id", async (req, res, next) => {
    try {
      const entry = findEntry(req.params.id);
      if (!entry) {
        res.status(404).json({ error: "This STL file is not known." });
        return;
      }
      const abs = safeJoin(DATA_DIR, entry.file);
      if (abs) await removeQuietly(abs);
      entries = entries.filter((e) => e.id !== entry.id);
      persist();
      res.json({ ok: true, id: entry.id });
    } catch (err) {
      next(err);
    }
  });

  router.get("/stl/:id/raw", (req, res, next) => {
    const entry = findEntry(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "This STL file is not known." });
      return;
    }
    const abs = safeJoin(DATA_DIR, entry.file);
    if (!abs || !fs.existsSync(abs)) {
      res.status(404).json({ error: "The file is no longer in the upload directory." });
      return;
    }
    res.sendFile(abs, { headers: { "Content-Type": "application/octet-stream" } }, (err) => {
      if (!err) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      next(err);
    });
  });
}

export default { register };
