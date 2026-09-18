/**
 * Everything that draws the domain itself: wireframe box with dimensions,
 * ground grid, axis cross and the six boundary-condition faces.
 *
 * The domain occupies `[0,lx] x [0,ly] x [0,lz]`, so `position_frac` maps
 * straight onto world coordinates.
 *
 * The faces carry their boundary type as colour and hatching only. Their names
 * are written out in the inspector under "Boundaries", right next to the
 * dropdowns — six captions floating inside the box would sit on top of each
 * other and on top of the model.
 */
import {
  Group, BoxGeometry, EdgesGeometry, LineSegments, LineBasicMaterial,
  BufferGeometry, Float32BufferAttribute, PlaneGeometry, MeshBasicMaterial, Mesh,
  Sprite, SpriteMaterial, CanvasTexture, RepeatWrapping, DoubleSide,
  GridHelper, Color, Vector3, SRGBColorSpace
} from "three";

import { scene, palette, onThemeChange, disposeTree, domainBox, frameBox, onTick } from "./viewport.js";
import { state, subscribe } from "./state.js";
import { BOUNDARY_FACES } from "./schema.js";
import { nf } from "./derive.js";

/* ===================================================================== groups */

const root = new Group();
root.name = "domain";

const gBox = new Group();      // wireframe + dimensions
const gGrid = new Group();     // ground grid
const gAxes = new Group();     // axis cross
const gFaces = new Group();    // boundary conditions

root.add(gBox, gGrid, gAxes, gFaces);
scene.add(root);

/* ==================================================================== texture */

let hatchSource = null;

/** Diagonal hatching, drawn once and cloned per face so each can set its repeat. */
function hatchTexture() {
  if (hatchSource) return hatchSource;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  // two strokes so the pattern stays continuous across the tile seam
  for (const offset of [-size, 0]) {
    ctx.beginPath();
    ctx.moveTo(offset, size);
    ctx.lineTo(offset + size, 0);
    ctx.stroke();
  }
  hatchSource = new CanvasTexture(canvas);
  hatchSource.wrapS = RepeatWrapping;
  hatchSource.wrapT = RepeatWrapping;
  hatchSource.colorSpace = SRGBColorSpace;
  return hatchSource;
}

/** A text sprite of the given world height. */
function makeLabel(text, colour, worldHeight) {
  const pad = 12;
  const font = "600 44px ui-monospace, Consolas, monospace";
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width) + pad * 2;
  const height = 64;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, width);
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = colour;
  ctx.fillText(text, canvas.width / 2, height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, sizeAttenuation: true
  }));
  sprite.scale.set(worldHeight * canvas.width / canvas.height, worldHeight, 1);
  return sprite;
}

/* ====================================================================== build */

/** Colour of a boundary type — petrol for anything the fluid passes. */
function faceColour(type, p) {
  if (type === "solid") return p.solid;
  if (type === "periodic") return p.warn;
  if (type === "open") return p.muted;
  return p.fluid;   // equilibrium
}

/** Nice round grid step for the given extent. */
function gridStep(extent) {
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  const wanted = extent / 40;
  for (const s of steps) if (s >= wanted) return s;
  return steps[steps.length - 1];
}

function buildBox(lx, ly, lz, p) {
  const source = new BoxGeometry(lx, ly, lz);
  const edges = new EdgesGeometry(source);
  source.dispose();                                  // only the edges are kept
  const box = new LineSegments(edges, new LineBasicMaterial({ color: new Color(p.muted) }));
  box.position.set(lx / 2, ly / 2, lz / 2);
  gBox.add(box);

  const maxDim = Math.max(lx, ly, lz);
  const pad = maxDim * 0.05;
  const textHeight = maxDim * 0.028;
  const ink = p.ink2;
  const dimMat = new LineBasicMaterial({ color: new Color(p.faint) });

  // one dimension line per axis, offset outwards, with a label at its middle
  const dims = [
    { from: [0, -pad, 0], to: [lx, -pad, 0], at: [lx / 2, -pad * 1.7, 0], text: nf(lx, 1) + " m" },
    { from: [-pad, 0, 0], to: [-pad, ly, 0], at: [-pad * 1.7, ly / 2, 0], text: nf(ly, 1) + " m" },
    { from: [-pad, -pad, 0], to: [-pad, -pad, lz], at: [-pad * 1.7, -pad * 1.7, lz / 2], text: nf(lz, 1) + " m" }
  ];

  const points = [];
  for (const d of dims) {
    points.push(...d.from, ...d.to);
    const label = makeLabel(d.text, ink, textHeight);
    label.position.set(d.at[0], d.at[1], d.at[2]);
    gBox.add(label);
  }
  const dimGeo = new BufferGeometry();
  dimGeo.setAttribute("position", new Float32BufferAttribute(points, 3));
  gBox.add(new LineSegments(dimGeo, dimMat));
}

function buildGrid(lx, ly, p) {
  const extent = Math.max(lx, ly) * 1.8;
  const step = gridStep(extent);
  const divisions = Math.max(2, Math.round(extent / step));
  const size = divisions * step;

  const grid = new GridHelper(size, divisions, new Color(p.muted), new Color(p.faint));
  grid.rotation.x = Math.PI / 2;            // GridHelper lies in xz; ours is the xy plane
  grid.position.set(lx / 2, ly / 2, 0);
  grid.material.transparent = true;
  grid.material.opacity = 0.6;
  grid.material.depthWrite = false;
  gGrid.add(grid);
}

function buildAxes(lx, ly, lz, p) {
  const len = Math.max(lx, ly, lz) * 0.16;
  const textHeight = Math.max(lx, ly, lz) * 0.026;
  const axes = [
    { dir: [len, 0, 0], colour: p.crit, name: "x" },
    { dir: [0, len, 0], colour: p.fluid, name: "y" },
    { dir: [0, 0, len], colour: p.ok, name: "z" }
  ];
  for (const a of axes) {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute([0, 0, 0, ...a.dir], 3));
    gAxes.add(new LineSegments(geo, new LineBasicMaterial({ color: new Color(a.colour) })));
    const label = makeLabel(a.name, a.colour, textHeight);
    label.position.set(a.dir[0] * 1.14, a.dir[1] * 1.14, a.dir[2] * 1.14);
    gAxes.add(label);
  }
}

/** Geometry size, position and orientation of one box face. */
function faceLayout(face, lx, ly, lz) {
  switch (face) {
    case "xmin": return { w: lz, h: ly, pos: [0, ly / 2, lz / 2], rot: [0, Math.PI / 2, 0] };
    case "xmax": return { w: lz, h: ly, pos: [lx, ly / 2, lz / 2], rot: [0, Math.PI / 2, 0] };
    case "ymin": return { w: lx, h: lz, pos: [lx / 2, 0, lz / 2], rot: [-Math.PI / 2, 0, 0] };
    case "ymax": return { w: lx, h: lz, pos: [lx / 2, ly, lz / 2], rot: [-Math.PI / 2, 0, 0] };
    case "zmin": return { w: lx, h: ly, pos: [lx / 2, ly / 2, 0], rot: [0, 0, 0] };
    default: return { w: lx, h: ly, pos: [lx / 2, ly / 2, lz], rot: [0, 0, 0] };
  }
}

function buildFaces(cfg, lx, ly, lz, p) {
  const bc = cfg.boundaries || {};
  const maxDim = Math.max(lx, ly, lz);
  const tile = gridStep(maxDim) * 4;          // hatch density follows the ground grid

  for (const face of BOUNDARY_FACES) {
    const type = bc[face] || "equilibrium";
    const colour = new Color(faceColour(type, p));
    const l = faceLayout(face, lx, ly, lz);

    const tex = hatchTexture().clone();
    tex.needsUpdate = true;
    tex.repeat.set(Math.max(1, l.w / tile), Math.max(1, l.h / tile));

    // separate geometries so disposing the group frees each exactly once
    const tint = new Mesh(new PlaneGeometry(l.w, l.h), new MeshBasicMaterial({
      color: colour, transparent: true, opacity: 0.05,
      side: DoubleSide, depthWrite: false
    }));
    const hatch = new Mesh(new PlaneGeometry(l.w, l.h), new MeshBasicMaterial({
      color: colour, map: tex, transparent: true, opacity: 0.2,
      side: DoubleSide, depthWrite: false
    }));

    for (const mesh of [tint, hatch]) {
      mesh.position.set(l.pos[0], l.pos[1], l.pos[2]);
      mesh.rotation.set(l.rot[0], l.rot[1], l.rot[2]);
      mesh.renderOrder = 1;
      gFaces.add(mesh);
    }
  }
}

/* ===================================================================== update */

/** Everything the drawing depends on, so an unchanged config does not rebuild. */
function domainKey(cfg) {
  const d = cfg.domain || {};
  const bc = cfg.boundaries || {};
  return JSON.stringify([d.size_m, BOUNDARY_FACES.map(f => bc[f])]);
}

let lastKey = "";

/**
 * Rebuilds the domain display. Nothing happens when neither the size nor the
 * boundaries changed, so calling this on every config change is cheap — only
 * `force` (a theme switch) rebuilds regardless.
 */
export function updateDomain(cfg, force = false) {
  const config = cfg || state.config;
  const key = domainKey(config);
  if (!force && key === lastKey) return;
  lastKey = key;

  const p = palette();

  for (const g of [gBox, gGrid, gAxes, gFaces]) disposeTree(g);

  const box = domainBox(config);
  const size = new Vector3();
  box.getSize(size);
  const lx = size.x, ly = size.y, lz = size.z;

  buildBox(lx, ly, lz, p);
  buildGrid(lx, ly, p);
  buildAxes(lx, ly, lz, p);
  buildFaces(config, lx, ly, lz, p);

  applyVisibility();
}

function applyVisibility() {
  const view = (state.ui && state.ui.view) || {};
  gGrid.visible = view.grid !== false;
  gAxes.visible = view.axes !== false;
  gFaces.visible = view.bc !== false;
}

/* ====================================================================== camera */

/**
 * Puts the whole domain into the view. Called once at boot and whenever a
 * setup is loaded — never on an ordinary config change, because a camera that
 * jumps while a slider is being dragged makes the editor unusable.
 */
export function frameDomain(immediate = false) {
  frameBox(domainBox(state.config), 1.05, immediate);
}

/* ============================================================== subscriptions */

subscribe(reason => {
  if (reason === "ui") applyVisibility();
  else if (reason === "config") updateDomain(state.config);
});

onThemeChange(() => updateDomain(state.config, true));

// the first frame the renderer draws is the moment OrbitControls exist, so the
// initial framing has to wait for it
const stopFirstFraming = onTick(() => {
  stopFirstFraming();
  frameDomain(true);
});

updateDomain(state.config);
