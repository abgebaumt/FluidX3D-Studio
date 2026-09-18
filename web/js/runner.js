/**
 * Building, running and everything the user is told about it: the console
 * drawer, the rebuild indicator in the header, toasts and the error dialog.
 *
 * The rebuild indicator is not guessed locally — it comes from POST /preview,
 * because only the server knows which options the binary on disk was built
 * with. Every config change refreshes it, at most once every 400 ms.
 */
import { state, patch, setJob } from "./state.js";
import * as api from "./api.js";
import { validate } from "./schema.js";

const PREVIEW_DEBOUNCE_MS = 400;
const MAX_CONSOLE_LINES = 3000;
const TOAST_MS = 4500;

const STAGE_LABELS = {
  save: "saving",
  defines: "defines",
  build: "building",
  launch: "launching",
  running: "running",
  done: "done",
  error: "error"
};

let stream = null;
let statusLine = null;
let previewTimer = null;
let previewRunning = false;
let previewAgain = false;

const byId = id => document.getElementById(id);

/* ==================================================================== console */

/** Wires the console drawer and the modal. Call once at boot. */
export function initRunner() {
  const toggle = byId("btnConsole");
  if (toggle) toggle.addEventListener("click", () => {
    const box = byId("console");
    if (box) box.dataset.open = box.dataset.open === "true" ? "false" : "true";
  });

  const clear = byId("consoleClear");
  if (clear) clear.addEventListener("click", clearConsole);

  const close = byId("consoleClose");
  if (close) close.addEventListener("click", closeConsole);

  const modalClose = byId("modalClose");
  if (modalClose) modalClose.addEventListener("click", hideModal);

  const modal = byId("modal");
  if (modal) modal.addEventListener("click", ev => { if (ev.target === modal) hideModal(); });
}

export function openConsole() {
  const box = byId("console");
  if (box) box.dataset.open = "true";
}

export function closeConsole() {
  const box = byId("console");
  if (box) box.dataset.open = "false";
}

export function clearConsole() {
  const out = byId("consoleOut");
  if (out) out.textContent = "";
  statusLine = null;
}

/** Appends one line; `cls` is one of the console colour classes g y r c d. */
function writeLine(text, cls) {
  const out = byId("consoleOut");
  if (!out) return;
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;

  for (const raw of String(text).replace(/\s+$/, "").split(/\r?\n/)) {
    const node = cls ? document.createElement("span") : document.createTextNode(raw + "\n");
    if (cls) {
      node.className = cls;
      node.textContent = raw + "\n";
    }
    // the live status line always stays at the bottom
    if (statusLine && statusLine.parentNode === out) out.insertBefore(node, statusLine);
    else out.appendChild(node);
  }

  while (out.childNodes.length > MAX_CONSOLE_LINES) out.removeChild(out.firstChild);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function setStage(text) {
  const stage = byId("consoleStage");
  if (stage) stage.textContent = text;
}

function setStatusLine(text) {
  const out = byId("consoleOut");
  if (!out) return;
  if (!statusLine || statusLine.parentNode !== out) {
    statusLine = document.createElement("span");
    statusLine.className = "c";
    out.appendChild(statusLine);
  }
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 60;
  statusLine.textContent = text + "\n";
  if (atBottom) out.scrollTop = out.scrollHeight;
}

/* =============================================================== build state */

/** Debounced refresh of the rebuild indicator in the header. */
export function refreshBuildState() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
}

function runPreview() {
  if (previewRunning) { previewAgain = true; return; }

  const health = state.health;
  if (health && !health.fluidx3dFound) {
    setBuildState("unknown", "FluidX3D not found");
    return;
  }

  previewRunning = true;
  api.preview(state.config)
    .then(result => {
      if (result && result.needsRebuild) {
        setBuildState("stale", result.reason || "Rebuild needed");
      } else {
        setBuildState("ok", "Binary up to date");
      }
    })
    .catch(err => {
      setBuildState("unknown", err.status === 0 ? "Server unreachable" : err.message);
    })
    .then(() => {
      previewRunning = false;
      if (previewAgain) { previewAgain = false; runPreview(); }
    });
}

function setBuildState(kind, text) {
  const box = byId("buildState");
  if (!box) return;
  box.classList.toggle("stale", kind === "stale");
  box.classList.toggle("unknown", kind === "unknown");
  const em = box.querySelector("em");
  if (em) em.textContent = text;
  box.title = text;
}

/* ==================================================================== buttons */

const jobIsActive = job => !!job && ["preparing", "running", "stopping"].includes(job.state);

/** Enables or disables the header buttons for the current health and job. */
export function updateRunButtons() {
  const run = byId("btnRun");
  const render = byId("btnRender");
  const stop = byId("btnStop");
  const busy = jobIsActive(state.job);
  const reason = blockedReason();

  for (const b of [run, render]) {
    if (!b) continue;
    b.disabled = busy || !!reason;
    b.title = reason || (busy ? "A simulation is already running." : "");
  }
  if (stop) stop.disabled = !busy;
}

/** Why starting is impossible right now, or null. */
function blockedReason() {
  const h = state.health;
  if (!h) return "The server is not responding — building and running are disabled.";
  if (!h.fluidx3dFound) return `FluidX3D was not found at ${h.fluidx3dPath}. Fix the path in studio.config.json.`;
  if (!h.solverInstalled) return "The solver part is not installed — run \"npm run install-solver\" once.";
  return null;
}

/* ======================================================================== run */

/** Starts a run in the given mode; `mode` is "interactive" or "render". */
export async function startRun(mode) {
  if (jobIsActive(state.job)) {
    toast("A simulation is already running.", "warn");
    openConsole();
    return;
  }
  const reason = blockedReason();
  if (reason) {
    showError("The run cannot be started", reason);
    return;
  }

  patch("run.mode", mode === "render" ? "render" : "interactive");

  const checked = validate(state.config);
  if (!checked.ok) {
    showError("The configuration is not ready to run yet",
      "Please resolve the following first:", checked.errors);
    return;
  }

  openConsole();
  clearConsole();
  setStage("preparing …");
  writeLine(`> ${mode === "render" ? "Render run" : "Interactive run"} — ${state.config.name}`, "c");

  try {
    const answer = await api.run(state.config);
    setJob({ id: answer.jobId, state: "preparing", mode });
    attach(answer.jobId);
  } catch (err) {
    setStage("not started");
    writeLine("! " + err.message, "r");
    if (err.status === 409) {
      toast("A simulation is already running.", "warn");
      await adoptRunningJob();
    } else {
      showError("The run could not be started", err.message);
    }
  }
}

/** Asks the server to terminate the running job. */
export async function stopRun() {
  const job = state.job;
  if (!jobIsActive(job)) return;
  try {
    setStage("stopping …");
    await api.stopJob(job.id);
  } catch (err) {
    if (err.status === 409 || err.status === 404) {
      setJob(null);
      setStage("stopped");
    } else {
      showError("The run could not be stopped", err.message);
    }
  }
}

/** Reattaches to a job that was already running when the page opened. */
export async function adoptRunningJob() {
  try {
    const jobs = await api.listJobs();
    const active = (jobs || []).find(jobIsActive);
    if (!active) {
      if (jobIsActive(state.job)) setJob(null);
      return false;
    }
    setJob({ id: active.id, state: active.state, mode: active.mode });
    openConsole();
    attach(active.id);
    return true;
  } catch {
    // No connection: the health indicator already says so.
    return false;
  }
}

/* ======================================================================== sse */

function attach(jobId) {
  if (stream) stream.close();
  statusLine = null;
  stream = api.openJobStream(jobId, event => onEvent(jobId, event));
}

function onEvent(jobId, event) {
  if (!event || typeof event !== "object") return;

  if (event.type === "stage") {
    const label = STAGE_LABELS[event.stage] || event.stage;
    setStage(label);
    const cls = event.stage === "error" ? "r" : event.stage === "done" ? "g" : "c";
    writeLine("> " + (event.text || label), cls);
    if (event.stage === "running" && state.job && state.job.id === jobId) {
      setJob({ ...state.job, state: "running" });
    }
    if (event.stage === "error") {
      toast(event.text || "The run failed.", "crit");
    }
    return;
  }

  if (event.type === "log") {
    const cls = event.stream === "stderr" ? "y" : event.stream === "studio" ? "d" : null;
    writeLine(event.text || "", cls);
    return;
  }

  if (event.type === "status") {
    const parts = [];
    if (Number.isFinite(event.steps)) parts.push(`${fmt(event.steps)} steps`);
    if (Number.isFinite(event.mlups)) parts.push(`${fmt(event.mlups)} MLUPs`);
    if (Number.isFinite(event.simTime)) parts.push(`sim ${dec(event.simTime, 3)} s`);
    if (Number.isFinite(event.runtime)) parts.push(`runtime ${dec(event.runtime, 1)} s`);
    if (parts.length) setStatusLine("  " + parts.join(" · "));
    return;
  }

  if (event.type === "exit") {
    setStage(event.code === 0 ? "finished" : `finished (code ${event.code})`);
    // release the live line so the closing message lands below it
    statusLine = null;
    writeLine(event.code === 0 ? "> Run finished." : `> Run finished with code ${event.code}.`,
      event.code === 0 ? "g" : "r");
    if (state.job && state.job.id === jobId) setJob(null);
    if (stream) { stream.close(); stream = null; }
  }
}

const fmt = v => Math.round(v).toLocaleString("en-US");
const dec = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/* ==================================================================== message */

/** Short, self-dismissing message in the corner. `kind` is ok, warn or crit. */
export function toast(text, kind = "ok") {
  const host = byId("toasts");
  if (!host) return;
  const box = document.createElement("div");
  box.className = "toast " + kind;
  box.textContent = text;
  host.appendChild(box);
  setTimeout(() => box.remove(), TOAST_MS);
}

/** Blocking dialog for everything the user has to read. */
export function showError(title, message, details = []) {
  const modal = byId("modal");
  const head = byId("modalTitle");
  const body = byId("modalBody");
  if (!modal || !body) {
    console.error(title, message, details);
    return;
  }
  if (head) head.textContent = title;

  body.textContent = "";
  const p = document.createElement("p");
  p.style.margin = "0";
  p.textContent = message;
  body.appendChild(p);

  if (details && details.length) {
    const ul = document.createElement("ul");
    for (const line of details.slice(0, 20)) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    }
    body.appendChild(ul);
    if (details.length > 20) {
      const more = document.createElement("p");
      more.textContent = `… and ${details.length - 20} more.`;
      body.appendChild(more);
    }
  }

  modal.hidden = false;
  const close = byId("modalClose");
  if (close) close.focus();
}

export function hideModal() {
  const modal = byId("modal");
  if (modal) modal.hidden = true;
}

/** Whether the error dialog is currently open — the Esc handler asks. */
export function isModalOpen() {
  const modal = byId("modal");
  return !!modal && !modal.hidden;
}
