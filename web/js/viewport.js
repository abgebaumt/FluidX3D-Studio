/**
 * The 3D view: renderer, scene, camera, lights and the render loop.
 *
 * World axes are the domain axes of CONTRACT.md — `+x` spanwise, `+y`
 * streamwise, `+z` up — in metres, with the domain's lower corner at the
 * origin. Camera and OrbitControls therefore use `+z` as up.
 *
 * This module owns the canvas and nothing else in the DOM.
 */
import {
  Scene, PerspectiveCamera, WebGLRenderer, Clock,
  Vector3, Color, Box3, MathUtils,
  AmbientLight, HemisphereLight, DirectionalLight
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** Up direction of the whole application. */
export const UP = new Vector3(0, 0, 1);

/* ==================================================================== palette */

const TOKENS = {
  ground: "--ground", surface: "--surface", panel: "--panel", sunken: "--sunken",
  line: "--line", lineSoft: "--line-soft", ink: "--ink", ink2: "--ink-2",
  muted: "--muted", faint: "--faint",
  fluid: "--fluid", solid: "--solid",
  ok: "--ok", warn: "--warn", crit: "--crit"
};

/** Light-theme values of app.css, used until the real tokens can be read. */
const FALLBACK = {
  ground: "#E4E6E1", surface: "#EFF1EC", panel: "#D8DBD3", sunken: "#CBCFC6",
  line: "#B9BEB3", lineSoft: "#C8CCC1", ink: "#171A18", ink2: "#414843",
  muted: "#6D746D", faint: "#939A92",
  fluid: "#0E7A85", solid: "#B08316",
  ok: "#377A4F", warn: "#B06E12", crit: "#A93A2A"
};

let cachedPalette = null;
const themeListeners = new Set();

/** Current colour tokens as CSS colour strings; app.css stays the only source. */
export function palette() {
  if (!cachedPalette) cachedPalette = readPalette();
  return cachedPalette;
}

function readPalette() {
  const out = { ...FALLBACK };
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const [key, token] of Object.entries(TOKENS)) {
      const raw = cs.getPropertyValue(token).trim();
      if (raw) out[key] = raw;
    }
  } catch {
    // no document (unit tests): the light tokens above are a valid palette
  }
  return out;
}

/** Called whenever light/dark switches, so the scene can recolour itself. */
export function onThemeChange(fn) {
  themeListeners.add(fn);
  return () => themeListeners.delete(fn);
}

function themeChanged() {
  cachedPalette = null;
  const p = palette();
  scene.background = new Color(p.sunken);
  for (const fn of [...themeListeners]) {
    try { fn(p); } catch (err) { console.error("Theme listener failed:", err); }
  }
}

/* ====================================================================== scene */

export const scene = new Scene();
scene.background = new Color(palette().sunken);

export const camera = new PerspectiveCamera(45, 1, 0.02, 200000);
camera.up.copy(UP);
camera.position.set(60, -90, 45);

/** Set by `initViewport`; importers see the live binding. */
export let renderer = null;
/** OrbitControls, set by `initViewport`. */
export let controls = null;

const ambient = new AmbientLight(0xffffff, 0.55);
const hemi = new HemisphereLight(0xdfe6ea, 0x4a4f45, 1.15);
hemi.position.set(0, 0, 1);
const key = new DirectionalLight(0xffffff, 1.5);
key.position.set(0.55, -0.85, 1.1).normalize();
const fill = new DirectionalLight(0xffffff, 0.45);
fill.position.set(-0.7, 0.6, 0.35).normalize();
scene.add(ambient, hemi, key, fill);

/* ================================================================ render loop */

const clock = new Clock();
const tickListeners = new Set();
let frameIndex = 0;

/** Registers a per-frame callback `(dt, elapsed, frame)`; returns an unsubscribe. */
export function onTick(fn) {
  if (typeof fn !== "function") throw new TypeError("onTick expects a function.");
  tickListeners.add(fn);
  return () => tickListeners.delete(fn);
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);   // a tab that was hidden must not jump
  const elapsed = clock.elapsedTime;
  frameIndex++;

  stepFlight(dt);
  if (controls) controls.update();

  for (const fn of [...tickListeners]) {
    // one broken tick must not stop the loop
    try { fn(dt, elapsed, frameIndex); } catch (err) { console.error("Tick failed:", err); }
  }

  if (renderer) renderer.render(scene, camera);
}

/* ============================================================ camera movement */

const flight = { active: false, t: 0, dur: 0.8, fromPos: new Vector3(), toPos: new Vector3(), fromTarget: new Vector3(), toTarget: new Vector3() };

const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function stepFlight(dt) {
  if (!flight.active || !controls) return;
  flight.t = Math.min(1, flight.t + dt / flight.dur);
  const k = ease(flight.t);
  camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
  controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
  if (flight.t >= 1) flight.active = false;
}

/**
 * Moves the camera to `position` while looking at `target`.
 * `immediate` skips the animation, e.g. for the very first framing.
 */
export function flyTo(target, position, immediate = false) {
  if (!controls) {
    camera.position.copy(position);
    camera.lookAt(target);
    return;
  }
  if (immediate) {
    flight.active = false;
    camera.position.copy(position);
    controls.target.copy(target);
    controls.update();
    return;
  }
  flight.fromPos.copy(camera.position);
  flight.fromTarget.copy(controls.target);
  flight.toPos.copy(position);
  flight.toTarget.copy(target);
  flight.t = 0;
  flight.active = true;
}

const _dir = new Vector3();
const _pos = new Vector3();
const _centre = new Vector3();
const _corner = new Vector3();
const _right = new Vector3();
const _top = new Vector3();

/**
 * Flies the camera so that `box` fills the view, keeping the current heading.
 *
 * The eight corners are fitted individually rather than the bounding sphere:
 * a sphere around a 36 × 60 × 18 m box is far bigger than the box itself and
 * would leave the domain — and anything inside it — a speck in the middle.
 */
export function frameBox(box, margin = 1.4, immediate = false) {
  if (!box || box.isEmpty()) return;
  box.getCenter(_centre);

  _dir.copy(camera.position).sub(controls ? controls.target : _centre);
  if (_dir.lengthSq() < 1e-9) _dir.set(0.6, -1, 0.55);
  _dir.normalize();                       // from the target towards the camera

  // screen axes for that heading
  _right.crossVectors(camera.up, _dir);
  if (_right.lengthSq() < 1e-9) _right.set(1, 0, 0);   // looking straight down
  _right.normalize();
  _top.crossVectors(_dir, _right).normalize();

  const tanV = Math.tan(MathUtils.degToRad(camera.fov) / 2);
  const tanH = tanV * Math.max(camera.aspect, 1e-3);
  const min = box.min, max = box.max;

  let distance = 0;
  for (let i = 0; i < 8; i++) {
    _corner
      .set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
      .sub(_centre);
    // a corner at depth d needs (distance − d) · tan ≥ its screen offset
    const depth = _corner.dot(_dir);
    const h = Math.abs(_corner.dot(_right)) * margin;
    const v = Math.abs(_corner.dot(_top)) * margin;
    distance = Math.max(distance, depth + v / tanV, depth + h / tanH);
  }

  _pos.copy(_centre).addScaledVector(_dir, Math.max(distance, 1e-3));
  flyTo(_centre.clone(), _pos.clone(), immediate);
}

/* ======================================================================= boot */

let container = null;
let observer = null;
let lastW = 0;
let lastH = 0;

function resize() {
  if (!renderer || !container) return;
  const w = Math.max(1, Math.floor(container.clientWidth));
  const h = Math.max(1, Math.floor(container.clientHeight));
  if (w === lastW && h === lastH) return;
  lastW = w;
  lastH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);   // the canvas is stretched by app.css
}

/**
 * Creates the renderer inside `element` and starts the loop.
 * Returns `null` when WebGL is unavailable — the editor stays usable.
 */
export function initViewport(element) {
  if (renderer) return { scene, camera, renderer, controls };
  if (!element) {
    console.error("initViewport: no container given.");
    return null;
  }

  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch (err) {
    console.error("The 3D view could not be started — WebGL is not available.", err);
    renderer = null;
    return null;
  }

  container = element;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(1, 1, false);
  renderer.setClearColor(new Color(palette().sunken), 1);
  element.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  controls.minDistance = 0.05;
  controls.maxDistance = 100000;
  controls.maxPolarAngle = Math.PI * 0.995;   // do not tumble past the ground
  controls.target.set(0, 0, 0);
  controls.update();

  // a lost context must not take the whole page down
  renderer.domElement.addEventListener("webglcontextlost", ev => {
    ev.preventDefault();
    console.error("The WebGL context was lost; the view is rebuilt as soon as the browser restores it.");
  });

  if (typeof ResizeObserver === "function") {
    observer = new ResizeObserver(resize);
    observer.observe(element);
  }
  window.addEventListener("resize", resize);
  resize();

  watchTheme();

  clock.start();
  renderer.setAnimationLoop(frame);

  return { scene, camera, renderer, controls };
}

function watchTheme() {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", themeChanged);
  } catch {
    // matchMedia missing: the palette simply stays as read
  }
  if (typeof MutationObserver === "function") {
    // the header's theme switch stamps data-theme on <html>
    new MutationObserver(themeChanged).observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-theme"]
    });
  }
}

/** Stops the loop and frees the GPU resources; used when the page tears down. */
export function disposeViewport() {
  if (observer) { observer.disconnect(); observer = null; }
  window.removeEventListener("resize", resize);
  if (renderer) {
    renderer.setAnimationLoop(null);
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    renderer.dispose();
    renderer = null;
  }
  if (controls) { controls.dispose(); controls = null; }
  container = null;
  lastW = 0;
  lastH = 0;
}

/* ==================================================================== helpers */

/** Frees geometries, materials and textures of a subtree, then empties it. */
export function disposeTree(root) {
  if (!root) return;
  const materials = new Set();
  root.traverse(node => {
    if (node.geometry) node.geometry.dispose();
    const m = node.material;
    if (Array.isArray(m)) m.forEach(x => materials.add(x));
    else if (m) materials.add(m);
  });
  for (const material of materials) {
    for (const key of ["map", "alphaMap", "normalMap", "emissiveMap", "roughnessMap"]) {
      const tex = material[key];
      if (tex && typeof tex.dispose === "function") tex.dispose();
    }
    material.dispose();
  }
  root.clear();
}

/** Axis-aligned box of the domain, in world units. */
export function domainBox(cfg) {
  const size = (cfg && cfg.domain && Array.isArray(cfg.domain.size_m)) ? cfg.domain.size_m : [1, 1, 1];
  const s = size.map(v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 1));
  return new Box3(new Vector3(0, 0, 0), new Vector3(s[0], s[1], s[2]));
}
