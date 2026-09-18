/**
 * Left scene tree.
 *
 * Fixed sections, the geometry group with one row per config object and a drop
 * target for new STL files at the bottom. The tree never uploads anything
 * itself — it raises `studio:pick-stl` and `studio:stl-files` on `document`
 * and lets main.js do the talking to the server.
 */
import { state, select, patch } from "./state.js";

/** Fired when the user asks for the file dialog. */
export const EV_PICK_STL = "studio:pick-stl";
/** Fired with `detail.files` (an array of File) when files are dropped here. */
export const EV_STL_FILES = "studio:stl-files";

const SIMULATION = [
  { id: "domain", label: "Domain", swatch: "var(--muted)" },
  { id: "fluid", label: "Fluid", swatch: "var(--fluid)" },
  { id: "boundaries", label: "Boundaries", swatch: "var(--fluid)" },
  { id: "reference", label: "Reference length", swatch: "var(--muted)" }
];

const OUTPUT = [
  { id: "visualization", label: "Visualization", swatch: "var(--faint)" },
  { id: "solver", label: "Solver", swatch: "var(--faint)" },
  { id: "run", label: "Run", swatch: "var(--faint)" }
];

/* ==================================================================== render */

/** Everything the tree actually shows; see `updateTree()`. */
function signature() {
  const c = state.config;
  const objects = c.objects || [];
  return [
    state.selection,
    c.reference ? c.reference.source : "",
    objects.map(o => `${o.id}${o.name}${o.visible ? 1 : 0}${o.enabled ? 1 : 0}${o.motion.type}`).join("")
  ].join("");
}

let mounted = null;

/**
 * Re-renders only when something the tree displays has changed — a slider drag
 * fires a config notification on every frame and must not rebuild this list.
 */
export function updateTree() {
  if (signature() !== mounted) renderTree();
}

export function renderTree() {
  const host = document.getElementById("tree");
  if (!host) return;
  const scroll = host.scrollTop;
  mounted = signature();
  host.textContent = "";

  host.appendChild(head("Simulation"));
  for (const s of SIMULATION) host.appendChild(sectionNode(s));

  const objects = state.config.objects || [];
  host.appendChild(head("Geometry", objects.length));
  if (objects.length === 0) {
    host.appendChild(note("No geometry yet. Drop an STL file below — the domain also runs empty."));
  }
  for (let i = 0; i < objects.length; i++) host.appendChild(objectNode(objects[i], i));

  host.appendChild(head("Output"));
  for (const s of OUTPUT) host.appendChild(sectionNode(s));

  host.appendChild(head("Add STL"));
  host.appendChild(dropZone());

  host.scrollTop = scroll;
}

/* ===================================================================== nodes */

function sectionNode(spec) {
  const row = baseNode(spec.id, spec.label, spec.swatch);
  return row;
}

function objectNode(obj, index) {
  const row = baseNode(obj.id, obj.name || obj.id, "var(--solid)");
  if (!obj.enabled) row.classList.add("off");

  if (obj.motion && obj.motion.type === "rotate") {
    row.appendChild(el("span", "badge moving", "rotating"));
  }
  if (state.config.reference && state.config.reference.source === "object:" + obj.id) {
    const b = el("span", "badge", "Re");
    b.title = "Provides the reference length for the Reynolds number";
    row.appendChild(b);
  }

  const eye = el("button", "eye", obj.visible ? "◉" : "○");
  eye.setAttribute("aria-pressed", String(!!obj.visible));
  eye.setAttribute("aria-label", `Visibility of ${obj.name}`);
  eye.title = obj.visible ? "Hide in editor" : "Show in editor";
  eye.addEventListener("click", ev => {
    ev.stopPropagation();
    patch(`objects.${index}.visible`, !obj.visible);
  });

  const kill = el("button", "kill", "✕");
  kill.setAttribute("aria-label", `Remove ${obj.name}`);
  kill.title = "Remove object";
  kill.addEventListener("click", ev => {
    ev.stopPropagation();
    removeObject(obj.id);
  });

  row.append(eye, kill);
  return row;
}

function baseNode(id, label, swatch) {
  const row = el("div", "node");
  row.dataset.id = id;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(state.selection === id));
  row.tabIndex = 0;

  const sw = el("i", "swatch");
  sw.style.background = swatch;
  const lab = el("span", "label", label);
  lab.title = label;
  row.append(sw, lab);

  row.addEventListener("click", () => select(id));
  row.addEventListener("keydown", ev => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      select(id);
    }
  });
  return row;
}

function head(title, count) {
  const h = el("div", "tree-head");
  h.appendChild(document.createTextNode(title));
  if (count !== undefined) {
    h.appendChild(el("div", "head-sp"));
    const add = el("button", null, "+ STL");
    add.title = "Upload STL file";
    add.addEventListener("click", ev => {
      ev.stopPropagation();
      document.dispatchEvent(new CustomEvent(EV_PICK_STL));
    });
    h.appendChild(add);
  }
  return h;
}

const note = text => el("div", "tree-empty", text);

/* ================================================================= drop zone */

function dropZone() {
  const zone = el("div", "drop-box");
  // The stylesheet sizes .drop-box for the viewport overlay; in the 216 px
  // sidebar it needs to be tighter, and it has to look clickable.
  zone.style.margin = "4px 12px 0";
  zone.style.padding = "13px 8px";
  zone.style.gap = "3px";
  zone.style.cursor = "pointer";
  zone.tabIndex = 0;
  zone.setAttribute("role", "button");
  zone.append(el("b", null, "Drop STL"), el("span", null, "or click to choose"));

  const pick = () => document.dispatchEvent(new CustomEvent(EV_PICK_STL));
  zone.addEventListener("click", pick);
  zone.addEventListener("keydown", ev => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      pick();
    }
  });

  const arm = on => { zone.style.background = on ? "var(--panel)" : ""; };
  zone.addEventListener("dragover", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    arm(true);
  });
  zone.addEventListener("dragleave", () => arm(false));
  zone.addEventListener("drop", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    arm(false);
    const files = ev.dataTransfer ? [...ev.dataTransfer.files] : [];
    if (files.length) {
      document.dispatchEvent(new CustomEvent(EV_STL_FILES, { detail: { files } }));
    }
  });
  return zone;
}

/* =================================================================== editing */

/**
 * Removes an object from the config and repairs everything that pointed at it:
 * the Reynolds reference and the current selection.
 * @returns {boolean} whether an object was actually removed
 */
export function removeObject(id) {
  const objects = state.config.objects || [];
  const index = objects.findIndex(o => o && o.id === id);
  if (index < 0) return false;

  const rest = objects.filter(o => o !== objects[index]);
  patch("objects", rest);

  const ref = state.config.reference;
  if (ref && ref.source === "object:" + id) patch("reference.source", "manual");

  if (state.selection === id) {
    const next = rest.length ? rest[Math.min(index, rest.length - 1)].id : "domain";
    select(next);
  }
  return true;
}

/* =================================================================== helpers */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
