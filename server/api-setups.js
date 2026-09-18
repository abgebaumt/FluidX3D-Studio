/**
 * Setup storage: list, read, write and delete configs under data/setups.
 *
 * One file per setup, named after the setup itself, so the directory stays
 * readable from the outside. Names are restricted to [A-Za-z0-9_-]{1,64},
 * which makes them safe as file names without any further path juggling.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { SETUP_DIR } from "./paths.js";
import { defaultConfig, validate, SETUP_NAME_RE } from "./schema.js";

const EXAMPLE_NAME = "wind_tunnel_example";

export function register(router, ctx) {
  seedExample(ctx);

  router.get("/setups", wrap(async (req, res) => {
    res.json(await listSetups());
  }));

  router.get("/setups/:name", wrap(async (req, res) => {
    const name = requireName(req.params.name);
    const file = setupFile(name);

    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") throw httpError(404, `Setup "${name}" does not exist.`);
      throw httpError(500, `Setup "${name}" could not be read: ${err.message}`);
    }

    try {
      res.json(JSON.parse(text));
    } catch {
      throw httpError(500, `Setup "${name}" is corrupt and does not contain valid JSON.`);
    }
  }));

  router.put("/setups/:name", wrap(async (req, res) => {
    const name = requireName(req.params.name);
    if (!isObject(req.body)) {
      throw httpError(400, "The request body must be a configuration as a JSON object.");
    }

    // The name in the URL wins, so a config saved under a new name is renamed.
    const { ok, errors, value } = validate({ ...req.body, name });
    if (!ok) {
      // Answered here rather than thrown, so the client gets every message
      // instead of just the first one the central error handler would show.
      return res.status(400).json({ error: `Invalid configuration: ${errors[0]}`, errors });
    }

    await writeSetup(name, value);
    const savedAt = await savedAtOf(name);
    ctx.log(`Setup saved: ${name}`);
    res.json({ name, savedAt, config: value });
  }));

  router.delete("/setups/:name", wrap(async (req, res) => {
    const name = requireName(req.params.name);
    try {
      await fsp.unlink(setupFile(name));
    } catch (err) {
      if (err.code === "ENOENT") throw httpError(404, `Setup "${name}" does not exist.`);
      throw httpError(500, `Setup "${name}" could not be deleted: ${err.message}`);
    }
    ctx.log(`Setup deleted: ${name}`);
    res.json({ ok: true, name });
  }));
}

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

async function listSetups() {
  let entries;
  try {
    entries = await fsp.readdir(SETUP_DIR, { withFileTypes: true });
  } catch {
    return []; // a missing directory simply means "no setups yet"
  }

  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const name = entry.name.slice(0, -5);
    if (!SETUP_NAME_RE.test(name)) continue;
    out.push({ name, savedAt: await savedAtOf(name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "de"));
}

async function savedAtOf(name) {
  try {
    const stat = await fsp.stat(setupFile(name));
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

/** Writes via a temporary file so a crash mid-write cannot truncate a setup. */
async function writeSetup(name, config) {
  const target = setupFile(name);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fsp.mkdir(SETUP_DIR, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw httpError(500, `Setup "${name}" could not be saved: ${err.message}`);
  }
}

/** On the very first start an example setup makes the editor usable at once. */
function seedExample(ctx) {
  try {
    fs.mkdirSync(SETUP_DIR, { recursive: true });
    const hasAny = fs.readdirSync(SETUP_DIR).some((f) => f.endsWith(".json"));
    if (hasAny) return;
    const config = defaultConfig(EXAMPLE_NAME);
    fs.writeFileSync(setupFile(EXAMPLE_NAME), JSON.stringify(config, null, 2) + "\n", "utf8");
    ctx.log(`Example setup created: ${EXAMPLE_NAME}`);
  } catch (err) {
    // Not being able to seed must never keep the server from starting.
    ctx.log(`Example setup could not be created: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function setupFile(name) {
  return path.join(SETUP_DIR, `${name}.json`);
}

function requireName(raw) {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!SETUP_NAME_RE.test(name)) {
    throw httpError(
      400,
      "Invalid setup name. Use 1 to 64 characters: letters, digits, underscore and hyphen."
    );
  }
  return name;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Express 4 does not catch rejected promises from handlers. */
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
