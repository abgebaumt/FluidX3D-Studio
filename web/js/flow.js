/**
 * Streamline tracers.
 *
 * Particles drift through the domain along the inflow direction and are
 * deflected around the objects by potential flow past an ellipsoid — enough to
 * read the setup at a glance, and cheap enough to run every frame. They are
 * drawn as line segments in petrol whose opacity fades along the trail.
 *
 * The drawing speed is deliberately *not* the physical speed. A tracer always
 * needs roughly `CROSS_SECONDS` to travel through the box, no matter whether
 * the setup runs at 3 m/s or at 300 m/s — the configured speed only nudges
 * that a little. Otherwise a fast setup smears the whole box with streaks
 * while a slow one looks frozen.
 */
import {
  Group, BufferGeometry, BufferAttribute, LineSegments, LineBasicMaterial,
  Color, Vector3, NormalBlending
} from "three";

import { scene, palette, onThemeChange, onTick, domainBox } from "./viewport.js";
import { state, subscribe } from "./state.js";
import { windDir } from "./derive.js";
import { objectBounds } from "./objects.js";

const TRACERS = 120;
const TRAIL = 20;                 // points remembered per tracer
const SEGMENTS = TRAIL - 1;
const VERTICES = TRACERS * SEGMENTS * 2;

const CROSS_SECONDS = 7;          // seconds a tracer takes to cross the domain
const REFERENCE_SPEED = 30;       // m/s that leaves the drawing speed untouched
const MODULATION_MIN = 0.88;      // slowest a very calm setup may look — 8 s
const MODULATION_MAX = 1.16;      // fastest a very brisk setup may look — 6 s
const TRAIL_FRACTION = 0.04;      // visible streak, as a fraction of the diagonal
const MAX_SUBSTEPS = 4;           // integration steps per frame, at most

const LIFE_MIN = CROSS_SECONDS * 1.1;   // long enough to leave through a face
const LIFE_SPREAD = CROSS_SECONDS * 0.8;

const HEAD_ALPHA = 0.9;
const TAIL_EXPONENT = 2.2;        // how sharply the trail thins out towards its end
const FADE_IN = 0.25;             // seconds a fresh trail needs to become visible
const FADE_OUT = 0.4;             // seconds an expiring trail needs to disappear

/** Per-vertex taper of the trail, precomputed because it never changes. */
const TAPER = new Float32Array(TRAIL);
for (let i = 0; i < TRAIL; i++) TAPER[i] = Math.pow(1 - i / SEGMENTS, TAIL_EXPONENT);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* =================================================================== geometry */

const positions = new Float32Array(VERTICES * 3);
const colors = new Float32Array(VERTICES * 4);

const geometry = new BufferGeometry();
geometry.setAttribute("position", new BufferAttribute(positions, 3));
geometry.setAttribute("color", new BufferAttribute(colors, 4));   // itemSize 4 = per-vertex alpha

const material = new LineBasicMaterial({
  vertexColors: true, transparent: true, depthWrite: false,
  blending: NormalBlending
});

const lines = new LineSegments(geometry, material);
lines.frustumCulled = false;

const group = new Group();
group.name = "flow";
group.add(lines);
scene.add(group);

/* ====================================================================== state */

/** One tracer: a short trail of world points, newest first. */
const tracers = [];
for (let i = 0; i < TRACERS; i++) {
  tracers.push({ trail: new Float32Array(TRAIL * 3), age: 0, life: LIFE_MIN });
}

const field = {
  min: [0, 0, 0],
  max: [1, 1, 1],
  size: [1, 1, 1],
  dir: [0, 1, 0],
  /** Drawing speed in m/s — derived from the box, not from the setup. */
  speed: 1,
  /** Length of one integration step; one step is one trail point. */
  stepSeconds: 1 / 60,
  diagonal: 1
};

/** Ellipsoids standing in for the objects, refreshed from the loaded meshes. */
let obstacles = [];
let obstacleAge = 0;

let colour = new Color(palette().fluid);
/** Left-over frame time that did not fill a whole integration step. */
let carry = 0;

/* ==================================================================== helpers */

const _p = new Vector3();
const _v = new Vector3();
const _n = new Vector3();
const _u = new Vector3();

function refreshObstacles() {
  try {
    obstacles = objectBounds().map(b => {
      const r = b.radii.map(v => Math.max(v, field.diagonal * 1e-3));
      return {
        c: b.centre,
        r,
        // the perturbation is negligible beyond a few body radii
        cutoff: 4,
        mean: Math.cbrt(Math.max(r[0] * r[1] * r[2], 1e-9))
      };
    });
  } catch {
    obstacles = [];
  }
}

/** Velocity at `p` in m/s, written into `_v`. */
function sample(p) {
  const speed = field.speed;
  _v.set(field.dir[0] * speed, field.dir[1] * speed, field.dir[2] * speed);

  for (const o of obstacles) {
    // work in the space where the ellipsoid is a unit sphere
    const dx = (p.x - o.c[0]) / o.r[0];
    const dy = (p.y - o.c[1]) / o.r[1];
    const dz = (p.z - o.c[2]) / o.r[2];
    const r = Math.hypot(dx, dy, dz);
    if (r > o.cutoff) continue;

    const rr = Math.max(r, 1);
    if (r < 1e-6) { _n.set(field.dir[0], field.dir[1], field.dir[2]); }
    else _n.set(dx / r, dy / r, dz / r);

    // the free stream, transformed into the same space and kept at its speed
    _u.set(field.dir[0] / o.r[0], field.dir[1] / o.r[1], field.dir[2] / o.r[2]);
    if (_u.lengthSq() < 1e-12) continue;
    _u.normalize().multiplyScalar(speed);

    // v = U − (a³/2r³)(3(U·n)n − U) with a = 1
    const k = 0.5 / (rr * rr * rr);
    const un = _u.dot(_n);
    const px = -k * (3 * un * _n.x - _u.x);
    const py = -k * (3 * un * _n.y - _u.y);
    const pz = -k * (3 * un * _n.z - _u.z);

    // back into world proportions, keeping the magnitude
    _v.x += px * o.r[0] / o.mean;
    _v.y += py * o.r[1] / o.mean;
    _v.z += pz * o.r[2] / o.mean;
  }

  // a stalled tracer would sit in place forever
  const len = _v.length();
  const floor = speed * 0.12;
  if (len < floor) {
    if (len < 1e-9) _v.set(field.dir[0], field.dir[1], field.dir[2]).multiplyScalar(floor);
    else _v.multiplyScalar(floor / len);
  }
  return _v;
}

/** Pushes a point that ended up inside a body back onto its surface. */
function pushOut(p) {
  for (const o of obstacles) {
    const dx = (p.x - o.c[0]) / o.r[0];
    const dy = (p.y - o.c[1]) / o.r[1];
    const dz = (p.z - o.c[2]) / o.r[2];
    const r = Math.hypot(dx, dy, dz);
    if (r >= 1) continue;
    if (r < 1e-6) {
      p.set(o.c[0] + o.r[0] * 1.02, o.c[1], o.c[2]);
      continue;
    }
    const f = 1.02 / r;
    p.set(o.c[0] + dx * f * o.r[0], o.c[1] + dy * f * o.r[1], o.c[2] + dz * f * o.r[2]);
  }
}

function inside(p, margin) {
  return p.x >= field.min[0] - margin && p.x <= field.max[0] + margin
    && p.y >= field.min[1] - margin && p.y <= field.max[1] + margin
    && p.z >= field.min[2] - margin && p.z <= field.max[2] + margin;
}

/** Distance one may walk backwards along the inflow before leaving the box. */
function backwardsRoom(p) {
  let t = Infinity;
  for (let i = 0; i < 3; i++) {
    const d = field.dir[i];
    const x = p.getComponent(i);
    if (Math.abs(d) < 1e-9) continue;
    const limit = d > 0 ? (x - field.min[i]) / d : (field.max[i] - x) / -d;
    if (limit < t) t = limit;
  }
  return Number.isFinite(t) ? Math.max(0, t) : 0;
}

/**
 * Places a tracer. `spread` 1 scatters it through the whole box (first fill),
 * 0 puts it right at the inflow face (recycling).
 */
function seed(tracer, spread) {
  const inset = 0.02;
  _p.set(
    field.min[0] + field.size[0] * (inset + Math.random() * (1 - 2 * inset)),
    field.min[1] + field.size[1] * (inset + Math.random() * (1 - 2 * inset)),
    field.min[2] + field.size[2] * (inset + Math.random() * (1 - 2 * inset))
  );
  // walk back to the inflow face, then a fraction of the way forward again
  const room = backwardsRoom(_p);
  const forward = room * Math.random() * (spread > 0 ? spread : 0.02);
  const offset = room - forward;
  _p.x -= field.dir[0] * offset;
  _p.y -= field.dir[1] * offset;
  _p.z -= field.dir[2] * offset;

  pushOut(_p);
  for (let i = 0; i < TRAIL; i++) {
    tracer.trail[i * 3] = _p.x;
    tracer.trail[i * 3 + 1] = _p.y;
    tracer.trail[i * 3 + 2] = _p.z;
  }
  tracer.age = 0;
  tracer.life = LIFE_MIN + Math.random() * LIFE_SPREAD;
}

function seedAll() {
  for (const tracer of tracers) seed(tracer, 1);
}

/* ===================================================================== update */

let lastKey = "";

/** Reads domain and inflow out of the config; reseeds when the field changed. */
export function updateFlow(cfg) {
  const config = cfg || state.config;
  const box = domainBox(config);

  field.min = box.min.toArray();
  field.max = box.max.toArray();
  field.size = [
    field.max[0] - field.min[0],
    field.max[1] - field.min[1],
    field.max[2] - field.min[2]
  ];
  field.diagonal = Math.hypot(field.size[0], field.size[1], field.size[2]) || 1;

  const fluid = config.fluid || {};
  field.dir = windDir(fluid);
  const physical = Number(fluid.velocity_ms);
  const setpoint = Number.isFinite(physical) && physical > 0 ? physical : REFERENCE_SPEED;

  // longest way through the box along the inflow direction
  const span = Math.abs(field.dir[0]) * field.size[0]
    + Math.abs(field.dir[1]) * field.size[1]
    + Math.abs(field.dir[2]) * field.size[2];
  // a fourth root, tightly clamped: 3 m/s and 300 m/s stay clearly readable,
  // yet a faster setup still looks a touch faster
  const modulation = clamp(
    Math.pow(setpoint / REFERENCE_SPEED, 0.25), MODULATION_MIN, MODULATION_MAX
  );
  field.speed = Math.max(span, field.diagonal * 1e-3) / CROSS_SECONDS * modulation;

  // one step is one trail point, so the streak keeps its length at any frame rate
  field.stepSeconds = clamp(
    TRAIL_FRACTION * field.diagonal / (field.speed * SEGMENTS), 1 / 240, 1 / 20
  );

  const key = JSON.stringify([field.size, field.dir]);
  if (key !== lastKey) {
    lastKey = key;
    seedAll();
  }
  refreshObstacles();
  applyVisibility();
  writeBuffers();
}

function applyVisibility() {
  const view = (state.ui && state.ui.view) || {};
  group.visible = view.flow !== false;
}

/* ======================================================================= tick */

/**
 * Advances the tracers by `dt` seconds and rewrites the line buffer.
 * The advance runs in fixed steps, so the trails keep their length whether the
 * browser delivers 30 or 144 frames per second.
 */
export function tickFlow(dt) {
  if (!group.visible) return;
  const elapsed = Math.min(Math.max(Number(dt) || 0, 0), 1 / 20);
  if (elapsed <= 0) return;

  obstacleAge += elapsed;
  if (obstacleAge > 0.25) {
    obstacleAge = 0;
    refreshObstacles();   // meshes may still have been loading
  }

  // whatever a slow frame could not work off is dropped, not queued up
  carry = Math.min(carry + elapsed, field.stepSeconds * MAX_SUBSTEPS);
  let moved = false;
  while (carry >= field.stepSeconds) {
    carry -= field.stepSeconds;
    advance(field.stepSeconds);
    moved = true;
  }
  if (moved) writeBuffers();
}

/** One fixed integration step: every tracer gains exactly one trail point. */
function advance(step) {
  const maxStep = field.diagonal * 0.05;
  const margin = field.diagonal * 0.03;

  for (const tracer of tracers) {
    const trail = tracer.trail;
    _p.set(trail[0], trail[1], trail[2]);

    const v = sample(_p);
    let dx = v.x * step, dy = v.y * step, dz = v.z * step;
    const len = Math.hypot(dx, dy, dz);
    if (len > maxStep) {
      const f = maxStep / len;
      dx *= f; dy *= f; dz *= f;
    }
    _p.set(_p.x + dx, _p.y + dy, _p.z + dz);

    tracer.age += step;
    if (tracer.age > tracer.life || !inside(_p, margin)) {
      seed(tracer, 0);
      continue;
    }
    pushOut(_p);

    trail.copyWithin(3, 0, (TRAIL - 1) * 3);
    trail[0] = _p.x;
    trail[1] = _p.y;
    trail[2] = _p.z;
  }
}

function writeBuffers() {
  const r = colour.r, g = colour.g, b = colour.b;
  let pi = 0;
  let ci = 0;

  for (const tracer of tracers) {
    const trail = tracer.trail;
    const left = Math.max(0, tracer.life - tracer.age);
    const fade = HEAD_ALPHA
      * Math.min(1, tracer.age / FADE_IN)
      * Math.min(1, left / FADE_OUT);
    for (let s = 0; s < SEGMENTS; s++) {
      const a = s * 3;
      const c = (s + 1) * 3;
      positions[pi++] = trail[a];
      positions[pi++] = trail[a + 1];
      positions[pi++] = trail[a + 2];
      positions[pi++] = trail[c];
      positions[pi++] = trail[c + 1];
      positions[pi++] = trail[c + 2];

      const a0 = fade * TAPER[s];
      const a1 = fade * TAPER[s + 1];
      colors[ci++] = r; colors[ci++] = g; colors[ci++] = b; colors[ci++] = a0;
      colors[ci++] = r; colors[ci++] = g; colors[ci++] = b; colors[ci++] = a1;
    }
  }

  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.color.needsUpdate = true;
}

/* ============================================================== subscriptions */

subscribe(reason => {
  if (reason === "ui") { applyVisibility(); return; }
  if (reason === "config") updateFlow(state.config);
});

onThemeChange(() => { colour = new Color(palette().fluid); });

// the module owns its own life cycle — this is the only place `tickFlow` is
// hooked up, nobody else may register it a second time
onTick(dt => tickFlow(dt));

updateFlow(state.config);
