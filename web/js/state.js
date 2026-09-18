/**
 * The living state of the editor.
 *
 * Only this module mutates the config; every other module reads `state` and
 * subscribes. Changes are coalesced and announced once per animation frame,
 * so dragging a slider does not trigger hundreds of repaints.
 */
import { defaultConfig } from "./schema.js";

/** Ids the scene tree and the inspector agree on for the fixed sections. */
export const SECTION_IDS = [
  "domain", "fluid", "boundaries", "reference", "visualization", "solver", "run"
];

export const state = {
  /** Setup config, schema 1. */
  config: defaultConfig(),
  /** Selected tree node: a section id or an object id. */
  selection: "domain",
  ui: {
    /** TransformControls mode: "translate" | "rotate" | "scale" | "none". */
    gizmo: "translate",
    view: { flow: true, bc: true, grid: true, axes: true }
  },
  /** Latest `/api/stl` listing. */
  stlIndex: [],
  /** Latest `/api/health` answer, null until the first poll succeeded. */
  health: null,
  /** Running job: `{ id, state, mode, ... }` or null. */
  job: null
};

/* ============================================================ notification */

const REASONS = ["config", "selection", "ui", "stl", "health", "job"];

const listeners = new Set();
const pending = new Set();
let scheduled = false;

const raf = typeof requestAnimationFrame === "function"
  ? requestAnimationFrame
  : cb => setTimeout(cb, 16);

/** @param {(reason:"config"|"selection"|"ui"|"stl"|"health"|"job")=>void} fn */
export function subscribe(fn) {
  if (typeof fn !== "function") throw new TypeError("subscribe expects a function.");
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Queues a change notification for the next frame. */
export function notify(reason) {
  if (!REASONS.includes(reason)) throw new RangeError(`Unknown reason "${reason}".`);
  pending.add(reason);
  if (scheduled) return;
  scheduled = true;
  raf(flush);
}

/** Delivers everything queued so far, right now. */
export function flush() {
  scheduled = false;
  if (pending.size === 0) return;
  const reasons = [...pending];
  pending.clear();
  const fns = [...listeners];
  for (const reason of reasons) {
    for (const fn of fns) {
      // one broken subscriber must not stop the others
      try { fn(reason); } catch (err) { console.error("Subscriber failed:", err); }
    }
  }
}

/* ==================================================================== config */

/**
 * Writes a single value into the config. The path is dot separated; numeric
 * segments address array elements, e.g. `"domain.size_m.1"` or
 * `"objects.0.rotation_deg.pitch"`.
 */
export function patch(path, value) {
  writePath(state.config, path, value);
  notify("config");
  return value;
}

/** Reads a value out of the config by the same path syntax as `patch`. */
export function read(path) {
  const keys = splitPath(path);
  let node = state.config;
  for (const key of keys) {
    if (node === null || node === undefined) return undefined;
    node = node[key];
  }
  return node;
}

/** Replaces the whole config, e.g. after loading a setup. */
export function setConfig(cfg) {
  state.config = cfg;
  notify("config");
  if (!isSelectable(state.selection)) {
    state.selection = "domain";
    notify("selection");
  }
  return state.config;
}

/* ================================================================= selection */

export function select(id) {
  if (state.selection === id) return id;
  state.selection = id;
  notify("selection");
  return id;
}

/**
 * The selected tree node.
 * @returns {{ id:string, kind:"section"|"object", object:object|null }}
 */
export function selected() {
  const id = state.selection;
  const object = (state.config.objects || []).find(o => o.id === id) || null;
  return { id, kind: object ? "object" : "section", object };
}

/* ======================================================================== ui */

/** `setUi("gizmo", "rotate")`, `setUi("view.grid", false)`. */
export function setUi(path, value) {
  writePath(state.ui, path, value);
  notify("ui");
  return value;
}

/* ================================================================== backend */

export function setStlIndex(list) {
  state.stlIndex = Array.isArray(list) ? list : [];
  notify("stl");
  return state.stlIndex;
}

export function setHealth(h) {
  state.health = h || null;
  notify("health");
  return state.health;
}

export function setJob(j) {
  state.job = j || null;
  notify("job");
  return state.job;
}

/* ================================================================== helpers */

function splitPath(path) {
  if (typeof path !== "string" || !path) throw new TypeError("Empty path.");
  return path.split(".").map(k => (/^\d+$/.test(k) ? Number(k) : k));
}

function writePath(root, path, value) {
  const keys = splitPath(path);
  let node = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (node[key] === null || typeof node[key] !== "object") {
      // grow the shape the path implies rather than failing silently
      node[key] = typeof keys[i + 1] === "number" ? [] : {};
    }
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
}

function isSelectable(id) {
  if (SECTION_IDS.includes(id)) return true;
  return (state.config.objects || []).some(o => o.id === id);
}
