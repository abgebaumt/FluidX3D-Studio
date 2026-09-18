/**
 * Boot and wiring.
 *
 * Everything that connects the panels to the server, to the keyboard and to
 * the viewport lives here. The viewport modules are loaded dynamically: if
 * WebGL or Three.js is unavailable the editor still has to work, only without
 * the 3D view.
 */
import {
  state, subscribe, setConfig, setStlIndex, setHealth, setUi, select, selected, patch
} from "./state.js";
import { validate, makeObject, cleanName } from "./schema.js";
import { derive, nf } from "./derive.js";
import * as api from "./api.js";
import { renderTree, updateTree, removeObject, EV_PICK_STL, EV_STL_FILES } from "./tree.js";
import { renderInspector, updateInspector, EV_FOCUS_OBJECT } from "./inspector.js";
import { renderBand } from "./band.js";
import {
  initRunner, startRun, stopRun, refreshBuildState, updateRunButtons,
  adoptRunningJob, toast, showError, hideModal, isModalOpen
} from "./runner.js";

const LAST_SETUP_KEY = "fluidx3d-studio.lastSetup";
const HEALTH_INTERVAL_MS = 15000;

const byId = id => document.getElementById(id);

/**
 * Bridge to the viewport modules; stays empty when they fail to load.
 *
 * Only what the wiring actually drives lives here. The viewport modules keep
 * themselves in step with the config through their own `state.subscribe`, so
 * `updateDomain`, `syncObjects` and `updateFlow` must *not* be called from
 * here — a second call would only do the same work twice.
 */
const view = {
  ready: false,
  focusObject: () => false,
  setGizmoMode: () => {},
  frameDomain: () => {}
};

/** A setup that arrived before the viewport was up still deserves its framing. */
let framePending = false;

/* ===================================================================== boot */

initRunner();
wireHeader();
wireBars();
wireFiles();
wireKeyboard();

renderTree();
renderInspector();
renderBand();
renderHud();
updateViewBar();
updateGizmoBar();
renderHealth();
updateRunButtons();

subscribe(onStateChange);

bootViewport();
bootServer();

function onStateChange(reason) {
  if (reason === "config") {
    updateTree();
    updateInspector();
    renderBand();
    renderHud();
    syncNameField();
    refreshBuildState();
    return;
  }
  if (reason === "selection") {
    renderTree();
    renderInspector();
    updateGizmoBar();
    if (view.ready) view.setGizmoMode(gizmoMode());
    const sel = selected();
    if (sel.kind === "object") focusWhenReady(sel.id);
    return;
  }
  if (reason === "ui") {
    updateViewBar();
    updateGizmoBar();
    if (view.ready) view.setGizmoMode(gizmoMode());
    return;
  }
  if (reason === "stl") {
    renderTree();
    renderInspector();
    return;
  }
  if (reason === "health") {
    renderHealth();
    renderBand();
    updateRunButtons();
    refreshBuildState();
    return;
  }
  if (reason === "job") {
    updateRunButtons();
  }
}

/* =================================================================== server */

async function bootServer() {
  await pollHealth();
  setInterval(pollHealth, HEALTH_INTERVAL_MS);

  await refreshStlIndex();
  await refreshSetups();
  await restoreLastSetup();
  await adoptRunningJob();
  refreshBuildState();
}

async function pollHealth() {
  try {
    setHealth(await api.health());
  } catch {
    setHealth(null);
  }
}

async function refreshStlIndex() {
  try {
    setStlIndex(await api.listStl());
  } catch {
    // The health indicator already reports a dead server.
  }
}

async function refreshSetups(keep) {
  const box = byId("setupSelect");
  if (!box) return;
  let list = [];
  try {
    list = await api.listSetups();
  } catch {
    return;
  }
  const current = keep !== undefined ? keep : box.value;
  box.textContent = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = list.length ? "— Load setup —" : "— no setups —";
  box.appendChild(empty);
  for (const entry of list) {
    const o = document.createElement("option");
    o.value = entry.name;
    o.textContent = entry.name;
    if (entry.name === current) o.selected = true;
    box.appendChild(o);
  }
}

async function restoreLastSetup() {
  const name = readStore(LAST_SETUP_KEY);
  if (!name) {
    syncNameField(true);
    return;
  }
  const box = byId("setupSelect");
  const known = box && [...box.options].some(o => o.value === name);
  if (!known) return;
  await loadSetupByName(name, true);
}

async function loadSetupByName(name, quiet = false) {
  try {
    const raw = await api.loadSetup(name);
    const checked = validate(raw);
    setConfig(checked.config);
    syncNameField(true);
    frameDomain();
    writeStore(LAST_SETUP_KEY, name);
    const box = byId("setupSelect");
    if (box) box.value = name;
    if (!checked.ok) {
      showError("The setup was adjusted while loading",
        "These values were invalid and have been corrected:", checked.errors);
    } else if (!quiet) {
      toast(`Setup "${name}" loaded.`, "ok");
    }
  } catch (err) {
    showError("The setup could not be loaded", err.message);
  }
}

async function saveCurrentSetup() {
  const input = byId("setupName");
  const name = cleanName(input ? input.value : state.config.name, state.config.name || "setup");
  if (input) input.value = name;
  if (state.config.name !== name) patch("name", name);

  const checked = validate(state.config);
  if (!checked.ok) {
    showError("The setup is not valid yet",
      "Please resolve the following first:", checked.errors);
    return;
  }
  try {
    await api.saveSetup(name, checked.config);
    writeStore(LAST_SETUP_KEY, name);
    toast(`Setup "${name}" saved.`, "ok");
    await refreshSetups(name);
  } catch (err) {
    showError("Saving failed", err.message);
  }
}

/* ==================================================================== header */

function wireHeader() {
  const save = byId("btnSave");
  if (save) save.addEventListener("click", saveCurrentSetup);

  const run = byId("btnRun");
  if (run) run.addEventListener("click", () => startRun("interactive"));

  const render = byId("btnRender");
  if (render) render.addEventListener("click", () => startRun("render"));

  const stop = byId("btnStop");
  if (stop) stop.addEventListener("click", stopRun);

  const name = byId("setupName");
  if (name) {
    name.addEventListener("change", () => {
      const clean = cleanName(name.value, state.config.name || "setup");
      name.value = clean;
      patch("name", clean);
    });
  }

  const setups = byId("setupSelect");
  if (setups) {
    setups.addEventListener("change", () => {
      if (setups.value) loadSetupByName(setups.value);
    });
  }
}

function syncNameField(force = false) {
  const input = byId("setupName");
  if (!input) return;
  if (force || document.activeElement !== input) input.value = state.config.name;
}

function renderHealth() {
  const box = byId("healthState");
  if (!box) return;
  const em = box.querySelector("em");
  const h = state.health;

  box.classList.remove("warn", "crit", "busy");
  let text;
  if (!h) {
    box.classList.add("crit");
    text = "Server unreachable";
    box.title = "Is \"npm start\" still running?";
  } else if (!h.fluidx3dFound) {
    box.classList.add("warn");
    text = "FluidX3D not found";
    box.title = `Expected at ${h.fluidx3dPath}. Fix the path in studio.config.json — the editor stays usable.`;
  } else if (!h.solverInstalled) {
    box.classList.add("warn");
    text = "Solver not installed";
    box.title = "Run \"npm run install-solver\" once.";
  } else if (!h.hasMsbuild) {
    box.classList.add("warn");
    text = "No compiler found";
    box.title = "Without msbuild or make.sh nothing can be rebuilt.";
  } else {
    text = (h.gpu && h.gpu.name) || "connected";
    box.title = `FluidX3D: ${h.fluidx3dPath} · Node ${h.node}`;
  }
  if (em) em.textContent = text;
}

/* ====================================================================== bars */

function wireBars() {
  const viewbar = byId("viewbar");
  if (viewbar) {
    viewbar.addEventListener("click", ev => {
      const b = ev.target.closest("button[data-vb]");
      if (!b) return;
      const key = b.dataset.vb;
      setUi(`view.${key}`, !state.ui.view[key]);
    });
  }

  const gizmobar = byId("gizmobar");
  if (gizmobar) {
    gizmobar.addEventListener("click", ev => {
      const b = ev.target.closest("button[data-gizmo]");
      if (!b) return;
      setUi("gizmo", b.dataset.gizmo);
    });
  }
}

function updateViewBar() {
  const viewbar = byId("viewbar");
  if (!viewbar) return;
  for (const b of viewbar.querySelectorAll("button[data-vb]")) {
    b.setAttribute("aria-pressed", String(!!state.ui.view[b.dataset.vb]));
  }
}

function updateGizmoBar() {
  const gizmobar = byId("gizmobar");
  if (!gizmobar) return;
  gizmobar.hidden = selected().kind !== "object";
  for (const b of gizmobar.querySelectorAll("button[data-gizmo]")) {
    b.setAttribute("aria-pressed", String(b.dataset.gizmo === state.ui.gizmo));
  }
}

/** No gizmo unless an object is selected, whatever the UI state says. */
const gizmoMode = () => (selected().kind === "object" ? state.ui.gizmo : "none");

/* ==================================================================== upload */

function wireFiles() {
  const input = byId("fileInput");
  const button = byId("btnUpload");

  const pick = () => { if (input) input.click(); };
  if (button) button.addEventListener("click", pick);
  document.addEventListener(EV_PICK_STL, pick);

  if (input) {
    input.addEventListener("change", () => {
      const files = [...input.files];
      input.value = "";
      uploadFiles(files);
    });
  }

  document.addEventListener(EV_STL_FILES, ev => uploadFiles(ev.detail.files));
  document.addEventListener(EV_FOCUS_OBJECT, ev => focusWhenReady(ev.detail.id));

  wireDragAndDrop();
}

function wireDragAndDrop() {
  const zone = byId("dropZone");
  let depth = 0;

  const show = on => { if (zone) zone.dataset.active = String(on); };
  const carriesFiles = ev =>
    !!ev.dataTransfer && [...ev.dataTransfer.types || []].includes("Files");

  window.addEventListener("dragenter", ev => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    depth++;
    show(true);
  });
  window.addEventListener("dragover", ev => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) show(false);
  });
  window.addEventListener("drop", ev => {
    if (!carriesFiles(ev)) return;
    ev.preventDefault();
    depth = 0;
    show(false);
    uploadFiles([...ev.dataTransfer.files]);
  });
}

async function uploadFiles(files) {
  const list = [...(files || [])].filter(f => /\.stl$/i.test(f.name));
  if (!list.length) {
    if (files && files.length) toast("Only .stl files are accepted.", "warn");
    return;
  }

  let added = null;
  for (const file of list) {
    const bar = showProgress();
    try {
      const entry = await api.uploadStl(file, p => bar.set(p));
      const objects = state.config.objects || [];
      const object = makeObject(entry, objects);
      patch("objects", [...objects, object]);
      // The first body is almost always the one the Reynolds number is about.
      if (objects.length === 0 && state.config.reference.source === "manual") {
        patch("reference.length_m", Math.max(1e-6, object.sizing.value));
        patch("reference.source", "object:" + object.id);
      }
      added = object.id;
      toast(`${entry.name} loaded — ${Number(entry.triangles).toLocaleString("en-US")} triangles.`, "ok");
    } catch (err) {
      showError("The upload failed", `${file.name}: ${err.message}`);
    } finally {
      bar.done();
    }
  }

  await refreshStlIndex();
  // selecting it is enough — the selection handler flies the camera onto it
  if (added) select(added);
}

/** Thin progress strip along the bottom of the viewport. */
function showProgress() {
  const host = byId("view");
  if (!host) return { set() {}, done() {} };
  const bar = document.createElement("div");
  bar.className = "upload-bar";
  const fill = document.createElement("i");
  bar.appendChild(fill);
  host.appendChild(bar);
  return {
    set(p) { fill.style.width = Math.round(Math.min(1, Math.max(0, p)) * 100) + "%"; },
    done() { bar.remove(); }
  };
}

/* ================================================================== keyboard */

function wireKeyboard() {
  window.addEventListener("keydown", ev => {
    const key = ev.key;

    if ((ev.ctrlKey || ev.metaKey) && key.toLowerCase() === "s") {
      ev.preventDefault();
      saveCurrentSetup();
      return;
    }
    if (key === "Escape") {
      if (isModalOpen()) hideModal();
      else setUi("gizmo", "none");
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const target = ev.target;
    if (target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))) {
      return;
    }

    if (key === "g" || key === "G") setUi("gizmo", "translate");
    else if (key === "r" || key === "R") setUi("gizmo", "rotate");
    else if (key === "s" || key === "S") setUi("gizmo", "scale");
    else if (key === "Delete") {
      const sel = selected();
      if (sel.kind === "object") {
        removeObject(sel.id);
        toast("Object removed.", "ok");
      }
    }
  });
}

/* ================================================================== viewport */

async function bootViewport() {
  const host = byId("viewport-canvas");
  if (!host) return;
  try {
    // flow.js is loaded for its side effects only — it registers its own tick
    const [viewport, domain, objects] = await Promise.all([
      import("./viewport.js"),
      import("./domain.js"),
      import("./objects.js"),
      import("./flow.js")
    ]);

    viewport.initViewport(host);
    view.focusObject = objects.focusObject;
    view.setGizmoMode = objects.setGizmoMode;
    view.frameDomain = domain.frameDomain;
    view.ready = true;

    view.setGizmoMode(gizmoMode());
    // a setup loaded while the modules were still being fetched
    if (framePending) {
      framePending = false;
      view.frameDomain(true);
    }
    const sel = selected();
    if (sel.kind === "object") focusWhenReady(sel.id);
  } catch (err) {
    console.error("The 3D view could not be started:", err);
    toast("The 3D view could not be started — the editor stays usable.", "crit");
  }
}

/* ==================================================================== camera */

/** Puts the whole domain into the view; used after a setup was loaded. */
function frameDomain() {
  if (!view.ready) {
    framePending = true;
    return;
  }
  view.frameDomain(false);
}

/**
 * Flies onto an object. Its mesh may still be loading, so this keeps trying
 * for a short while — and gives up as soon as the selection moved on.
 */
function focusWhenReady(objectId, timeoutMs = 4000) {
  if (!view.ready || !objectId) return;
  const deadline = Date.now() + timeoutMs;
  const attempt = () => {
    if (state.selection !== objectId) return;
    if (view.focusObject(objectId)) return;
    if (Date.now() < deadline) requestAnimationFrame(attempt);
  };
  attempt();
}

/* ======================================================================= hud */

function renderHud() {
  const gpu = (state.health && state.health.gpu) || {};
  const d = derive(state.config, gpu);
  const size = state.config.domain.size_m;
  const fluid = state.config.fluid;

  const tl = byId("hudTL");
  if (tl) {
    tl.textContent = "";
    tl.append(bold(`${nf(size[0], 1)} × ${nf(size[1], 1)} × ${nf(size[2], 1)} m`), lineBreak());
    tl.append(`Cell ${nf(d.cell * 100, 2)} cm · ${d.Nx}×${d.Ny}×${d.Nz}`, lineBreak());
    tl.append(`${nf(fluid.velocity_ms, 0)} m/s · azimuth ${nf(fluid.azimuth_deg, 0)}° · elev. ${nf(fluid.elevation_deg, 0)}°`);
  }

  const bottom = byId("hudBR");
  if (bottom) {
    bottom.textContent = "";
    bottom.append("x spanwise · y streamwise · z up", lineBreak());
    bottom.append(bold("Drag"), " to orbit · ", bold("Wheel"), " to zoom");
  }
}

function bold(text) {
  const b = document.createElement("b");
  b.textContent = text;
  return b;
}

function lineBreak() {
  return document.createElement("br");
}

/* ================================================================== storage */

function readStore(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota; losing the last setup name is harmless.
  }
}
