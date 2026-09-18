/**
 * Job management: one FluidX3D process at a time, its console output parsed
 * into the SSE events of CONTRACT.md §3.
 *
 * A job exists before the solver starts, so the preparation stages (saving,
 * writing defines, building) are reported through the same channel. Every
 * event is buffered, which lets a client that connects late replay the whole
 * run from the beginning.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

const IS_WINDOWS = process.platform === "win32";

/** Upper bound of buffered events per job; stage/exit events are never dropped. */
const MAX_EVENTS = 3000;
/** Minimum distance between two forwarded status events, in milliseconds. */
const STATUS_INTERVAL_MS = 200;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * FluidX3D's live line, written with a carriage return:
 * "|    6431 |     412 GB/s |       120 |        12034  42% |          1m30s |"
 */
const TABLE_LINE = /^\|\s*(\d+)\s*\|\s*(\d+)\s*GB\/s\s*\|\s*(\d+)\s*\|\s*(\d+)\s*(?:(\d+)\s*%)?\s*\|\s*([^|]*?)\s*\|\s*$/;

const KEY_STEPS = /\b(?:steps?|current[_ ]?step|lbm[_ ]?steps?)\s*[=:]\s*(\d+)/i;
const KEY_MLUPS = /\bmlups\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)/i;
const KEY_SIMTIME = /\b(?:sim[_ ]?time|simulated[_ ]?time|sim[_ ]?t|t[_ ]?sim)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?(?:[eE][+-]?\d+)?)/i;
const KEY_RUNTIME = /\b(?:runtime|elapsed[_ ]?time|elapsed)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)/i;

let idCounter = 0;

function nextId() {
  idCounter += 1;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Time step in seconds, derived exactly like CONTRACT.md §2, so the reported
 * simulated time matches what the editor's instrument band predicts.
 * Returns null when the config does not carry enough information.
 */
export function estimateDtSeconds(cfg) {
  const size = cfg?.domain?.size_m;
  const targetVram = num(cfg?.domain?.target_vram_mb);
  const velocity = num(cfg?.fluid?.velocity_ms);
  const uLbm = num(cfg?.fluid?.u_lbm);
  if (!Array.isArray(size) || size.length !== 3 || !targetVram || !velocity || !uLbm) return null;
  const [lx, ly, lz] = size.map(num);
  if (![lx, ly, lz].every((v) => v && v > 0) || velocity <= 0) return null;

  const set = num(cfg?.solver?.velocity_set) || 19;
  const fpSize = String(cfg?.solver?.precision || "FP16S").toUpperCase() === "FP32" ? 4 : 2;
  const ext = new Set((cfg?.solver?.extensions || []).map((e) => String(e).toUpperCase()));
  let bytesPerCell = set * fpSize + 17;
  if (ext.has("FORCE_FIELD")) bytesPerCell += 12;
  if (ext.has("SURFACE")) bytesPerCell += 12;
  if (ext.has("TEMPERATURE")) bytesPerCell += 7 * fpSize + 4;

  const scale = Math.cbrt(targetVram / ((lx * ly * lz * bytesPerCell) / 1048576));
  const nx = Math.max(2, Math.round(scale * lx));
  const cellM = lx / nx;
  return (uLbm / velocity) * cellM;
}

/** Splits a stream into lines; FluidX3D redraws its status line with "\r". */
function splitter(onLine) {
  let rest = "";
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split(/\r\n|\n|\r/);
      rest = parts.pop();
      for (const part of parts) onLine(part);
    },
    flush() {
      if (rest.trim().length) onLine(rest);
      rest = "";
    }
  };
}

/**
 * Tries to read a status out of one console line.
 * Returns null for everything that is not recognised — that is forwarded as log.
 */
export function parseStatusLine(text) {
  const line = text.replace(ANSI, "").trim();
  if (!line) return null;

  const table = TABLE_LINE.exec(line);
  if (table) {
    return {
      mlups: num(table[1]),
      bandwidthGBs: num(table[2]),
      stepsPerSecond: num(table[3]),
      steps: num(table[4]),
      percent: table[5] === undefined ? null : num(table[5]),
      timeText: table[6] || null
    };
  }

  // A solver that prints its own machine-readable status line.
  const jsonStart = line.indexOf("{");
  if (/^status\b/i.test(line) && jsonStart >= 0) {
    try {
      const obj = JSON.parse(line.slice(jsonStart));
      if (obj && typeof obj === "object") {
        return {
          steps: num(obj.steps ?? obj.step),
          mlups: num(obj.mlups),
          simTime: num(obj.simTime ?? obj.sim_time ?? obj.t),
          runtime: num(obj.runtime)
        };
      }
    } catch {
      /* not JSON after all, fall through to the key/value scan */
    }
  }

  const steps = KEY_STEPS.exec(line);
  const mlups = KEY_MLUPS.exec(line);
  const simTime = KEY_SIMTIME.exec(line);
  const runtime = KEY_RUNTIME.exec(line);
  if (!steps && !mlups && !simTime) return null;
  return {
    steps: steps ? num(steps[1]) : null,
    mlups: mlups ? num(mlups[1]) : null,
    simTime: simTime ? num(simTime[1]) : null,
    runtime: runtime ? num(runtime[1]) : null
  };
}

/** One simulation run: preparation stages, the solver process and its output. */
export class Job {
  constructor({ mode = "interactive", name = "", config = null } = {}) {
    this.id = nextId();
    this.mode = mode;
    this.name = name;
    this.config = config;
    this.dtSeconds = config ? estimateDtSeconds(config) : null;
    this.state = "preparing";
    this.startedAt = new Date().toISOString();
    this.endedAt = null;
    this.exitCode = null;
    this.pid = null;

    this.events = [];
    this.listeners = new Set();
    this.child = null;
    this.buildChild = null;
    this.processStartedAt = null;
    this.lastStatusAt = 0;
    this.killTimer = null;
    /** Set once an explicit error stage was emitted, to avoid a second one. */
    this.reported = false;
  }

  summary() {
    return {
      id: this.id,
      state: this.state,
      mode: this.mode,
      name: this.name,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      exitCode: this.exitCode
    };
  }

  isActive() {
    return this.state === "preparing" || this.state === "running" || this.state === "stopping";
  }

  /** Buffers an event and hands it to every attached listener. */
  emit(event) {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      const drop = this.events.findIndex((e) => e.type === "log" || e.type === "status");
      this.events.splice(drop < 0 ? 0 : drop, 1);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a broken client must not stop the job */
      }
    }
  }

  stage(stage, text) {
    this.emit({ type: "stage", stage, text });
  }

  log(text, stream = "studio") {
    this.emit({ type: "log", stream, text });
  }

  /** Attaches a listener and returns the function that detaches it again. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleLine(text, stream) {
    const status = parseStatusLine(text);
    if (!status) {
      const clean = text.replace(ANSI, "").replace(/\s+$/, "");
      if (clean.trim().length) this.log(clean, stream);
      return;
    }

    // FluidX3D redraws its status line every frame; throttle to keep the SSE
    // stream and the event buffer readable.
    const now = Date.now();
    if (this.lastStatusAt !== 0 && now - this.lastStatusAt < STATUS_INTERVAL_MS) return;
    this.lastStatusAt = now;

    const runtime = status.runtime ?? (this.processStartedAt ? (now - this.processStartedAt) / 1000 : null);
    let simTime = status.simTime ?? null;
    if (simTime === null && this.dtSeconds && status.steps !== null) {
      simTime = status.steps * this.dtSeconds;
    }

    const event = { type: "status" };
    if (status.steps !== null) event.steps = status.steps;
    if (status.mlups !== null && status.mlups !== undefined) event.mlups = status.mlups;
    if (simTime !== null) event.simTime = Number(simTime.toFixed(6));
    if (runtime !== null) event.runtime = Number(runtime.toFixed(2));
    this.emit(event);
  }

  /**
   * Starts bin/FluidX3D with the setup config and returns once the process is
   * up; its outcome arrives later as an exit event.
   */
  launch(fx, configPath) {
    if (this.child) throw new Error("This job is already running.");
    if (!fx || !fs.existsSync(fx.exe)) {
      throw new Error(`The executable ${fx ? fx.exe : "bin/FluidX3D"} was not found.`);
    }

    const args = ["--config", configPath];
    let child;
    try {
      child = spawn(fx.exe, args, {
        cwd: fx.root,
        windowsHide: true,
        // A process group makes it possible to take the whole tree down on POSIX.
        detached: !IS_WINDOWS,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (err) {
      throw new Error(`The solver could not be started: ${err.message}`);
    }

    this.child = child;
    this.pid = child.pid ?? null;
    this.processStartedAt = Date.now();
    this.state = "running";

    const out = splitter((l) => this.handleLine(l, "stdout"));
    const err = splitter((l) => this.handleLine(l, "stderr"));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));

    child.on("error", (e) => {
      this.log(`Process error: ${e.message}`, "studio");
      this.finish(-1);
    });
    child.on("close", (code, signal) => {
      out.flush();
      err.flush();
      this.finish(code === null ? (signal ? 0 : -1) : code);
    });

    return { pid: this.pid, exe: fx.exe, args };
  }

  /** Remembers the compiler process so a stop during the build works too. */
  trackBuild(child) {
    this.buildChild = child || null;
  }

  /** Kills a process and everything it started. */
  killTree(child) {
    const pid = child?.pid;
    if (!pid) return false;
    if (IS_WINDOWS) {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => child.kill());
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      this.killTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 4000);
      this.killTimer.unref();
    }
    return true;
  }

  /** Terminates the process tree; on Windows through taskkill /T /F. */
  stop() {
    if (!this.isActive()) return false;
    const target = this.child || this.buildChild;
    if (!target) return false;
    this.state = "stopping";
    this.stage("running", "Stopping …");
    return this.killTree(target);
  }

  /** Ends the job without a process, e.g. when preparation failed. */
  fail(message) {
    if (!this.isActive()) return;
    this.stage("error", message);
    this.reported = true;
    this.finish(1);
  }

  finish(code) {
    if (!this.isActive()) return;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    const stopped = this.state === "stopping";
    this.exitCode = code;
    this.endedAt = new Date().toISOString();
    this.state = stopped ? "stopped" : code === 0 ? "done" : "error";
    if (stopped) {
      this.stage("done", "Stopped.");
    } else if (code === 0) {
      this.stage("done", "Run finished.");
    } else if (!this.reported) {
      this.stage("error", `The solver exited with code ${code}.`);
    }
    this.emit({ type: "exit", code });
    this.child = null;
  }
}

/** Holds every job of this server run and enforces the one-at-a-time rule. */
export class JobManager {
  constructor(limit = 30) {
    this.jobs = new Map();
    this.limit = limit;
  }

  active() {
    for (const job of this.jobs.values()) if (job.isActive()) return job;
    return null;
  }

  create(options) {
    if (this.active()) throw new Error("A simulation is already running.");
    const job = new Job(options);
    this.jobs.set(job.id, job);
    this.prune();
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list() {
    return [...this.jobs.values()].map((job) => job.summary()).reverse();
  }

  /** Keeps the history bounded; finished jobs are discarded oldest first. */
  prune() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.limit) break;
      if (!job.isActive()) this.jobs.delete(id);
    }
  }
}

export const jobs = new JobManager();
