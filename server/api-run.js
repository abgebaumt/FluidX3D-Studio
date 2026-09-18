/**
 * Routes for previewing defines.hpp, starting a run and following it live.
 *
 * POST /run answers immediately with the job id and then walks the chain
 * save -> defines -> build -> launch, reporting every step through the SSE
 * stream of that job.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { GENERATED_DIR, SETUP_DIR, safeJoin } from "./paths.js";
import { renderDefines, needsRebuild, readBuiltState, writeBuiltState, clearBuiltState } from "./defines.js";
import { buildSolver, writeDefines, hasMsbuild, missingToolMessage } from "./build.js";
import { jobs } from "./run.js";

const GENERATED_DEFINES = path.join(GENERATED_DIR, "defines.hpp");
const PING_INTERVAL_MS = 15000;

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** File name for a setup: keeps it inside data/setups and free of surprises. */
function setupFileName(name) {
  const clean = String(name || "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "");
  return (clean || "untitled").slice(0, 80) + ".json";
}

/** Light structural check; the full schema check lives in the setups module. */
function configError(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return "No configuration was provided.";
  if (!cfg.domain || !Array.isArray(cfg.domain.size_m) || cfg.domain.size_m.length !== 3) {
    return "The configuration has no valid domain size.";
  }
  if (!cfg.solver || typeof cfg.solver !== "object") return "The configuration has no solver section.";
  if (!cfg.run || typeof cfg.run !== "object") return "The configuration has no run section.";
  return null;
}

/**
 * Works out what would have to happen for this config: the defines text and
 * whether the binary has to be rebuilt. Also covers two cases the pure hash
 * comparison cannot see — a missing executable and changed graphics constants,
 * which are compile-time values in defines.hpp as well.
 */
function plan(cfg, fx) {
  const text = renderDefines(cfg);
  const definesSha = sha1(text);
  const rebuild = needsRebuild(cfg, GENERATED_DIR);
  const state = readBuiltState(GENERATED_DIR);
  const exeExists = Boolean(fx && fx.found) && fs.existsSync(fx.exe);

  const reasons = [];
  if (rebuild.needed) reasons.push(rebuild.reason);
  if (!exeExists) reasons.push("The compiled executable is missing.");
  if (!rebuild.needed && state && state.definesSha && state.definesSha !== definesSha) {
    reasons.push("Rebuild needed: graphics values in defines.hpp have changed.");
  }

  return {
    text,
    definesSha,
    needed: reasons.length > 0,
    currentHash: rebuild.currentHash,
    targetHash: rebuild.targetHash,
    reason: reasons.length ? reasons.join(" ") : rebuild.reason,
    exeExists
  };
}

/** Writes the setup where the solver expects it and returns the absolute path. */
function saveSetup(cfg) {
  const file = safeJoin(SETUP_DIR, setupFileName(cfg.name));
  if (!file) throw new Error("The setup name is invalid.");
  fs.mkdirSync(SETUP_DIR, { recursive: true });
  const stored = { ...cfg, savedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), "utf8");
  return file;
}

/** save -> defines -> build -> launch, entirely reported through the job. */
async function runChain(job, ctx, cfg, forceRebuild) {
  const fx = ctx.fx;
  try {
    const setupPath = saveSetup(cfg);
    job.stage("save", `Setup saved: ${path.basename(setupPath)}`);

    const p = plan(cfg, fx);
    const mustBuild = Boolean(forceRebuild) || p.needed;

    if (mustBuild) {
      writeDefines(fx, p.text);
      try {
        fs.writeFileSync(GENERATED_DEFINES, p.text, "utf8");
      } catch {
        // Only a convenience copy for inspection; never fatal.
      }
      job.stage("defines", `defines.hpp written: ${forceRebuild && !p.needed ? "rebuild forced." : p.reason}`);
    } else {
      job.stage("defines", "defines.hpp is up to date; nothing to write.");
    }

    if (mustBuild) {
      if (!hasMsbuild(true)) throw new Error(missingToolMessage());
      job.stage("build", "Compiling FluidX3D; this typically takes one to three minutes.");
      const result = await buildSolver(
        fx,
        (text, stream) => job.log(text, stream),
        (child) => job.trackBuild(child)
      );
      job.trackBuild(null);
      if (job.state === "stopping") throw new Error("The build was cancelled.");
      if (result.code !== 0) {
        clearBuiltState(GENERATED_DIR);
        throw new Error(`The build failed (code ${result.code}). See the compiler output in the log above.`);
      }
      writeBuiltState(cfg, GENERATED_DIR, { definesSha: p.definesSha, seconds: Math.round(result.seconds) });
      job.stage("build", `Build finished in ${result.seconds.toFixed(1)} s.`);
    } else {
      job.stage("build", "Using the existing binary; no rebuild needed.");
    }

    if (!fs.existsSync(fx.exe)) {
      throw new Error(`${fx.exe} is missing after the build. Check the compiler output.`);
    }

    job.stage("launch", `Starting ${path.basename(fx.exe)} …`);
    const started = job.launch(fx, setupPath);
    job.stage("running", `Simulation running (PID ${started.pid}).`);
  } catch (err) {
    ctx.log("Run aborted:", err.message);
    job.fail(err.message || "Unknown error while starting the simulation.");
  }
}

export function register(router, ctx) {
  router.post("/preview", (req, res) => {
    const cfg = req.body && req.body.config ? req.body.config : req.body;
    const problem = configError(cfg);
    if (problem) return res.status(400).json({ error: problem });

    ctx.refreshFx();
    try {
      const p = plan(cfg, ctx.fx);
      res.json({
        defines: p.text,
        needsRebuild: p.needed,
        currentHash: p.currentHash,
        targetHash: p.targetHash,
        reason: p.reason
      });
    } catch (err) {
      res.status(500).json({ error: `defines.hpp could not be generated: ${err.message}` });
    }
  });

  router.post("/run", (req, res) => {
    const cfg = req.body && req.body.config ? req.body.config : req.body;
    const problem = configError(cfg);
    if (problem) return res.status(400).json({ error: problem });

    if (jobs.active()) {
      return res.status(409).json({ error: "A simulation is already running. Stop it first." });
    }

    const fx = ctx.refreshFx();
    if (!fx.found) {
      return res.status(400).json({
        error: `FluidX3D was not found at ${fx.root}. Fix the path in studio.config.json.`
      });
    }
    if (!fs.existsSync(path.join(fx.src, "setup_config.cpp"))) {
      return res.status(400).json({
        error: "The solver part is not installed in FluidX3D. Run \"npm run install-solver\" once."
      });
    }

    let job;
    try {
      job = jobs.create({ mode: cfg.run?.mode === "render" ? "render" : "interactive", name: cfg.name || "", config: cfg });
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }

    res.json({ jobId: job.id });
    // Deliberately not awaited: the client follows the chain over SSE.
    runChain(job, ctx, cfg, Boolean(req.body && req.body.forceRebuild));
  });

  router.post("/jobs/:id/stop", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown job." });
    if (!job.isActive()) return res.status(409).json({ error: "The job is no longer running." });
    const stopped = job.stop();
    if (!stopped) {
      job.fail("The run was cancelled before the solver started.");
    }
    res.json({ ok: true, id: job.id, state: job.state });
  });

  router.get("/jobs", (req, res) => {
    res.json(jobs.list());
  });

  router.get("/jobs/:id/events", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Unknown job." });

    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // Tells any proxy in between not to buffer the stream.
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true);

    const send = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client vanished; the close handler cleans up */
      }
    };

    // Replay so a client that connects late sees the whole run.
    for (const event of job.events) send(event);

    if (!job.isActive()) {
      res.end();
      return;
    }

    let unsubscribe = job.subscribe((event) => {
      send(event);
      if (event.type === "exit") setTimeout(finish, 100);
    });
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        finish();
      }
    }, PING_INTERVAL_MS);

    let done = false;
    function finish() {
      if (done) return;
      done = true;
      clearInterval(ping);
      unsubscribe();
      unsubscribe = () => {};
      res.end();
    }

    req.on("close", finish);
    res.on("close", finish);
    res.on("error", finish);
  });
}
