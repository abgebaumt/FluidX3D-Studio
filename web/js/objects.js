/**
 * STL objects in the viewport: loading, placement, picking and the gizmo.
 *
 * Placement follows CONTRACT.md — `position_frac` is the object's centre as a
 * fraction of the domain, the rotation is `Rz(yaw)·Rx(pitch)·Ry(roll)` about
 * that centre, and `sizing` either fixes the longest bounding-box edge in
 * metres or multiplies the STL's own units.
 */
import {
  Group, Mesh, MeshStandardMaterial, Box3, Box3Helper, Vector2, Vector3,
  Matrix4, Color, Raycaster, MathUtils
} from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";

import {
  scene, camera, renderer, controls, palette, onThemeChange, onTick, frameBox
} from "./viewport.js";
import { state, subscribe, patch, select, selected } from "./state.js";
import { fetchStl } from "./api.js";
import { euler } from "./derive.js";

const GIZMO_MODES = ["translate", "rotate", "scale", "none"];

/* ================================================================== resources */

const group = new Group();
group.name = "objects";
scene.add(group);

/** objectId -> { mesh, key, baseLongest } */
const entries = new Map();
/** stl id -> centred BufferGeometry, shared by every object using that file */
const geometries = new Map();
/** stl id -> in-flight load, so a file is fetched once */
const loading = new Map();
/** stl ids whose load failed; cleared whenever the upload index changes */
const failed = new Set();

const loader = new STLLoader();

const materials = {
  solid: null,     // ochre, the normal appearance
  selected: null,  // the same ochre, lifted
  ghost: null      // disabled objects: present but not voxelised
};

function buildMaterials() {
  const p = palette();
  const ochre = new Color(p.solid);
  for (const m of Object.values(materials)) if (m) m.dispose();
  materials.solid = new MeshStandardMaterial({
    color: ochre, roughness: 0.62, metalness: 0.06, flatShading: false
  });
  materials.selected = new MeshStandardMaterial({
    color: ochre, roughness: 0.5, metalness: 0.08,
    emissive: new Color(p.solid).multiplyScalar(0.28)
  });
  materials.ghost = new MeshStandardMaterial({
    color: new Color(p.muted), roughness: 0.9, metalness: 0,
    transparent: true, opacity: 0.28, depthWrite: false
  });
}
buildMaterials();

const selectionBox = new Box3();
// ink, not petrol: petrol already means "fluid" everywhere else in the scene
const selectionHelper = new Box3Helper(selectionBox, new Color(palette().ink));
selectionHelper.visible = false;
selectionHelper.material.depthTest = false;
selectionHelper.material.transparent = true;
selectionHelper.material.opacity = 0.85;
selectionHelper.renderOrder = 3;
scene.add(selectionHelper);

/* ==================================================================== helpers */

const _m4 = new Matrix4();
const _box = new Box3();
const _vec = new Vector3();
const _ndc = new Vector2();
const raycaster = new Raycaster();

const round = (v, d) => {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
};

function domainSize(cfg) {
  const s = (cfg && cfg.domain && Array.isArray(cfg.domain.size_m)) ? cfg.domain.size_m : [1, 1, 1];
  return s.map(v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 1;
  });
}

/**
 * The `/api/stl` id belonging to a config `file` path. The index is the
 * authority; the file name is the fallback while the index is still loading.
 */
function stlIdFor(file) {
  if (typeof file !== "string" || !file) return null;
  const norm = file.replace(/\\/g, "/");
  const hit = (state.stlIndex || []).find(e => e && e.file === norm);
  if (hit) return hit.id;
  const base = norm.split("/").pop();
  return base || null;
}

async function geometryFor(stlId) {
  const cached = geometries.get(stlId);
  if (cached) return cached;
  const running = loading.get(stlId);
  if (running) return running;

  const job = (async () => {
    const buffer = await fetchStl(stlId);
    const geometry = loader.parse(buffer);
    geometry.computeBoundingBox();
    // transforms act about the object's own centre, so the geometry is centred
    const centre = new Vector3();
    geometry.boundingBox.getCenter(centre);
    geometry.translate(-centre.x, -centre.y, -centre.z);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    geometries.set(stlId, geometry);
    return geometry;
  })();

  loading.set(stlId, job);
  try {
    return await job;
  } finally {
    loading.delete(stlId);
  }
}

function scaleFor(obj, entry) {
  const sizing = obj.sizing || {};
  const value = Number(sizing.value);
  const v = Number.isFinite(value) && value > 0 ? value : 1;
  if (sizing.mode === "scale") return v;
  return v / (entry.baseLongest || 1);
}

function applyTransform(entry, obj, cfg) {
  const size = domainSize(cfg);
  const frac = Array.isArray(obj.position_frac) ? obj.position_frac : [0.5, 0.4, 0.5];
  entry.mesh.position.set(
    (Number(frac[0]) || 0) * size[0],
    (Number(frac[1]) || 0) * size[1],
    (Number(frac[2]) || 0) * size[2]
  );

  const rot = obj.rotation_deg || {};
  const m = euler(Number(rot.yaw) || 0, Number(rot.pitch) || 0, Number(rot.roll) || 0);
  _m4.set(
    m[0], m[3], m[6], 0,
    m[1], m[4], m[7], 0,
    m[2], m[5], m[8], 0,
    0, 0, 0, 1
  );
  entry.mesh.quaternion.setFromRotationMatrix(_m4);
  entry.mesh.scale.setScalar(scaleFor(obj, entry));
  entry.mesh.updateMatrixWorld(true);
}

function paint(entry, obj, isSelected) {
  entry.mesh.visible = obj.visible !== false;
  if (obj.enabled === false) entry.mesh.material = materials.ghost;
  else entry.mesh.material = isSelected ? materials.selected : materials.solid;
}

function removeEntry(objectId) {
  const entry = entries.get(objectId);
  if (!entry) return;
  if (gizmo && gizmo.object === entry.mesh) gizmo.detach();
  group.remove(entry.mesh);
  entries.delete(objectId);
  // the geometry is shared through `geometries` and stays cached
}

/* ======================================================================= sync */

/** Brings the meshes in line with the config; loads what is missing. */
export function syncObjects(cfg) {
  const config = cfg || state.config;
  const objects = Array.isArray(config.objects) ? config.objects : [];
  const alive = new Set();

  for (const obj of objects) {
    if (!obj || !obj.id) continue;
    alive.add(obj.id);

    const stlId = stlIdFor(obj.file);
    const entry = entries.get(obj.id);

    if (!stlId) { if (entry) removeEntry(obj.id); continue; }

    if (!entry || entry.key !== stlId) {
      if (entry) removeEntry(obj.id);
      ensureMesh(obj.id, stlId);
      continue;
    }
    if (!dragging || gizmo === null || gizmo.object !== entry.mesh) {
      applyTransform(entry, obj, config);
    }
    paint(entry, obj, obj.id === state.selection);
  }

  for (const id of [...entries.keys()]) if (!alive.has(id)) removeEntry(id);

  updateGizmo();
}

function ensureMesh(objectId, stlId) {
  // a file the server does not have must not be re-fetched on every change
  if (failed.has(stlId)) return;
  geometryFor(stlId).then(geometry => {
    const config = state.config;
    const obj = (config.objects || []).find(o => o.id === objectId);
    // the config may have moved on while the bytes were in flight
    if (!obj || stlIdFor(obj.file) !== stlId) return;
    const existing = entries.get(objectId);
    if (existing && existing.key === stlId) return;
    if (existing) removeEntry(objectId);

    const mesh = new Mesh(geometry, materials.solid);
    mesh.name = objectId;
    mesh.userData.objectId = objectId;

    const size = new Vector3();
    geometry.boundingBox.getSize(size);
    const entry = {
      mesh,
      key: stlId,
      baseLongest: Math.max(size.x, size.y, size.z) || 1
    };
    entries.set(objectId, entry);
    group.add(mesh);
    applyTransform(entry, obj, config);
    paint(entry, obj, objectId === state.selection);
    updateGizmo();
  }).catch(err => {
    if (failed.has(stlId)) return;   // several objects may share one broken file
    failed.add(stlId);
    console.error(`The geometry "${stlId}" could not be loaded: ${err && err.message ? err.message : err}`);
  });
}

/* ====================================================================== gizmo */

let gizmo = null;
let gizmoHelper = null;
let gizmoMode = "translate";
let dragging = false;
let picking = false;

function ensureGizmo() {
  if (gizmo) return gizmo;
  if (!renderer) return null;

  gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSpace("world");
  gizmo.setSize(0.85);
  gizmoHelper = gizmo.getHelper();
  gizmoHelper.renderOrder = 4;
  scene.add(gizmoHelper);

  gizmo.addEventListener("dragging-changed", ev => {
    dragging = !!ev.value;
    if (controls) controls.enabled = !dragging;
    if (!dragging) writeBack();      // final, exact values once the drag ends
  });
  gizmo.addEventListener("objectChange", () => {
    if (dragging) writeBack();
  });

  ensurePicking();
  return gizmo;
}

function updateGizmo() {
  const g = ensureGizmo();
  if (!g) return;
  const entry = entries.get(state.selection);
  const usable = entry && entry.mesh.visible && gizmoMode !== "none";
  if (usable) {
    g.setMode(gizmoMode);
    if (g.object !== entry.mesh) g.attach(entry.mesh);
    g.enabled = true;
    gizmoHelper.visible = true;
  } else {
    if (g.object) g.detach();
    g.enabled = false;
    gizmoHelper.visible = false;
  }
}

/** `"translate" | "rotate" | "scale" | "none"` */
export function setGizmoMode(mode) {
  gizmoMode = GIZMO_MODES.includes(mode) ? mode : "translate";
  updateGizmo();
  return gizmoMode;
}

/**
 * Extracts pitch/yaw/roll in degrees from a quaternion, inverting the
 * `Rz(yaw)·Rx(pitch)·Ry(roll)` order of the contract.
 */
function anglesFromQuaternion(q) {
  const e = _m4.makeRotationFromQuaternion(q).elements;   // column-major
  const r = (row, col) => e[col * 4 + row];

  const pitch = Math.asin(MathUtils.clamp(r(2, 1), -1, 1));
  const cp = Math.cos(pitch);
  let yaw, roll;
  if (Math.abs(cp) > 1e-6) {
    yaw = Math.atan2(-r(0, 1), r(1, 1));
    roll = Math.atan2(-r(2, 0), r(2, 2));
  } else {
    // pitch at ±90°: yaw and roll act on the same axis, so roll is given away
    yaw = Math.atan2(r(1, 0), r(0, 0));
    roll = 0;
  }
  return {
    pitch: MathUtils.radToDeg(pitch),
    yaw: MathUtils.radToDeg(yaw),
    roll: MathUtils.radToDeg(roll)
  };
}

/** Writes the dragged transform back into the config. */
function writeBack() {
  if (!gizmo || !gizmo.object) return;
  const objectId = gizmo.object.userData.objectId;
  const config = state.config;
  const index = (config.objects || []).findIndex(o => o && o.id === objectId);
  if (index < 0) return;
  const obj = config.objects[index];
  const entry = entries.get(objectId);
  if (!entry) return;

  const mode = gizmo.getMode();
  if (mode === "translate") {
    const size = domainSize(config);
    for (let i = 0; i < 3; i++) {
      patch(`objects.${index}.position_frac.${i}`, round(entry.mesh.position.getComponent(i) / size[i], 5));
    }
  } else if (mode === "rotate") {
    const a = anglesFromQuaternion(entry.mesh.quaternion);
    patch(`objects.${index}.rotation_deg.pitch`, round(a.pitch, 3));
    patch(`objects.${index}.rotation_deg.yaw`, round(a.yaw, 3));
    patch(`objects.${index}.rotation_deg.roll`, round(a.roll, 3));
  } else if (mode === "scale") {
    // the config knows one scale only, so the drag is folded into a uniform one
    const s = Math.max(1e-6, (entry.mesh.scale.x + entry.mesh.scale.y + entry.mesh.scale.z) / 3);
    entry.mesh.scale.setScalar(s);
    const isFactor = obj.sizing && obj.sizing.mode === "scale";
    patch(`objects.${index}.sizing.value`, round(isFactor ? s : s * entry.baseLongest, 6));
  }
}

/* ==================================================================== picking */

let pointerDown = null;

function ensurePicking() {
  if (picking || !renderer) return;
  picking = true;
  const el = renderer.domElement;
  el.addEventListener("pointerdown", ev => {
    // TransformControls listens first, so its axis is already set when a
    // gizmo handle was hit — that click must not reach the picker
    pointerDown = { x: ev.clientX, y: ev.clientY, onGizmo: !!(gizmo && gizmo.axis) };
  });
  el.addEventListener("pointerup", ev => {
    const start = pointerDown;
    pointerDown = null;
    if (!start || start.onGizmo || dragging || ev.button !== 0) return;
    // a drag of the camera must not count as a click
    if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) return;
    pick(ev);
  });
}

function pick(ev) {
  if (!renderer) return;
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  _ndc.set(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(_ndc, camera);
  const hits = raycaster.intersectObjects(group.children, false);
  const hit = hits.find(h => h.object && h.object.visible);
  if (hit) {
    select(hit.object.userData.objectId);
  } else if (selected().kind === "object") {
    select("domain");   // clicking into the void steps back to the domain
  }
}

/* ====================================================================== focus */

/** Flies the camera onto an object. Returns false when it is not loaded yet. */
export function focusObject(objectId) {
  const entry = entries.get(objectId);
  if (!entry || !entry.mesh.geometry.boundingBox) return false;
  entry.mesh.updateMatrixWorld(true);
  _box.copy(entry.mesh.geometry.boundingBox).applyMatrix4(entry.mesh.matrixWorld);
  if (_box.isEmpty()) return false;
  frameBox(_box, 1.2);
  return true;
}

/** World bounding boxes of the loaded objects — the flow field reads these. */
export function objectBounds() {
  const out = [];
  for (const [id, entry] of entries) {
    const geometry = entry.mesh.geometry;
    if (!geometry.boundingBox || !entry.mesh.visible) continue;
    entry.mesh.updateMatrixWorld(true);
    _box.copy(geometry.boundingBox).applyMatrix4(entry.mesh.matrixWorld);
    if (_box.isEmpty()) continue;
    const centre = _box.getCenter(new Vector3());
    const half = _box.getSize(new Vector3()).multiplyScalar(0.5);
    out.push({ id, centre: centre.toArray(), radii: half.toArray() });
  }
  return out;
}

/* ============================================================== subscriptions */

function refreshSelectionBox() {
  const entry = entries.get(state.selection);
  if (!entry || !entry.mesh.visible || !entry.mesh.geometry.boundingBox) {
    selectionHelper.visible = false;
    return;
  }
  entry.mesh.updateMatrixWorld(true);
  selectionBox.copy(entry.mesh.geometry.boundingBox).applyMatrix4(entry.mesh.matrixWorld);
  // a hair of air so the outline does not fight the surface
  selectionBox.getSize(_vec);
  selectionBox.expandByScalar(Math.max(_vec.x, _vec.y, _vec.z) * 0.01);
  selectionHelper.visible = true;
}

subscribe(reason => {
  if (reason === "config") {
    if (dragging) return;   // the gizmo owns the mesh while it is being dragged
    syncObjects(state.config);
  } else if (reason === "selection") {
    for (const [id, entry] of entries) {
      const obj = (state.config.objects || []).find(o => o.id === id);
      if (obj) paint(entry, obj, id === state.selection);
    }
    updateGizmo();
  } else if (reason === "stl") {
    failed.clear();   // a re-uploaded file deserves a second chance
    syncObjects(state.config);
  } else if (reason === "ui") {
    setGizmoMode(state.ui.gizmo);
  }
});

onThemeChange(() => {
  buildMaterials();
  selectionHelper.material.color = new Color(palette().ink);
  syncObjects(state.config);
});

onTick(() => {
  // cheap: the boxes come from the cached geometry bounds, not from the vertices
  refreshSelectionBox();
  if (!gizmo) updateGizmo();   // the renderer may appear after the first sync
});

syncObjects(state.config);
