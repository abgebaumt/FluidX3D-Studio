/**
 * FluidX3D Studio backend.
 *
 * Route modules are registered here and nowhere else. Each exports
 * `register(router, ctx)`, where ctx is the object assembled below.
 */
import express from "express";
import fs from "node:fs";
import path from "node:path";

import {
  ROOT, WEB_DIR, DATA_DIR, NODE_MODULES,
  ensureDirs, loadConfig, resolveFluidX3D
} from "./paths.js";

import { register as registerStl } from "./api-stl.js";
// The sealing endpoint belonged to the precompute design and is no longer
// wired up: the solver seals at startup on the grid of the run. api-seal.js
// and its two computation modules stay in the tree as a diagnostic reference.
import { register as registerSetups } from "./api-setups.js";
import { register as registerRun } from "./api-run.js";
import { hasMsbuild } from "./build.js";

ensureDirs();

const config = loadConfig();
const fx = resolveFluidX3D(config);

/** Shared context handed to every route module. */
const ctx = {
  config,
  fx,
  /** Re-resolves FluidX3D so a corrected path takes effect without a restart. */
  refreshFx() {
    Object.assign(ctx.fx, resolveFluidX3D(ctx.config));
    return ctx.fx;
  },
  log(...args) {
    console.log(new Date().toISOString().slice(11, 19), ...args);
  }
};

const app = express();
app.use(express.json({ limit: "8mb" }));

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const api = express.Router();

api.get("/health", (req, res) => {
  ctx.refreshFx();
  res.json({
    ok: true,
    node: process.version,
    platform: process.platform,
    fluidx3dPath: ctx.fx.root,
    fluidx3dFound: ctx.fx.found,
    exeExists: fs.existsSync(ctx.fx.exe),
    solverInstalled: fs.existsSync(path.join(ctx.fx.src, "setup_config.cpp")),
    hasMsbuild: hasMsbuild(),
    gpu: config.gpu
  });
});

registerStl(api, ctx);

registerSetups(api, ctx);
registerRun(api, ctx);

app.use("/api", api);

// Three.js is served straight out of node_modules; no bundler involved.
app.use("/vendor/three", express.static(path.join(NODE_MODULES, "three")));
app.use("/data", express.static(DATA_DIR));
app.use(express.static(WEB_DIR, { extensions: ["html"] }));

app.use("/api", (req, res) => res.status(404).json({ error: "Unknown endpoint." }));

/**
 * Every error leaves the server as a readable, user-facing message (CONTRACT.md §3).
 * body-parser's own failure messages are terse, so they are rephrased here.
 */
function publicMessage(err) {
  if (err.publicMessage) return err.publicMessage;
  switch (err.type) {
    case "entity.parse.failed":
      return "The request body is not valid JSON.";
    case "entity.too.large":
      return "The request body is too large; the limit is 8 MB.";
    case "encoding.unsupported":
      return "The content encoding of the request body is not supported.";
    case "charset.unsupported":
      return "The character set of the request body is not supported.";
    default:
      return err.message || "Internal error.";
  }
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  ctx.log("Error:", err.message);
  const status = err.status || 500;
  res.status(status).json({ error: publicMessage(err) });
});

const server = app.listen(config.port, "127.0.0.1", () => {
  ctx.log(`FluidX3D Studio running at http://127.0.0.1:${config.port}`);
  ctx.log(`FluidX3D: ${ctx.fx.found ? ctx.fx.root : "NOT FOUND at " + ctx.fx.root}`);
  if (!ctx.fx.found) {
    ctx.log("The editor stays usable; building and running are disabled.");
    ctx.log(`Fix the path in ${path.join(ROOT, "studio.config.json")}.`);
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    ctx.log("Shutting down …");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
