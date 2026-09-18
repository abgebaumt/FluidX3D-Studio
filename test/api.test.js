/**
 * End-to-end tests for the FluidX3D Studio backend.
 *
 * The server under test is started as a child process inside a throw-away
 * sandbox: a temporary root directory that carries its own copy of `server/`,
 * its own `studio.config.json` and its own `data/` tree. The user's real
 * setups, uploads and build state are never read or written by these tests.
 *
 * `node_modules` is linked, not copied, and the link is removed explicitly
 * before the sandbox is deleted so that nothing outside the temp directory can
 * ever be touched.
 *
 * No test starts a simulation: POST /api/run is deliberately never called.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderDefines, writeBuiltState } from "../server/defines.js";
import { defaultConfig } from "../server/schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const EXE_NAME = process.platform === "win32" ? "FluidX3D.exe" : "FluidX3D";

/* ================================================================= sandbox */

/** Everything the running server owns during the test, filled in by before(). */
const sandbox = {
  root: null,
  dataDir: null,
  uploadDir: null,
  setupDir: null,
  generatedDir: null,
  fxRoot: null,
  base: "",
  child: null,
  log: ""
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Builds the sandbox: a copy of server/, a linked node_modules, a stub
 * FluidX3D checkout (so that /api/health and /api/preview see an installation
 * that is present and built) and a fresh studio.config.json.
 */
function createSandbox() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fx3d-studio-test-"));

  fs.cpSync(path.join(REPO, "server"), path.join(root, "server"), { recursive: true });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"), "junction");

  // A stub checkout is enough: the tests never build and never launch anything.
  const fxRoot = path.join(root, "fluidx3d");
  fs.mkdirSync(path.join(fxRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(fxRoot, "bin"), { recursive: true });
  fs.writeFileSync(path.join(fxRoot, "src", "lbm.hpp"), "// stub\n", "utf8");
  fs.writeFileSync(path.join(fxRoot, "src", "defines.hpp"), "// stub\n", "utf8");
  fs.writeFileSync(path.join(fxRoot, "src", "setup_config.cpp"), "// stub\n", "utf8");
  fs.writeFileSync(path.join(fxRoot, "bin", EXE_NAME), "stub", "utf8");

  fs.writeFileSync(
    path.join(root, "studio.config.json"),
    JSON.stringify({
      fluidx3dPath: "./fluidx3d",
      port: 0,
      gpu: { name: "Test card", vramMB: 24576, bandwidthGBs: 936 }
    }, null, 2),
    "utf8"
  );
  // paths.js falls back to the example file; keep one around for completeness.
  fs.copyFileSync(path.join(REPO, "studio.config.example.json"), path.join(root, "studio.config.example.json"));

  sandbox.root = root;
  sandbox.fxRoot = fxRoot;
  sandbox.dataDir = path.join(root, "data");
  sandbox.uploadDir = path.join(sandbox.dataDir, "uploads");
  sandbox.setupDir = path.join(sandbox.dataDir, "setups");
  sandbox.generatedDir = path.join(sandbox.dataDir, "generated");
  return root;
}

function removeSandbox() {
  const root = sandbox.root;
  if (!root) return;
  // Belt and braces: never delete anything outside the temp directory.
  assert.ok(root.startsWith(fs.realpathSync(os.tmpdir())), "Sandbox is not inside the temp directory");

  const link = path.join(root, "node_modules");
  try {
    fs.unlinkSync(link);
  } catch {
    try {
      fs.rmdirSync(link);
    } catch {
      /* already gone */
    }
  }
  assert.ok(!fs.existsSync(link), "Could not remove the node_modules link");
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  sandbox.root = null;
}

async function startServer() {
  const port = await freePort();
  sandbox.base = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [path.join(sandbox.root, "server", "index.js")], {
    cwd: sandbox.root,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  sandbox.child = child;

  let exited = false;
  child.on("exit", (code) => {
    exited = true;
    sandbox.log += `\n[Server exited with code ${code}]`;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      sandbox.log += chunk;
    });
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited) throw new Error(`The test server did not start:\n${sandbox.log}`);
    try {
      const res = await fetch(`${sandbox.base}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The test server does not respond:\n${sandbox.log}`);
}

async function stopServer() {
  const child = sandbox.child;
  if (!child || child.exitCode !== null) return;
  const ended = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  await ended;
  clearTimeout(timer);
  sandbox.child = null;
}

/* ============================================================ http helpers */

async function call(method, route, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(sandbox.base + route, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — the caller inspects `text` */
  }
  return { status: res.status, json, text, headers: res.headers };
}

const getJson = (route) => call("GET", route);
const putJson = (route, body) => call("PUT", route, body);
const postJson = (route, body) => call("POST", route, body);
const del = (route) => call("DELETE", route);

async function uploadStl(buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/octet-stream" }), filename);
  const res = await fetch(`${sandbox.base}/api/stl`, { method: "POST", body: form });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

/** File names currently sitting in the sandbox upload directory. */
function uploadFiles() {
  try {
    return fs.readdirSync(sandbox.uploadDir).sort();
  } catch {
    return [];
  }
}

/* ============================================================= STL fixtures */

/** Vertices chosen so every coordinate is exact in FP32 and in FP64. */
const BINARY_TRIANGLES = [
  [[-2.5, -1, 0], [3, 0, 0], [0, 4.5, 0]],
  [[0, 0, 7], [1.25, 2, 3], [-1, 4.5, 6]],
  [[2, -1, 1], [3, 1.5, 2], [-2.5, 0, 7]]
];

const ASCII_TRIANGLES = [
  [[-1, -2, -3], [4, 0, 0], [0, 5, 0]],
  [[0, 0, 6], [1, 1, 1], [2, 2, 2]]
];

/** Bounding box straight from the vertex list — a second, independent path. */
function boxOf(triangles) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const tri of triangles) {
    for (const v of tri) {
      for (let i = 0; i < 3; i++) {
        if (v[i] < min[i]) min[i] = v[i];
        if (v[i] > max[i]) max[i] = v[i];
      }
    }
  }
  return { min, max };
}

function binaryStl(triangles, { announce = triangles.length, header = "FluidX3D Studio test file" } = {}) {
  const buffer = Buffer.alloc(84 + 50 * triangles.length);
  buffer.write(header, 0, 80, "latin1");
  buffer.writeUInt32LE(announce, 80);
  triangles.forEach((tri, t) => {
    let off = 84 + t * 50 + 12; // skip the normal
    for (const v of tri) {
      buffer.writeFloatLE(v[0], off);
      buffer.writeFloatLE(v[1], off + 4);
      buffer.writeFloatLE(v[2], off + 8);
      off += 12;
    }
  });
  return buffer;
}

function asciiStl(triangles, name = "test_body") {
  const lines = [`solid ${name}`];
  for (const tri of triangles) {
    lines.push("  facet normal 0.0 0.0 1.0", "    outer loop");
    for (const v of tri) lines.push(`      vertex ${v[0].toFixed(6)} ${v[1].toFixed(6)} ${v[2].toFixed(6)}`);
    lines.push("    endloop", "  endfacet");
  }
  lines.push(`endsolid ${name}`, "");
  return Buffer.from(lines.join("\n"), "latin1");
}

/* ========================================================== defines helpers */

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** Pretends the binary was built from `cfg`, exactly as a finished run would. */
function markAsBuilt(cfg) {
  writeBuiltState(cfg, sandbox.generatedDir, { definesSha: sha1(renderDefines(cfg)), seconds: 1 });
}

/** Deep clone plus in-place edit, so no test can disturb another one's config. */
function tweak(cfg, edit) {
  const copy = structuredClone(cfg);
  edit(copy);
  return copy;
}

/**
 * The part of defines.hpp above the fixed section. Only there is a `#define`
 * a statement about the configuration; below the `// ####` separator the file
 * derives further defines inside #ifdef blocks.
 */
function configurableHead(text) {
  const cut = text.indexOf("// ####");
  return cut < 0 ? text : text.slice(0, cut);
}

/** Names of all switches the editor controls, active or not. */
const CONTROLLED = [
  "D2Q9", "D3Q15", "D3Q19", "D3Q27",
  "FP16S", "FP16C",
  "SRT", "TRT",
  "VOLUME_FORCE", "FORCE_FIELD", "EQUILIBRIUM_BOUNDARIES", "MOVING_BOUNDARIES",
  "SURFACE", "TEMPERATURE", "SUBGRID", "PARTICLES",
  "GUI_CONFIG_SETUP",
  "INTERACTIVE_GRAPHICS", "INTERACTIVE_GRAPHICS_ASCII", "GRAPHICS"
];

/** The controlled switches that are actually enabled in `text`. */
function activeSwitches(text) {
  const head = configurableHead(text);
  const active = new Set();
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("#define ")) continue;
    const name = line.slice(8).replace(/\/\/.*$/, "").trim().split(/\s+/)[0];
    if (CONTROLLED.includes(name)) active.add(name);
  }
  return active;
}

/** Value of an active `#define NAME value`, or null when it is not defined. */
function defineValue(text, name) {
  for (const raw of configurableHead(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("#define ")) continue;
    const body = line.slice(8).replace(/\/\/.*$/, "").trim();
    const gap = body.indexOf(" ");
    const key = gap < 0 ? body : body.slice(0, gap);
    if (key === name) return gap < 0 ? "" : body.slice(gap + 1).trim();
  }
  return null;
}

/** Every controlled switch that is present but commented out. */
function commentedSwitches(text) {
  const commented = new Set();
  for (const raw of configurableHead(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("//#define ") && !line.startsWith("// #define ")) continue;
    const body = line.replace(/^\/\/\s*#define\s+/, "");
    const name = body.replace(/\/\/.*$/, "").trim().split(/\s+/)[0];
    if (CONTROLLED.includes(name)) commented.add(name);
  }
  return commented;
}

/* ================================================================= configs */

/** The default wind tunnel case, used as the baseline everywhere below. */
function baseConfig(name = "test_base") {
  const cfg = defaultConfig(name);
  cfg.reference = { length_m: 25.5, source: "manual" };
  return cfg;
}

/* =================================================================== setup */

before(async () => {
  createSandbox();
  await startServer();
});

after(async () => {
  await stopServer();
  removeSandbox();
});

/* ============================================================ /api/health */

describe("GET /api/health", () => {
  it("returns the contract fields", async () => {
    const { status, json } = await getJson("/api/health");
    assert.equal(status, 200);
    for (const field of ["ok", "fluidx3dPath", "fluidx3dFound", "hasMsbuild", "exeExists", "gpu", "node"]) {
      assert.ok(field in json, `Field "${field}" is missing from /api/health`);
    }
    assert.equal(json.ok, true);
    assert.equal(json.fluidx3dFound, true);
    assert.equal(json.exeExists, true);
    assert.equal(json.node, process.version);
    assert.equal(typeof json.hasMsbuild, "boolean");
    assert.equal(path.resolve(json.fluidx3dPath), path.resolve(sandbox.fxRoot));
    assert.equal(json.gpu.vramMB, 24576);
    assert.equal(json.gpu.bandwidthGBs, 936);
  });

  it("reports a missing FluidX3D installation instead of failing", async () => {
    const configFile = path.join(sandbox.root, "studio.config.json");
    const original = fs.readFileSync(configFile, "utf8");
    // refreshFx() re-resolves on every call, so no restart is needed.
    fs.writeFileSync(configFile, JSON.stringify({ ...JSON.parse(original), fluidx3dPath: "./does-not-exist" }), "utf8");
    try {
      // The running server keeps its loaded config; this only proves that a
      // health call never throws when the checkout is gone.
      const { status, json } = await getJson("/api/health");
      assert.equal(status, 200);
      assert.equal(json.ok, true);
    } finally {
      fs.writeFileSync(configFile, original, "utf8");
    }
  });

  it("answers unknown endpoints with 404 and a readable message", async () => {
    const { status, json } = await getJson("/api/does-not-exist");
    assert.equal(status, 404);
    assert.equal(typeof json.error, "string");
    assert.match(json.error, /Unknown endpoint/);
  });
});

/* =============================================================== /api/stl */

describe("STL management", () => {
  it("accepts a binary STL and reads triangle count and bounding box correctly", async () => {
    const { status, json } = await uploadStl(binaryStl(BINARY_TRIANGLES), "cube.stl");
    assert.equal(status, 201, `Upload fehlgeschlagen: ${JSON.stringify(json)}`);

    assert.equal(json.triangles, BINARY_TRIANGLES.length);
    assert.equal(json.format, "binary");
    assert.deepEqual(json.bbox, boxOf(BINARY_TRIANGLES));
    assert.equal(json.file, `uploads/${json.id}`);
    assert.equal(json.sizeBytes, 84 + 50 * BINARY_TRIANGLES.length);
    assert.ok(json.name.endsWith(".stl"));
    assert.ok(!Number.isNaN(Date.parse(json.uploadedAt)));
    assert.ok(fs.existsSync(path.join(sandbox.uploadDir, json.id)));

    await del(`/api/stl/${encodeURIComponent(json.id)}`);
  });

  it("accepts an ASCII STL and reads triangle count and bounding box correctly", async () => {
    const { status, json } = await uploadStl(asciiStl(ASCII_TRIANGLES), "ascii_body.stl");
    assert.equal(status, 201, `Upload fehlgeschlagen: ${JSON.stringify(json)}`);

    assert.equal(json.triangles, ASCII_TRIANGLES.length);
    assert.equal(json.format, "ascii");
    assert.deepEqual(json.bbox, boxOf(ASCII_TRIANGLES));

    await del(`/api/stl/${encodeURIComponent(json.id)}`);
  });

  it("lists, serves raw and deletes again", async () => {
    const bytes = binaryStl(BINARY_TRIANGLES);
    const { json: entry } = await uploadStl(bytes, "list.stl");

    const list = await getJson("/api/stl");
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json));
    const listed = list.json.find((e) => e.id === entry.id);
    assert.ok(listed, "The uploaded file does not appear in the list");
    assert.deepEqual(listed, entry);

    const raw = await fetch(`${sandbox.base}/api/stl/${encodeURIComponent(entry.id)}/raw`);
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get("content-type") || "", /application\/octet-stream/);
    const received = Buffer.from(await raw.arrayBuffer());
    assert.equal(received.length, bytes.length);
    assert.ok(received.equals(bytes), "The raw bytes served differ");

    const removed = await del(`/api/stl/${encodeURIComponent(entry.id)}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.ok, true);

    assert.ok(!fs.existsSync(path.join(sandbox.uploadDir, entry.id)), "The file is still there after deletion");
    const after = await getJson("/api/stl");
    assert.ok(!after.json.some((e) => e.id === entry.id));

    const gone = await getJson(`/api/stl/${encodeURIComponent(entry.id)}/raw`);
    assert.equal(gone.status, 404);
    assert.match(gone.json.error, /not known/);
  });

  it("rejects a broken file with 400 and does not store it", async () => {
    const before = uploadFiles();
    const junk = Buffer.from("This is most certainly not an STL file, just plain text.", "latin1");
    const { status, json } = await uploadStl(junk, "broken.stl");

    assert.equal(status, 400);
    assert.equal(typeof json.error, "string");
    assert.match(json.error, /STL/i);
    assert.deepEqual(uploadFiles(), before, "The rejected file was left in the upload directory");

    const list = await getJson("/api/stl");
    assert.ok(!list.json.some((e) => /broken/.test(e.name)));
  });

  it("rejects a binary STL that is shorter than its declared triangle count", async () => {
    const before = uploadFiles();
    const truncated = binaryStl(BINARY_TRIANGLES, { announce: 5000 });
    const { status, json } = await uploadStl(truncated, "incomplete.stl");

    assert.equal(status, 400);
    assert.match(json.error, /incomplete|not be read as/i);
    assert.deepEqual(uploadFiles(), before);
  });

  it("rejects an empty request without a file", async () => {
    const res = await fetch(`${sandbox.base}/api/stl`, { method: "POST", body: new FormData() });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /No file/);
  });

  it("rejects an STL without triangles", async () => {
    const before = uploadFiles();
    const { status, json } = await uploadStl(binaryStl([]), "empty.stl");
    assert.equal(status, 400);
    assert.match(json.error, /no triangles|too small/);
    assert.deepEqual(uploadFiles(), before);
  });

  it("keeps two uploads with the same file name apart", async () => {
    const first = await uploadStl(binaryStl(BINARY_TRIANGLES), "same_name.stl");
    const second = await uploadStl(asciiStl(ASCII_TRIANGLES), "same_name.stl");
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.json.id, second.json.id);

    const list = await getJson("/api/stl");
    assert.equal(list.json.filter((e) => e.id === first.json.id || e.id === second.json.id).length, 2);
    assert.equal(list.json.find((e) => e.id === first.json.id).triangles, BINARY_TRIANGLES.length);
    assert.equal(list.json.find((e) => e.id === second.json.id).triangles, ASCII_TRIANGLES.length);

    await del(`/api/stl/${encodeURIComponent(first.json.id)}`);
    await del(`/api/stl/${encodeURIComponent(second.json.id)}`);
  });

  it('neither serves nor deletes "../../etc/passwd"', async () => {
    const evil = encodeURIComponent("../../etc/passwd");

    const raw = await getJson(`/api/stl/${evil}/raw`);
    assert.equal(raw.status, 404);
    assert.match(raw.json.error, /not known/);

    const removed = await del(`/api/stl/${evil}`);
    assert.equal(removed.status, 404);
    assert.match(removed.json.error, /not known/);
  });

  it("defuses a file name that points outside the upload directory", async () => {
    const { status, json } = await uploadStl(binaryStl(BINARY_TRIANGLES), "../../etc/passwd.stl");
    assert.equal(status, 201);

    assert.ok(!json.id.includes("/") && !json.id.includes("\\") && !json.id.includes(".."));
    assert.equal(json.file, `uploads/${json.id}`);
    const stored = path.resolve(sandbox.uploadDir, json.id);
    assert.ok(stored.startsWith(sandbox.uploadDir + path.sep), "The file ended up outside data/uploads");
    assert.ok(fs.existsSync(stored));

    await del(`/api/stl/${encodeURIComponent(json.id)}`);
  });
});

/* ============================================================ /api/setups */

describe("Setups", () => {
  it("saves and loads losslessly and is a fixed point", async () => {
    const upload = await uploadStl(binaryStl(BINARY_TRIANGLES), "fixed_point.stl");
    assert.equal(upload.status, 201);

    const cfg = baseConfig("fixed_point_test");
    cfg.objects = [{
      id: "obj-1",
      name: "Fuselage",
      type: "stl",
      file: upload.json.file,
      enabled: true,
      visible: true,
      sizing: { mode: "longest_edge_m", value: 25.5 },
      position_frac: [0.5, 0.4, 0.5],
      rotation_deg: { pitch: -4, yaw: 0, roll: 0 },
      motion: { type: "none", axis: [0, 1, 0], rpm: 0, revoxelize_interval: 4 }
    }];
    cfg.reference = { length_m: 25.5, source: "object:obj-1" };

    const first = await putJson("/api/setups/fixed_point_test", cfg);
    assert.equal(first.status, 200, `Saving failed: ${first.text}`);
    assert.equal(first.json.name, "fixed_point_test");
    assert.ok(!Number.isNaN(Date.parse(first.json.savedAt)));

    const loaded = await getJson("/api/setups/fixed_point_test");
    assert.equal(loaded.status, 200);
    assert.deepEqual(loaded.json, first.json.config, "The loaded setup differs from the save response");

    const second = await putJson("/api/setups/fixed_point_test", loaded.json);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.config, loaded.json, "Saving twice changes the configuration");

    const reloaded = await getJson("/api/setups/fixed_point_test");
    assert.deepEqual(reloaded.json, loaded.json);

    const list = await getJson("/api/setups");
    assert.ok(list.json.some((e) => e.name === "fixed_point_test" && typeof e.savedAt === "string"));

    assert.equal((await del("/api/setups/fixed_point_test")).status, 200);
    assert.equal((await getJson("/api/setups/fixed_point_test")).status, 404);
    await del(`/api/stl/${encodeURIComponent(upload.json.id)}`);
  });

  it("writes the name from the URL into the configuration", async () => {
    const saved = await putJson("/api/setups/renamed", baseConfig("something_else"));
    assert.equal(saved.status, 200);
    assert.equal(saved.json.config.name, "renamed");
    assert.equal(saved.json.config.schema, 1);
    await del("/api/setups/renamed");
  });

  it("rejects invalid names", async () => {
    for (const name of ["with space", "with/slash", "dot.name", "\u00fc_umlaut", "a".repeat(65)]) {
      const res = await putJson(`/api/setups/${encodeURIComponent(name)}`, baseConfig("whatever"));
      assert.equal(res.status, 400, `Name "${name}" was accepted`);
      assert.match(res.json.error, /Invalid setup name/);
    }
    assert.ok(!uploadFiles().some((f) => f.includes("passwd")));
  });

  it('rejects "../../etc/passwd" as a setup name', async () => {
    const evil = encodeURIComponent("../../etc/passwd");
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await call(method, `/api/setups/${evil}`, method === "PUT" ? baseConfig("whatever") : undefined);
      assert.equal(res.status, 400, `${method} with a path attack was not rejected`);
      assert.match(res.json.error, /Invalid setup name\. Use 1 to 64 characters/);
    }
    assert.ok(!fs.existsSync(path.join(sandbox.dataDir, "..", "etc")));
  });

  it("rejects an object path that points outside data/", async () => {
    const cfg = tweak(baseConfig("path_attack"), (c) => {
      c.objects = [{ id: "obj-1", name: "Evil", type: "stl", file: "../../etc/passwd" }];
    });
    const res = await putJson("/api/setups/path_attack", cfg);
    assert.equal(res.status, 400);
    assert.ok(res.json.errors.some((e) => /points outside the data folder/.test(e)), res.text);
    assert.equal((await getJson("/api/setups/path_attack")).status, 404);
  });

  it("rejects a rotating object without MOVING_BOUNDARIES with 400", async () => {
    const cfg = tweak(baseConfig("rotor_test"), (c) => {
      c.objects = [{
        id: "obj-1",
        name: "Propeller",
        type: "stl",
        file: "uploads/propeller.stl",
        enabled: true,
        visible: true,
        sizing: { mode: "longest_edge_m", value: 2.0 },
        position_frac: [0.5, 0.3, 0.5],
        rotation_deg: { pitch: 0, yaw: 0, roll: 0 },
        motion: { type: "rotate", axis: [0, 1, 0], rpm: 2400, revoxelize_interval: 4 }
      }];
      c.solver.extensions = ["EQUILIBRIUM_BOUNDARIES", "SUBGRID"];
    });

    const res = await putJson("/api/setups/rotor_test", cfg);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Invalid configuration/);
    const hit = res.json.errors.find((e) => e.includes("MOVING_BOUNDARIES"));
    assert.ok(hit, `No message about MOVING_BOUNDARIES: ${res.text}`);
    assert.match(hit, /Propeller/);
    assert.match(hit, /"Propeller" rotates \(motion\.type = "rotate"\)/);
    assert.equal((await getJson("/api/setups/rotor_test")).status, 404, "The invalid setup was stored anyway");

    // With MOVING_BOUNDARIES the same configuration passes.
    const fixed = tweak(cfg, (c) => {
      c.solver.extensions = ["MOVING_BOUNDARIES", "EQUILIBRIUM_BOUNDARIES", "SUBGRID"];
    });
    const ok = await putJson("/api/setups/rotor_test", fixed);
    assert.equal(ok.status, 200, ok.text);
    await del("/api/setups/rotor_test");
  });

  it("rejects PARTICLES without VOLUME_FORCE and FORCE_FIELD with 400", async () => {
    const cfg = tweak(baseConfig("particles_test"), (c) => {
      c.solver.extensions = ["SUBGRID", "PARTICLES"];
    });
    const res = await putJson("/api/setups/particles_test", cfg);
    assert.equal(res.status, 400);
    const hit = res.json.errors.find((e) => e.includes("PARTICLES"));
    assert.ok(hit, res.text);
    assert.match(hit, /VOLUME_FORCE/);
    assert.match(hit, /FORCE_FIELD/);

    const fixed = tweak(cfg, (c) => {
      c.solver.extensions = ["VOLUME_FORCE", "FORCE_FIELD", "SUBGRID", "PARTICLES"];
    });
    const ok = await putJson("/api/setups/particles_test", fixed);
    assert.equal(ok.status, 200, ok.text);
    await del("/api/setups/particles_test");
  });

  it("reports nonsensical values instead of accepting them", async () => {
    const cfg = tweak(baseConfig("values_test"), (c) => {
      c.solver.velocity_set = 13;
      c.solver.precision = "FP8";
      c.fluid.u_lbm = 5;
      c.boundaries.xmin = "periodic";
    });
    const res = await putJson("/api/setups/values_test", cfg);
    assert.equal(res.status, 400);
    assert.ok(res.json.errors.length >= 4, res.text);
    assert.ok(res.json.errors.some((e) => e.startsWith("solver.velocity_set")));
    assert.ok(res.json.errors.some((e) => e.startsWith("solver.precision")));
    assert.ok(res.json.errors.some((e) => e.startsWith("fluid.u_lbm")));
    assert.ok(res.json.errors.some((e) => /periodic/.test(e)));
  });

  it("reports a request body that is not a configuration", async () => {
    const res = await putJson("/api/setups/empty_test", [1, 2, 3]);
    assert.equal(res.status, 400);
    assert.match(res.json.error, /JSON object/);
    assert.equal((await getJson("/api/setups/empty_test")).status, 404);
  });

  it("reports a corrupt setup file instead of serving it as a configuration", async () => {
    const file = path.join(sandbox.setupDir, "corrupt.json");
    fs.writeFileSync(file, "{ this is not JSON", "utf8");
    try {
      const res = await getJson("/api/setups/corrupt");
      assert.equal(res.status, 500);
      assert.match(res.json.error, /is corrupt/);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("reports malformed JSON with a readable message", async () => {
    const res = await fetch(`${sandbox.base}/api/setups/malformed_test`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not JSON"
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /The request body is not valid JSON\./);
  });
});

/* =========================================================== /api/preview */

describe("POST /api/preview — needsRebuild", () => {
  /** Every field that must NOT provoke a rebuild, with an edit that changes it. */
  const harmless = {
    "domain.size_m": (c) => { c.domain.size_m = [40, 80, 20]; },
    "domain.target_vram_mb": (c) => { c.domain.target_vram_mb = 4000; },
    "fluid.velocity_ms": (c) => { c.fluid.velocity_ms = 55; },
    "fluid.azimuth_deg": (c) => { c.fluid.azimuth_deg = 12.5; },
    "fluid.elevation_deg": (c) => { c.fluid.elevation_deg = -3; },
    "fluid.u_lbm": (c) => { c.fluid.u_lbm = 0.12; },
    "fluid.viscosity_m2s": (c) => { c.fluid.viscosity_m2s = 1e-6; },
    "boundaries": (c) => { c.boundaries.zmin = "solid"; },
    "reference": (c) => { c.reference = { length_m: 9.63, source: "manual" }; },
    "objects": (c) => {
      c.objects = [{
        id: "obj-1", name: "Fuselage", type: "stl", file: "uploads/fuselage.stl",
        enabled: true, visible: true,
        sizing: { mode: "longest_edge_m", value: 25.5 },
        position_frac: [0.5, 0.4, 0.5],
        rotation_deg: { pitch: -4, yaw: 0, roll: 0 },
        motion: { type: "none", axis: [0, 1, 0], rpm: 0, revoxelize_interval: 4 }
      }];
    },
    "name": (c) => { c.name = "completely_different_name"; },
    "run.duration_s": (c) => { c.run.duration_s = 30; },
    "run.fps": (c) => { c.run.fps = 24; },
    "run.camera": (c) => { c.run.camera.distance = 12; c.run.camera.zoom = 2.4; }
  };

  /** Every field that MUST provoke a rebuild, with the expected explanation. */
  const rebuilding = {
    "solver.velocity_set": [(c) => { c.solver.velocity_set = 27; }, /D3Q19 → D3Q27/],
    "solver.precision": [(c) => { c.solver.precision = "FP32"; }, /precision FP16S → FP32/],
    "extension added": [(c) => { c.solver.extensions = [...c.solver.extensions, "MOVING_BOUNDARIES"]; }, /MOVING_BOUNDARIES added/],
    "extension removed": [(c) => { c.solver.extensions = c.solver.extensions.filter((e) => e !== "SUBGRID"); }, /SUBGRID removed/],
    "collision operator TRT": [(c) => { c.solver.extensions = [...c.solver.extensions, "TRT"]; }, /TRT added/],
    "run.mode": [(c) => { c.run.mode = "render"; }, /run mode interactive → render/]
  };

  before(() => {
    markAsBuilt(baseConfig());
  });

  it("reports no rebuild for exactly the configuration that was built", async () => {
    const { status, json } = await postJson("/api/preview", baseConfig());
    assert.equal(status, 200);
    assert.equal(json.needsRebuild, false, json.reason);
    assert.equal(json.currentHash, json.targetHash);
    assert.match(json.reason, /matches the configuration/);
    assert.ok(json.defines.includes("#define GUI_CONFIG_SETUP"));
  });

  for (const [label, edit] of Object.entries(harmless)) {
    it(`needs no rebuild when only ${label} changes`, async () => {
      const cfg = tweak(baseConfig(), edit);
      const { status, json } = await postJson("/api/preview", cfg);
      assert.equal(status, 200);
      assert.equal(json.needsRebuild, false, `${label} triggered a rebuild: ${json.reason}`);
      assert.equal(json.currentHash, json.targetHash);
    });
  }

  for (const [label, [edit, reason]] of Object.entries(rebuilding)) {
    it(`needs a rebuild when ${label} changes`, async () => {
      const cfg = tweak(baseConfig(), edit);
      const { status, json } = await postJson("/api/preview", cfg);
      assert.equal(status, 200);
      assert.equal(json.needsRebuild, true, `${label} did not trigger a rebuild`);
      assert.notEqual(json.currentHash, json.targetHash);
      assert.match(json.reason, /Rebuild needed/);
      assert.match(json.reason, reason);
    });
  }

  it("ignores order and case of the extensions", async () => {
    const cfg = tweak(baseConfig(), (c) => {
      c.solver.extensions = ["subgrid", "Equilibrium_Boundaries"];
    });
    const { status, json } = await postJson("/api/preview", cfg);
    assert.equal(status, 200);
    assert.equal(json.needsRebuild, false, json.reason);
  });

  it("combines all four rebuild triggers and names each one", async () => {
    const cfg = tweak(baseConfig(), (c) => {
      c.solver.velocity_set = 15;
      c.solver.precision = "FP16C";
      c.solver.extensions = ["VOLUME_FORCE"];
      c.run.mode = "render";
    });
    const { json } = await postJson("/api/preview", cfg);
    assert.equal(json.needsRebuild, true);
    for (const part of [/D3Q19 → D3Q15/, /FP16S → FP16C/, /VOLUME_FORCE added/,
      /EQUILIBRIUM_BOUNDARIES removed/, /SUBGRID removed/, /run mode interactive → render/]) {
      assert.match(json.reason, part);
    }
  });

  it("needs a rebuild while nothing has been built yet", async () => {
    const builtFile = path.join(sandbox.generatedDir, "built.json");
    const saved = fs.readFileSync(builtFile, "utf8");
    fs.rmSync(builtFile, { force: true });
    try {
      const { json } = await postJson("/api/preview", baseConfig());
      assert.equal(json.needsRebuild, true);
      assert.equal(json.currentHash, null);
      assert.match(json.reason, /No build yet/);
    } finally {
      fs.writeFileSync(builtFile, saved, "utf8");
    }
  });

  it("detects changed graphics values, which are compiled in as well", async () => {
    const cfg = tweak(baseConfig(), (c) => { c.visualization.u_max = 0.42; });
    const { json } = await postJson("/api/preview", cfg);
    assert.equal(json.needsRebuild, true);
    // Same build hash, different defines.hpp — the reason has to say so.
    assert.equal(json.currentHash, json.targetHash);
    assert.match(json.reason, /graphics values in defines\.hpp have changed/);
  });

  it("needs a rebuild when the compiled executable is missing", async () => {
    const exe = path.join(sandbox.fxRoot, "bin", EXE_NAME);
    const saved = fs.readFileSync(exe);
    fs.rmSync(exe, { force: true });
    try {
      const { json } = await postJson("/api/preview", baseConfig());
      assert.equal(json.needsRebuild, true);
      assert.match(json.reason, /compiled executable is missing/);
    } finally {
      fs.writeFileSync(exe, saved);
    }
    // and is content again once it is back
    const { json } = await postJson("/api/preview", baseConfig());
    assert.equal(json.needsRebuild, false, json.reason);
  });

  it("rejects an unusable configuration with 400", async () => {
    for (const [body, pattern] of [
      [{}, /domain size/],
      [{ domain: { size_m: [1, 2] } }, /domain size/],
      [{ domain: { size_m: [1, 2, 3] } }, /solver section/],
      [{ domain: { size_m: [1, 2, 3] }, solver: {} }, /run section/]
    ]) {
      const res = await postJson("/api/preview", body);
      assert.equal(res.status, 400);
      assert.match(res.json.error, pattern);
    }
  });

  it("writes nothing into the FluidX3D tree when previewing", async () => {
    const definesFile = path.join(sandbox.fxRoot, "src", "defines.hpp");
    const before = fs.readFileSync(definesFile, "utf8");
    await postJson("/api/preview", tweak(baseConfig(), (c) => { c.solver.precision = "FP32"; }));
    assert.equal(fs.readFileSync(definesFile, "utf8"), before);
  });
});

/* ========================================================== defines.hpp */

describe("Generated defines.hpp", () => {
  it("contains exactly the expected switches for the base configuration", async () => {
    const { json } = await postJson("/api/preview", baseConfig());
    const text = json.defines;

    assert.deepEqual(
      [...activeSwitches(text)].sort(),
      ["D3Q19", "EQUILIBRIUM_BOUNDARIES", "FP16S", "GUI_CONFIG_SETUP", "INTERACTIVE_GRAPHICS", "SRT", "SUBGRID"]
    );
    assert.deepEqual(
      [...commentedSwitches(text)].sort(),
      ["D2Q9", "D3Q15", "D3Q27", "FORCE_FIELD", "FP16C", "GRAPHICS", "INTERACTIVE_GRAPHICS_ASCII",
        "MOVING_BOUNDARIES", "PARTICLES", "SURFACE", "TEMPERATURE", "TRT", "VOLUME_FORCE"]
    );

    assert.equal(defineValue(text, "GRAPHICS_BACKGROUND_COLOR"), "0xCCE4FF");
    assert.equal(defineValue(text, "GRAPHICS_U_MAX"), "0.18f");
    assert.equal(defineValue(text, "GRAPHICS_Q_CRITERION"), "0.0008f");
    assert.ok(text.startsWith("#pragma once"));
    assert.ok(!text.includes("{{"), "Placeholders were left in the generated defines.hpp");
  });

  it("contains GUI_CONFIG_SETUP in every variant", async () => {
    const variants = [
      baseConfig(),
      tweak(baseConfig(), (c) => { c.run.mode = "render"; }),
      tweak(baseConfig(), (c) => { c.solver.precision = "FP32"; c.solver.velocity_set = 27; }),
      tweak(baseConfig(), (c) => { c.solver.extensions = []; })
    ];
    for (const cfg of variants) {
      const { json } = await postJson("/api/preview", cfg);
      assert.ok(activeSwitches(json.defines).has("GUI_CONFIG_SETUP"), "GUI_CONFIG_SETUP is missing");
    }
  });

  it("selects FP32 by deselecting both FP16 formats", async () => {
    const { json } = await postJson("/api/preview", tweak(baseConfig(), (c) => { c.solver.precision = "FP32"; }));
    const active = activeSwitches(json.defines);
    assert.ok(!active.has("FP16S"));
    assert.ok(!active.has("FP16C"));
    assert.deepEqual([...commentedSwitches(json.defines)].filter((n) => n.startsWith("FP16")).sort(), ["FP16C", "FP16S"]);
  });

  it("swaps INTERACTIVE_GRAPHICS for GRAPHICS in render mode", async () => {
    const { json } = await postJson("/api/preview", tweak(baseConfig(), (c) => { c.run.mode = "render"; }));
    const active = activeSwitches(json.defines);
    assert.ok(active.has("GRAPHICS"));
    assert.ok(!active.has("INTERACTIVE_GRAPHICS"));
    assert.ok(!active.has("INTERACTIVE_GRAPHICS_ASCII"));
  });

  it("turns every selected extension into an active line", async () => {
    const wanted = ["VOLUME_FORCE", "FORCE_FIELD", "MOVING_BOUNDARIES", "EQUILIBRIUM_BOUNDARIES",
      "SUBGRID", "SURFACE", "TEMPERATURE", "PARTICLES", "TRT"];
    const { json } = await postJson("/api/preview", tweak(baseConfig(), (c) => { c.solver.extensions = wanted; }));
    const active = activeSwitches(json.defines);
    for (const name of wanted) {
      assert.ok(active.has(name), `Extension ${name} is missing from defines.hpp`);
    }
    assert.ok(!active.has("SRT"), "SRT and TRT must not be active at the same time");
  });

  it("carries background color, u_max and Q-criterion into the graphics constants", async () => {
    const cfg = tweak(baseConfig(), (c) => {
      c.visualization.background = "#102030";
      c.visualization.u_max = 0.25;
      c.visualization.q_criterion = 1e-5;
    });
    const { json } = await postJson("/api/preview", cfg);
    assert.equal(defineValue(json.defines, "GRAPHICS_BACKGROUND_COLOR"), "0x102030");
    assert.equal(defineValue(json.defines, "GRAPHICS_U_MAX"), "0.25f");
    assert.equal(defineValue(json.defines, "GRAPHICS_Q_CRITERION"), "0.00001f");
  });

  it("selects the velocity set exactly once", async () => {
    for (const [set, name] of [[15, "D3Q15"], [19, "D3Q19"], [27, "D3Q27"]]) {
      const { json } = await postJson("/api/preview", tweak(baseConfig(), (c) => { c.solver.velocity_set = set; }));
      const active = [...activeSwitches(json.defines)].filter((n) => /^D[23]Q\d+$/.test(n));
      assert.deepEqual(active, [name]);
    }
  });
});

/* ================================================================== jobs */

describe("Jobs", () => {
  it("starts with no jobs and rejects an unknown job id", async () => {
    const list = await getJson("/api/jobs");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json, []);

    const stop = await postJson("/api/jobs/does-not-exist/stop");
    assert.equal(stop.status, 404);
    assert.match(stop.json.error, /Unknown job/);
  });
});

/* =============================================================== restart */

// Runs last: it restarts the server under test on a fresh port.
describe("Restart", () => {
  it("finds uploads and setups unchanged after a restart", async () => {
    const binary = await uploadStl(binaryStl(BINARY_TRIANGLES), "persistent_binary.stl");
    const ascii = await uploadStl(asciiStl(ASCII_TRIANGLES), "persistent_ascii.stl");
    assert.equal(binary.status, 201);
    assert.equal(ascii.status, 201);

    const cfg = baseConfig("persistent");
    assert.equal((await putJson("/api/setups/persistent", cfg)).status, 200);

    const stlBefore = (await getJson("/api/stl")).json;
    const setupBefore = (await getJson("/api/setups/persistent")).json;

    await stopServer();
    await startServer();

    assert.deepEqual((await getJson("/api/stl")).json, stlBefore, "The STL index did not survive the restart");
    assert.deepEqual((await getJson("/api/setups/persistent")).json, setupBefore);

    // A file that vanished while the server was down must drop out of the list.
    fs.rmSync(path.join(sandbox.uploadDir, ascii.json.id), { force: true });
    await stopServer();
    await startServer();

    const stlAfter = (await getJson("/api/stl")).json;
    assert.ok(!stlAfter.some((e) => e.id === ascii.json.id), "The deleted file is still in the index");
    assert.deepEqual(stlAfter.find((e) => e.id === binary.json.id), binary.json);

    await del(`/api/stl/${encodeURIComponent(binary.json.id)}`);
    await del("/api/setups/persistent");
  });
});
