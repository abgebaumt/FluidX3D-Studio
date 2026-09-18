/**
 * Generates the example model shipped with FluidX3D Studio: a 15 m class
 * glider, built entirely from procedural geometry — no third-party model.
 *
 *   node scripts/make-example.js              writes examples/glider.stl and
 *                                             examples/glider-wind-tunnel.json
 *   node scripts/make-example.js --install    copies both into the configured
 *                                             data directory (generates them
 *                                             first if they are missing)
 *   node scripts/make-example.js --install --force
 *                                             overwrites a differing
 *                                             uploads/glider.stl or setup there
 *   node scripts/make-example.js --check      only verifies examples/glider.stl
 *
 * How the model is made
 * ---------------------
 * Every part is a signed distance function (negative inside, metres):
 * a fuselage of revolution with an elliptic cross-section, a canopy
 * ellipsoid, a tapered, slightly swept wing with dihedral and a NACA 00xx
 * section, and a T-tail. The parts are joined with a smooth minimum, which
 * also gives small fillets at the junctions. The field is sampled on a
 * structured grid whose spacing is fine only where the geometry needs it
 * (leading edges, thin tail surfaces) and which is sheared with the wing's
 * dihedral, then triangulated with marching cubes. Vertices are created once
 * per grid edge, so the result is a single closed, consistently oriented
 * 2-manifold by construction. A quadric edge-collapse pass then reduces it to
 * about 60 000 triangles, concentrated where the surface is curved.
 * `inspectStl()` checks the written file: every edge used exactly twice, in
 * opposite directions, one component, positive volume.
 *
 * Coordinates follow CONTRACT.md: +x spanwise, +y streamwise (the nose points
 * towards -y, into the flow), +z up. Units are metres. The output is fully
 * deterministic — no randomness, no timestamps in the file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MC_TRI_TABLE, writeBinaryStl } from "../server/mesh-surface.js";
import { parseStl } from "../server/stl-info.js";
import { defaultConfig, defaultSealing, validate } from "../server/schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXAMPLES_DIR = path.resolve(here, "..", "examples");
export const STL_NAME = "glider.stl";
export const SETUP_NAME = "glider-wind-tunnel";
export const STL_REF = `uploads/${STL_NAME}`; // relative to data/, as setups expect

const STL_HEADER = "FluidX3D Studio example glider (procedural, metres)";

/* ================================================================ geometry */

const DEG = Math.PI / 180;

/** Overall fuselage length; the nose sits at y = 0. */
const FUSELAGE_LENGTH = 7.0;

const WING = {
  semispan: 7.5,        // 15 m span
  rootChord: 0.95,
  breakSpan: 4.2,       // two trapezoidal panels, as on most 15 m gliders
  breakChord: 0.74,
  tipChord: 0.40,
  rootLE: 2.35,
  sweepInner: 0.02,     // leading edge moves aft by this much per metre of span
  sweepOuter: 0.055,
  rootThickness: 0.15,  // NACA 0015 at the root ...
  tipThickness: 0.13,   // ... NACA 0013 at the tip
  z0: 0.16,             // shoulder wing: root chord line above the fuselage axis
  dihedral: 3.0 * DEG
};

const FIN = {
  bottom: 0.0,          // buried in the tail boom
  top: 1.30,            // at the centre plane of the T-tail stabiliser
  rootLE: 5.88, rootChord: 1.02,
  topLE: 6.34, topChord: 0.54,
  thickness: 0.12
};

const STAB = {
  semispan: 1.30,
  rootLE: 6.32, rootChord: 0.60,
  tipLE: 6.47, tipChord: 0.36,
  z: FIN.top,
  thickness: 0.10
};

const CANOPY = { cx: 0, cy: 1.25, cz: 0.19, rx: 0.23, ry: 0.85, rz: 0.28 };

/** Blend radii of the smooth union, in metres. */
const BLEND = { canopy: 0.06, wing: 0.05, fin: 0.04, stab: 0.03 };

/** Beyond this distance from a part's box the part is not evaluated at all. */
const PRUNE_MARGIN = 0.15;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Polynomial smooth minimum: an exact min wherever |a - b| >= k. */
function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Distance from a point to an axis-aligned box, 0 inside. */
function boxDistance(x, y, z, b) {
  const dx = Math.max(b[0] - x, 0, x - b[3]);
  const dy = Math.max(b[1] - y, 0, y - b[4]);
  const dz = Math.max(b[2] - z, 0, z - b[5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/* ---------------------------------------------------------- NACA section */

/** Half thickness of a NACA 00xx section with closed trailing edge, chord 1. */
function nacaHalfThickness(u, t) {
  if (u <= 0 || u >= 1) return 0;
  return 5 * t * (0.2969 * Math.sqrt(u) - 0.1260 * u - 0.3516 * u * u + 0.2843 * u * u * u - 0.1036 * u * u * u * u);
}

/**
 * Thickness the tabulated section is normalised to. Sections of another
 * thickness are obtained by stretching the vertical coordinate, which keeps
 * the sign exact and the distance within a few percent.
 */
const T_REF = 0.14;

const TABLE_U0 = -0.1, TABLE_U1 = 1.1;
const TABLE_V1 = 0.12;
const TABLE_STEP = 0.0015;
const TABLE_NU = Math.round((TABLE_U1 - TABLE_U0) / TABLE_STEP) + 1;
const TABLE_NV = Math.round(TABLE_V1 / TABLE_STEP) + 1;

/**
 * Signed 2D distance to the reference section, tabulated once over
 * (u, |v|) — the section is symmetric, so the upper contour suffices.
 */
const SECTION_TABLE = buildSectionTable();

function buildSectionTable() {
  const points = 161;
  const pu = new Float64Array(points);
  const pv = new Float64Array(points);
  for (let i = 0; i < points; i++) {
    const u = 0.5 * (1 - Math.cos(Math.PI * i / (points - 1))); // cosine spacing
    pu[i] = u;
    pv[i] = nacaHalfThickness(u, T_REF);
  }

  const table = new Float32Array(TABLE_NU * TABLE_NV);
  for (let b = 0; b < TABLE_NV; b++) {
    const v = b * TABLE_STEP;
    for (let a = 0; a < TABLE_NU; a++) {
      const u = TABLE_U0 + a * TABLE_STEP;
      let best = Infinity;
      for (let i = 0; i < points - 1; i++) {
        const ex = pu[i + 1] - pu[i], ey = pv[i + 1] - pv[i];
        const wx = u - pu[i], wy = v - pv[i];
        const s = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
        const dx = wx - s * ex, dy = wy - s * ey;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      const inside = u > 0 && u < 1 && v < nacaHalfThickness(u, T_REF);
      table[a + TABLE_NU * b] = inside ? -Math.sqrt(best) : Math.sqrt(best);
    }
  }
  return table;
}

/** Signed distance to the reference section in chord units (bilinear lookup). */
function section(u, v) {
  v = Math.abs(v);
  const cu = clamp(u, TABLE_U0, TABLE_U1);
  const cv = Math.min(v, TABLE_V1);
  const outside = Math.hypot(u - cu, v - cv); // beyond the table: a safe positive bound

  const fa = (cu - TABLE_U0) / TABLE_STEP;
  const fb = cv / TABLE_STEP;
  const a = Math.min(Math.floor(fa), TABLE_NU - 2);
  const b = Math.min(Math.floor(fb), TABLE_NV - 2);
  const ta = fa - a, tb = fb - b;
  const i = a + TABLE_NU * b;
  const d = (SECTION_TABLE[i] * (1 - ta) + SECTION_TABLE[i + 1] * ta) * (1 - tb)
    + (SECTION_TABLE[i + TABLE_NU] * (1 - ta) + SECTION_TABLE[i + TABLE_NU + 1] * ta) * tb;
  return d + outside;
}

/* ------------------------------------------------------------------ parts */

/** Fuselage radius (vertical semi-axis) along the length. */
function fuselageRadius(y) {
  if (y <= 0 || y >= FUSELAGE_LENGTH) return 0;
  if (y < 1.55) {                                   // rounded nose
    const t = 1 - y / 1.55;
    return 0.34 * Math.sqrt(1 - t * t);
  }
  if (y < 3.2) return 0.34 - 0.04 * smoothstep(1.55, 3.2, y); // cockpit pod
  if (y < 6.7) {                                    // tail boom
    const t = (y - 3.2) / 3.5;
    const w = Math.pow((1 + Math.cos(Math.PI * t)) / 2, 1.4);
    return 0.085 + (0.30 - 0.085) * w;
  }
  const t = (y - 6.7) / (FUSELAGE_LENGTH - 6.7);    // rounded tail end
  return 0.085 * Math.sqrt(Math.max(0, 1 - t * t));
}

/** The boom rises slightly towards the tail. */
function fuselageAxisZ(y) {
  return 0.07 * smoothstep(3.0, 6.8, y);
}

function fuselage(x, y, z) {
  const d = Math.hypot(x / 0.86, z - fuselageAxisZ(y)) - fuselageRadius(y);
  return Math.max(d, -y, y - FUSELAGE_LENGTH);
}

/** Ellipsoid bound after Quilez: exact sign, distance-like near the surface. */
function canopy(x, y, z) {
  const px = (x - CANOPY.cx) / CANOPY.rx, py = (y - CANOPY.cy) / CANOPY.ry, pz = (z - CANOPY.cz) / CANOPY.rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const qx = px / CANOPY.rx, qy = py / CANOPY.ry, qz = pz / CANOPY.rz;
  const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -Math.min(CANOPY.rx, CANOPY.ry, CANOPY.rz);
}

function wingChord(s) {
  if (s <= WING.breakSpan) return WING.rootChord + (WING.breakChord - WING.rootChord) * (s / WING.breakSpan);
  return WING.breakChord + (WING.tipChord - WING.breakChord) * ((s - WING.breakSpan) / (WING.semispan - WING.breakSpan));
}

function wingLeadingEdge(s) {
  return WING.rootLE + WING.sweepInner * s + WING.sweepOuter * Math.max(0, s - WING.breakSpan);
}

function wing(x, y, z) {
  const s = Math.abs(x);
  const sc = Math.min(s, WING.semispan);
  const c = wingChord(sc);
  const t = WING.rootThickness + (WING.tipThickness - WING.rootThickness) * (sc / WING.semispan);
  const zr = WING.z0 + sc * Math.tan(WING.dihedral);
  const d = c * section((y - wingLeadingEdge(sc)) / c, ((z - zr) / c) * (T_REF / t));
  return Math.max(d, s - WING.semispan); // flat tip cap
}

function fin(x, y, z) {
  const h = clamp((z - FIN.bottom) / (FIN.top - FIN.bottom), 0, 1);
  const le = FIN.rootLE + (FIN.topLE - FIN.rootLE) * h;
  const c = FIN.rootChord + (FIN.topChord - FIN.rootChord) * h;
  const d = c * section((y - le) / c, (x / c) * (T_REF / FIN.thickness));
  return Math.max(d, z - FIN.top, FIN.bottom - z);
}

function stab(x, y, z) {
  const s = Math.abs(x);
  const sc = Math.min(s, STAB.semispan);
  const f = sc / STAB.semispan;
  const le = STAB.rootLE + (STAB.tipLE - STAB.rootLE) * f;
  const c = STAB.rootChord + (STAB.tipChord - STAB.rootChord) * f;
  const d = c * section((y - le) / c, ((z - STAB.z) / c) * (T_REF / STAB.thickness));
  return Math.max(d, s - STAB.semispan);
}

/** Part boxes [xmin, ymin, zmin, xmax, ymax, zmax] used to skip far parts. */
const BOX = {
  body: [-0.31, -0.01, -0.37, 0.31, FUSELAGE_LENGTH + 0.01, 0.46],
  wing: [-WING.semispan, 2.34, 0.07, WING.semispan, 3.32, 0.57],
  fin: [-0.08, 5.87, FIN.bottom, 0.08, 6.95, FIN.top],
  stab: [-STAB.semispan, 6.31, 1.25, STAB.semispan, 6.95, 1.35]
};

function part(fn, box, x, y, z) {
  const far = boxDistance(x, y, z, box);
  return far > PRUNE_MARGIN ? far : fn(x, y, z);
}

/** Signed distance of the whole glider, metres, negative inside. */
export function gliderField(x, y, z) {
  let d = part((px, py, pz) => smin(fuselage(px, py, pz), canopy(px, py, pz), BLEND.canopy), BOX.body, x, y, z);
  d = smin(d, part(wing, BOX.wing, x, y, z), BLEND.wing);
  d = smin(d, part(fin, BOX.fin, x, y, z), BLEND.fin);
  d = smin(d, part(stab, BOX.stab, x, y, z), BLEND.stab);
  return d;
}

/* ================================================================== grid */

/**
 * Grid lines from `lo` through a list of bands [to, spacing]. Every band
 * boundary is itself a grid line, so a band can be anchored exactly on a
 * feature; `coarsen` scales every spacing.
 */
function gridLines(lo, bands, coarsen) {
  const out = [lo];
  let from = lo;
  for (const [to, spacing] of bands) {
    const steps = Math.max(1, Math.ceil((to - from) / (spacing * coarsen) - 1e-9));
    for (let s = 1; s <= steps; s++) out.push(from + ((to - from) * s) / steps);
    from = to;
  }
  return Float64Array.from(out);
}

/** Mirrors lines given for x >= 0 onto the negative side; x = 0 is a line. */
function symmetricLines(bands, coarsen) {
  const pos = gridLines(0, bands, coarsen);
  const out = new Float64Array(pos.length * 2 - 1);
  for (let i = 0; i < pos.length; i++) {
    out[pos.length - 1 - i] = -pos[i];
    out[pos.length - 1 + i] = pos[i];
  }
  return out;
}

/** The shear stops below the tail, so the stabiliser keeps a level grid. */
const SHEAR_FULL_BELOW = 0.62;
const SHEAR_NONE_ABOVE = 1.20;

/**
 * Vertical offset of the grid nodes: the grid is sheared with the wing's
 * dihedral, so the wing's chord plane lies on one grid layer along the whole
 * span. Thin trailing edges and the wing tip are then sampled on their centre
 * plane instead of flickering between layers, which would leave a saw-tooth
 * edge. The shear fades out towards the T-tail; its slope stays well below
 * one, so no cell is ever inverted.
 */
function gridShear(x, z) {
  const fade = clamp((SHEAR_NONE_ABOVE - z) / (SHEAR_NONE_ABOVE - SHEAR_FULL_BELOW), 0, 1);
  return Math.abs(x) * Math.tan(WING.dihedral) * fade;
}

/**
 * The sampling grid. Fine only where it matters: around the fuselage and fin
 * in x, at the leading edges in y, through the wing and stabiliser in z.
 * Grid lines sit exactly on the symmetry plane (the fin), on the wing's chord
 * plane (z = WING.z0 in sheared coordinates) and on the stabiliser's.
 * @param {number} coarsen 1 for the shipped model, larger for quick tests
 */
export function gliderGrid(coarsen = 1) {
  return {
    xs: symmetricLines([[0.35, 0.009], [1.40, 0.020], [7.62, 0.055]], coarsen),
    ys: gridLines(-0.06, [
      [0.25, 0.008],   // nose
      [2.25, 0.025],   // cockpit pod
      [2.70, 0.006],   // wing leading edge
      [3.40, 0.016],   // wing trailing edge
      [5.80, 0.030],   // tail boom
      [6.52, 0.008],   // fin and stabiliser leading edges
      [FUSELAGE_LENGTH + 0.06, 0.012]
    ], coarsen),
    zs: gridLines(-0.40, [
      [0.06, 0.015],   // lower fuselage
      [WING.z0, 0.006], // wing, lower half
      [0.26, 0.006],   // wing, upper half
      [0.50, 0.010],   // upper fuselage and canopy
      [1.22, 0.030],   // fin
      [STAB.z, 0.004], // stabiliser, lower half
      [1.36, 0.004],   // stabiliser, upper half
      [1.40, 0.020]
    ], coarsen),
    shear: gridShear
  };
}

/* ======================================================== marching cubes */

class GrowingArray {
  constructor(Type, capacity = 1 << 16) {
    this.Type = Type;
    this.data = new Type(capacity);
    this.length = 0;
  }
  push3(a, b, c) {
    if (this.length + 3 > this.data.length) {
      const grown = new this.Type(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

/** Keeps a surface vertex off the grid nodes, so no two vertices coincide. */
const T_MIN = 0.01;

/**
 * Marching cubes over a scalar field on a structured grid, processed one
 * z-slab at a time so memory stays at a few grid layers. Node (i, j, k) sits
 * at (xs[i], ys[j], zs[k] + shear(xs[i], zs[k])); without a shear the grid is
 * rectilinear. The table only looks at signs, so a sheared grid triangulates
 * exactly like a regular one.
 *
 * Every surface vertex belongs to exactly one grid edge and is created once,
 * shared by all cubes around that edge. With the face-consistent table from
 * server/mesh-surface.js this yields a closed 2-manifold; the winding puts
 * the normals on the positive (outside) side.
 *
 * @param {(x:number, y:number, z:number) => number} field negative inside
 * @param {(x:number, z:number) => number} [shear] vertical node offset
 * @returns {{ positions: Float64Array, indices: Uint32Array }}
 */
export function marchingCubes(field, xs, ys, zs, shear = () => 0) {
  const nx = xs.length, ny = ys.length, nz = zs.length;
  const layer = nx * ny;
  let zn0 = new Float64Array(nx), zn1 = new Float64Array(nx); // node heights per column
  let f0 = new Float64Array(layer), f1 = new Float64Array(layer);
  let xe0 = new Int32Array(layer), xe1 = new Int32Array(layer);
  let ye0 = new Int32Array(layer), ye1 = new Int32Array(layer);
  const ze = new Int32Array(layer);
  const edge = new Int32Array(12);

  const pos = new GrowingArray(Float64Array);
  const tri = new GrowingArray(Uint32Array);

  function vertex(ax, ay, az, bx, by, bz, fa, fb) {
    const t = clamp(fa / (fa - fb), T_MIN, 1 - T_MIN);
    pos.push3(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az));
    return pos.length / 3 - 1;
  }

  function sampleLayer(f, zn, k) {
    for (let i = 0; i < nx; i++) zn[i] = zs[k] + shear(xs[i], zs[k]);
    for (let j = 0; j < ny; j++) {
      const y = ys[j];
      for (let i = 0; i < nx; i++) f[i + nx * j] = field(xs[i], y, zn[i]);
    }
  }

  function layerEdges(f, zn, xe, ye) {
    xe.fill(-1);
    ye.fill(-1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + nx * j;
        const a = f[idx];
        if (i + 1 < nx) {
          const b = f[idx + 1];
          if ((a < 0) !== (b < 0)) xe[idx] = vertex(xs[i], ys[j], zn[i], xs[i + 1], ys[j], zn[i + 1], a, b);
        }
        if (j + 1 < ny) {
          const b = f[idx + nx];
          if ((a < 0) !== (b < 0)) ye[idx] = vertex(xs[i], ys[j], zn[i], xs[i], ys[j + 1], zn[i], a, b);
        }
      }
    }
  }

  sampleLayer(f0, zn0, 0);
  layerEdges(f0, zn0, xe0, ye0);

  for (let k = 0; k + 1 < nz; k++) {
    sampleLayer(f1, zn1, k + 1);
    layerEdges(f1, zn1, xe1, ye1);

    ze.fill(-1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = i + nx * j;
        const a = f0[idx], b = f1[idx];
        if ((a < 0) !== (b < 0)) ze[idx] = vertex(xs[i], ys[j], zn0[i], xs[i], ys[j], zn1[i], a, b);
      }
    }

    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const idx = i + nx * j;
        // Lorensen corner order; a set bit marks a corner OUTSIDE the body,
        // matching the table's "below the iso value" convention.
        const cube =
          (f0[idx] >= 0 ? 1 : 0) | (f0[idx + 1] >= 0 ? 2 : 0) |
          (f0[idx + 1 + nx] >= 0 ? 4 : 0) | (f0[idx + nx] >= 0 ? 8 : 0) |
          (f1[idx] >= 0 ? 16 : 0) | (f1[idx + 1] >= 0 ? 32 : 0) |
          (f1[idx + 1 + nx] >= 0 ? 64 : 0) | (f1[idx + nx] >= 0 ? 128 : 0);
        if (cube === 0 || cube === 255) continue;

        edge[0] = xe0[idx]; edge[1] = ye0[idx + 1]; edge[2] = xe0[idx + nx]; edge[3] = ye0[idx];
        edge[4] = xe1[idx]; edge[5] = ye1[idx + 1]; edge[6] = xe1[idx + nx]; edge[7] = ye1[idx];
        edge[8] = ze[idx]; edge[9] = ze[idx + 1]; edge[10] = ze[idx + 1 + nx]; edge[11] = ze[idx + nx];

        const row = cube * 16;
        for (let s = 0; s < 16 && MC_TRI_TABLE[row + s] >= 0; s += 3) {
          tri.push3(edge[MC_TRI_TABLE[row + s]], edge[MC_TRI_TABLE[row + s + 1]], edge[MC_TRI_TABLE[row + s + 2]]);
        }
      }
    }

    [f0, f1] = [f1, f0];
    [xe0, xe1] = [xe1, xe0];
    [ye0, ye1] = [ye1, ye0];
    [zn0, zn1] = [zn1, zn0];
  }

  return { positions: pos.view().slice(), indices: tri.view().slice() };
}

/* ============================================================ decimation */

/**
 * Min-heap of edge candidates in typed arrays. Entries are append-only; an
 * entry goes stale when either endpoint changes, which is detected on pop
 * through the per-vertex stamps stored with it.
 */
class EdgeHeap {
  constructor(capacity) {
    this.cost = new Float64Array(capacity);
    this.u = new Int32Array(capacity);
    this.v = new Int32Array(capacity);
    this.su = new Int32Array(capacity);
    this.sv = new Int32Array(capacity);
    this.heap = new Int32Array(capacity);
    this.entries = 0;
    this.size = 0;
  }

  grow() {
    const cap = this.cost.length * 2;
    for (const key of ["cost", "u", "v", "su", "sv", "heap"]) {
      const next = new this[key].constructor(cap);
      next.set(this[key]);
      this[key] = next;
    }
  }

  /** Strict order with the entry index as tie-break keeps the run deterministic. */
  less(a, b) {
    return this.cost[a] < this.cost[b] || (this.cost[a] === this.cost[b] && a < b);
  }

  push(cost, u, v, su, sv) {
    if (this.entries === this.cost.length) this.grow();
    const e = this.entries++;
    this.cost[e] = cost; this.u[e] = u; this.v[e] = v; this.su[e] = su; this.sv[e] = sv;
    const h = this.heap;
    let i = this.size++;
    h[i] = e;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  pop() {
    const h = this.heap;
    const top = h[0];
    h[0] = h[--this.size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.size && this.less(h[l], h[m])) m = l;
      if (r < this.size && this.less(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
    return top;
  }
}

/** A collapse may turn a face by at most this much (cosine of the angle). */
const MIN_NORMAL_COS = 0.25;

/**
 * Quadric error metric edge collapse (Garland & Heckbert) on a closed
 * manifold. Marching cubes spends triangles evenly over the surface; this
 * moves them to where the curvature is — leading edges, junctions — and
 * leaves long, flat triangles along the wing span.
 *
 * Every collapse keeps the mesh a closed 2-manifold of the same genus: the
 * link condition (u and v share exactly the two vertices opposite their
 * common edge) rules out pinches, and a normal check rules out fold-overs.
 *
 * @returns {{ positions: Float64Array, indices: Uint32Array }}
 */
export function decimate(mesh, targetTriangles) {
  const P = Float64Array.from(mesh.positions);
  const tri = Int32Array.from(mesh.indices);
  const V = P.length / 3;
  const T = tri.length / 3;

  const triAlive = new Uint8Array(T).fill(1);
  const vertAlive = new Uint8Array(V).fill(1);
  const stamp = new Int32Array(V);
  const mark = new Int32Array(V).fill(-1);
  const Q = new Float64Array(V * 10);
  const vtris = Array.from({ length: V }, () => []);

  // Area-weighted plane quadrics, accumulated at the corners.
  for (let t = 0; t < T; t++) {
    const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    vtris[a].push(t); vtris[b].push(t); vtris[c].push(t);
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len === 0) continue;
    const w = len / 2;
    nx /= len; ny /= len; nz /= len;
    const d = -(nx * P[a * 3] + ny * P[a * 3 + 1] + nz * P[a * 3 + 2]);
    const k = [nx * nx, nx * ny, nx * nz, nx * d, ny * ny, ny * nz, ny * d, nz * nz, nz * d, d * d];
    for (const v of [a, b, c]) {
      for (let i = 0; i < 10; i++) Q[v * 10 + i] += w * k[i];
    }
  }

  const q = new Float64Array(10);
  const best = new Float64Array(3);

  function quadricError(x, y, z) {
    return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
      + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
      + q[7] * z * z + 2 * q[8] * z + q[9];
  }

  /** Cost of collapsing u-v; the target position is left in `best`. */
  function evaluate(u, v) {
    for (let i = 0; i < 10; i++) q[i] = Q[u * 10 + i] + Q[v * 10 + i];
    const ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2];
    const vx = P[v * 3], vy = P[v * 3 + 1], vz = P[v * 3 + 2];
    const mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2;
    const edgeLength = Math.hypot(ux - vx, uy - vy, uz - vz);

    // Solve A x = -b for the optimum; accept it only when A is well
    // conditioned and the point stays near the edge.
    const a00 = q[0], a01 = q[1], a02 = q[2], a11 = q[4], a12 = q[5], a22 = q[7];
    const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    const trace = a00 + a11 + a22;
    if (trace > 0 && Math.abs(det) > 1e-6 * trace * trace * trace) {
      const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
      const bx = -q[3], by = -q[6], bz = -q[8];
      const x = (c00 * bx + c01 * by + c02 * bz) / det;
      const y = (c01 * bx + c11 * by + c12 * bz) / det;
      const z = (c02 * bx + c12 * by + c22 * bz) / det;
      if (Math.hypot(x - mx, y - my, z - mz) <= edgeLength) {
        best[0] = x; best[1] = y; best[2] = z;
        return Math.max(0, quadricError(x, y, z));
      }
    }
    let cost = Infinity;
    for (const [x, y, z] of [[mx, my, mz], [ux, uy, uz], [vx, vy, vz]]) {
      const e = quadricError(x, y, z);
      if (e < cost) { cost = e; best[0] = x; best[1] = y; best[2] = z; }
    }
    return Math.max(0, cost);
  }

  const heap = new EdgeHeap(T * 2);
  const push = (u, v) => heap.push(evaluate(u, v), u, v, stamp[u], stamp[v]);
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = tri[t * 3 + e], b = tri[t * 3 + ((e + 1) % 3)];
      if (a < b) push(a, b); // each edge of a closed mesh appears once this way round
    }
  }

  function neighbours(v, out) {
    out.length = 0;
    for (const t of vtris[v]) {
      if (!triAlive[t]) continue;
      for (let e = 0; e < 3; e++) {
        const w = tri[t * 3 + e];
        if (w !== v && !out.includes(w)) out.push(w);
      }
    }
    return out;
  }

  /** Would triangle t still face the same way with `from` moved to (x, y, z)? */
  function keepsOrientation(t, from, x, y, z) {
    const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const n = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let e = 0; e < 3; e++) {
      const w = tri[t * 3 + e];
      c[e * 3] = P[w * 3]; c[e * 3 + 1] = P[w * 3 + 1]; c[e * 3 + 2] = P[w * 3 + 2];
      if (w === from) { n[e * 3] = x; n[e * 3 + 1] = y; n[e * 3 + 2] = z; }
      else { n[e * 3] = c[e * 3]; n[e * 3 + 1] = c[e * 3 + 1]; n[e * 3 + 2] = c[e * 3 + 2]; }
    }
    const before = normalOf(c), after = normalOf(n);
    const lb = Math.hypot(before[0], before[1], before[2]);
    const la = Math.hypot(after[0], after[1], after[2]);
    if (la < 1e-12 || lb === 0) return false;
    return (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (la * lb) >= MIN_NORMAL_COS;
  }

  const nu = [], nv = [];
  let collapseId = 0;

  function canCollapse(u, v, x, y, z) {
    neighbours(u, nu);
    neighbours(v, nv);
    collapseId++;
    for (const w of nu) mark[w] = collapseId;
    let common = 0;
    for (const w of nv) if (mark[w] === collapseId) common++;
    if (common !== 2) return false;              // link condition
    if (nu.length + nv.length - 4 < 3) return false; // would leave a degenerate fan
    for (const [from, other] of [[u, v], [v, u]]) {
      for (const t of vtris[from]) {
        if (!triAlive[t]) continue;
        const a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
        if (a === other || b === other || c === other) continue; // removed by the collapse
        if (!keepsOrientation(t, from, x, y, z)) return false;
      }
    }
    return true;
  }

  function collapse(u, v, x, y, z) {
    const touched = [];
    for (const t of vtris[v]) {
      if (!triAlive[t]) continue;
      let hasU = false;
      for (let e = 0; e < 3; e++) if (tri[t * 3 + e] === u) hasU = true;
      if (hasU) {
        triAlive[t] = 0;
        for (let e = 0; e < 3; e++) {
          const w = tri[t * 3 + e];
          if (w !== u && w !== v) touched.push(w);
        }
      } else {
        for (let e = 0; e < 3; e++) if (tri[t * 3 + e] === v) tri[t * 3 + e] = u;
      }
    }
    P[u * 3] = x; P[u * 3 + 1] = y; P[u * 3 + 2] = z;
    for (let i = 0; i < 10; i++) Q[u * 10 + i] += Q[v * 10 + i];
    vertAlive[v] = 0;
    vtris[u] = [...new Set([...vtris[u], ...vtris[v]])].filter((t) => triAlive[t]);
    vtris[v] = [];
    for (const w of touched) vtris[w] = vtris[w].filter((t) => triAlive[t]);
    stamp[u]++;
  }

  let alive = T;
  while (alive > targetTriangles && heap.size > 0) {
    const e = heap.pop();
    const u = heap.u[e], v = heap.v[e];
    if (!vertAlive[u] || !vertAlive[v] || stamp[u] !== heap.su[e] || stamp[v] !== heap.sv[e]) continue;
    evaluate(u, v);
    const x = best[0], y = best[1], z = best[2];
    if (!canCollapse(u, v, x, y, z)) continue;
    collapse(u, v, x, y, z);
    alive -= 2;
    for (const w of neighbours(u, nu).slice()) push(u, w);
  }

  // Compact: surviving vertices in original order, triangles likewise.
  const remap = new Int32Array(V).fill(-1);
  let nv2 = 0;
  for (let t = 0; t < T; t++) {
    if (!triAlive[t]) continue;
    for (let e = 0; e < 3; e++) {
      const w = tri[t * 3 + e];
      if (remap[w] < 0) remap[w] = nv2++;
    }
  }
  const positions = new Float64Array(nv2 * 3);
  for (let w = 0; w < V; w++) {
    if (remap[w] < 0) continue;
    positions.set(P.subarray(w * 3, w * 3 + 3), remap[w] * 3);
  }
  const indices = new Uint32Array(alive * 3);
  let k = 0;
  for (let t = 0; t < T; t++) {
    if (!triAlive[t]) continue;
    for (let e = 0; e < 3; e++) indices[k++] = remap[tri[t * 3 + e]];
  }
  return { positions, indices };
}

function normalOf(c) {
  const ux = c[3] - c[0], uy = c[4] - c[1], uz = c[5] - c[2];
  const vx = c[6] - c[0], vy = c[7] - c[1], vz = c[8] - c[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/** Expands an indexed mesh into the nine-values-per-triangle layout. */
function toTriangleSoup(mesh) {
  const { positions, indices } = mesh;
  const out = new Float32Array(indices.length * 3);
  for (let c = 0; c < indices.length; c++) {
    const v = indices[c] * 3;
    out[c * 3] = positions[v];
    out[c * 3 + 1] = positions[v + 1];
    out[c * 3 + 2] = positions[v + 2];
  }
  return out;
}

/** Triangle budget of the shipped model: about 3 MB as binary STL. */
export const TARGET_TRIANGLES = 60000;

/**
 * Builds the glider and returns it as a binary STL buffer.
 * @param {{coarsen?: number, triangles?: number}} [options] coarsen > 1 gives
 *   a quick low-poly version; triangles is the decimation target
 */
export function buildGliderStl(options = {}) {
  const { xs, ys, zs, shear } = gliderGrid(options.coarsen ?? 1);
  const raw = marchingCubes(gliderField, xs, ys, zs, shear);
  const mesh = decimate(raw, options.triangles ?? TARGET_TRIANGLES);
  return writeBinaryStl(toTriangleSoup(mesh), STL_HEADER);
}

/* ============================================================ inspection */

/**
 * Topology check of a binary STL: welds corners by their exact float32
 * coordinates and counts how every edge is used.
 *
 * `closed` means every edge is shared by exactly two triangles that traverse
 * it in opposite directions (closed, orientable, consistently wound), there
 * are no degenerate triangles, and the enclosed volume is positive, i.e. the
 * normals point outwards.
 */
export function inspectStl(buffer) {
  const info = parseStl(buffer);
  if (info.format !== "binary") throw new Error("Only binary STL files can be inspected.");
  const count = info.triangles;

  const ids = new Map();
  const coords = [];
  const corner = new Uint32Array(count * 3);
  for (let t = 0; t < count; t++) {
    for (let v = 0; v < 3; v++) {
      const off = 84 + t * 50 + 12 + v * 12;
      const key = `${buffer.readUInt32LE(off)},${buffer.readUInt32LE(off + 4)},${buffer.readUInt32LE(off + 8)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = coords.length / 3;
        ids.set(key, id);
        coords.push(buffer.readFloatLE(off), buffer.readFloatLE(off + 4), buffer.readFloatLE(off + 8));
      }
      corner[t * 3 + v] = id;
    }
  }
  const vertices = coords.length / 3;

  // Per undirected edge: how often it is used and the sum of its directions.
  const uses = new Map();
  let degenerate = 0;
  let volume6 = 0;
  const parent = new Uint32Array(vertices).map((_, i) => i);
  const root = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };

  for (let t = 0; t < count; t++) {
    const a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
    if (a === b || b === c || c === a) { degenerate++; continue; }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? p * vertices + q : q * vertices + p;
      const e = uses.get(key) || { n: 0, dir: 0 };
      e.n++;
      e.dir += p < q ? 1 : -1;
      uses.set(key, e);
      parent[root(p)] = root(q);
    }
    const ax = coords[a * 3], ay = coords[a * 3 + 1], az = coords[a * 3 + 2];
    const bx = coords[b * 3], by = coords[b * 3 + 1], bz = coords[b * 3 + 2];
    const cx = coords[c * 3], cy = coords[c * 3 + 1], cz = coords[c * 3 + 2];
    volume6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }

  let boundaryEdges = 0, nonManifoldEdges = 0, flippedEdges = 0;
  for (const e of uses.values()) {
    if (e.n === 1) boundaryEdges++;
    else if (e.n > 2) nonManifoldEdges++;
    else if (e.dir !== 0) flippedEdges++;
  }

  const roots = new Set();
  for (let v = 0; v < vertices; v++) roots.add(root(v));

  const edges = uses.size;
  const volume = volume6 / 6;
  return {
    triangles: count,
    vertices,
    edges,
    boundaryEdges,
    nonManifoldEdges,
    flippedEdges,
    degenerate,
    components: roots.size,
    eulerCharacteristic: vertices - edges + count,
    volume,
    bbox: info.bbox,
    closed: boundaryEdges === 0 && nonManifoldEdges === 0 && flippedEdges === 0 && degenerate === 0 && volume > 0
  };
}

/* ================================================================= setup */

/** The example wind tunnel, validated against schema 1. */
export function exampleSetup() {
  const cfg = defaultConfig(SETUP_NAME);
  cfg.domain = { size_m: [30.0, 40.0, 14.0], target_vram_mb: 4000 };
  cfg.fluid = { ...cfg.fluid, velocity_ms: 25.0 };
  // Mean aerodynamic chord of the wing: Re = 25 m/s * 0.72 m / nu, about 1.2e6.
  cfg.reference = { length_m: 0.72, source: "manual" };
  cfg.objects = [{
    id: "obj-1",
    name: "Glider",
    type: "stl",
    file: STL_REF,
    enabled: true,
    visible: true,
    sizing: { mode: "scale", value: 1.0 },  // the STL is in metres
    position_frac: [0.5, 0.35, 0.5],
    rotation_deg: { pitch: -3.0, yaw: 0.0, roll: 0.0 }, // 3 degrees nose up
    motion: { type: "none", axis: [0.0, 1.0, 0.0], rpm: 0.0, revoxelize_interval: 4 },
    // At ~6 cm cells the wing tip and the tail are only one or two cells
    // thick; sealing keeps them from vanishing in the voxelisation.
    sealing: { ...defaultSealing(), mode: "fill" }
  }];

  const { ok, errors, value } = validate(cfg);
  if (!ok) throw new Error(`The example setup is invalid: ${errors.join(" | ")}`);
  return value;
}

export function setupJson() {
  return JSON.stringify(exampleSetup(), null, 2) + "\n";
}

/* ================================================================ install */

/** Writes `content` to `target` unless an identical file is already there. */
function installFile(target, content, force, label) {
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (existing.equals(content)) {
      console.log(`  = ${label} already up to date: ${target}`);
      return false;
    }
    if (!force) {
      throw new Error(`${target} already exists with different content. Use --force to overwrite it.`);
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
  console.log(`  + ${label} installed: ${target}`);
  return true;
}

/**
 * Registers the STL in data/generated/stl-index.json the way the upload
 * endpoint does. The index is only a cache — the server rebuilds it from the
 * upload directory at startup — but keeping it current avoids a stale list.
 */
function registerInIndex(generatedDir, stlBuffer) {
  const indexFile = path.join(generatedDir, "stl-index.json");
  let entries = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // missing or unreadable: start a fresh index
  }
  const info = parseStl(stlBuffer);
  const previous = entries.find((e) => e && e.id === STL_NAME);
  const entry = {
    id: STL_NAME,
    name: STL_NAME,
    file: STL_REF,
    sizeBytes: stlBuffer.length,
    triangles: info.triangles,
    format: info.format,
    bbox: info.bbox,
    uploadedAt: previous?.sizeBytes === stlBuffer.length && previous.uploadedAt
      ? previous.uploadedAt
      : new Date().toISOString()
  };
  entries = [entry, ...entries.filter((e) => !e || e.id !== STL_NAME)];
  fs.mkdirSync(generatedDir, { recursive: true });
  const tmp = `${indexFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
  fs.renameSync(tmp, indexFile);
}

async function install(force) {
  // Imported lazily: paths.js resolves the data directory from
  // studio.config.json, which generating the example does not need.
  const { DATA_DIR, UPLOAD_DIR, SETUP_DIR, GENERATED_DIR } = await import("../server/paths.js");

  const stlFile = path.join(EXAMPLES_DIR, STL_NAME);
  const setupFile = path.join(EXAMPLES_DIR, `${SETUP_NAME}.json`);
  if (!fs.existsSync(stlFile) || !fs.existsSync(setupFile)) {
    console.log("Example files are missing, generating them first.");
    generate();
  }

  const stl = fs.readFileSync(stlFile);
  const setup = fs.readFileSync(setupFile);
  const parsed = JSON.parse(setup.toString("utf8"));
  const { ok, errors } = validate(parsed);
  if (!ok) throw new Error(`examples/${SETUP_NAME}.json is invalid: ${errors[0]}`);
  if (parsed.name !== SETUP_NAME || parsed.objects?.[0]?.file !== STL_REF) {
    throw new Error(`examples/${SETUP_NAME}.json must be named "${SETUP_NAME}" and reference ${STL_REF}.`);
  }

  console.log(`Installing the example into ${DATA_DIR}`);
  const stlChanged = installFile(path.join(UPLOAD_DIR, STL_NAME), stl, force, "model");
  installFile(path.join(SETUP_DIR, `${SETUP_NAME}.json`), setup, force, "setup");
  registerInIndex(GENERATED_DIR, stl);

  console.log(
    `Done. Pick the setup "${SETUP_NAME}" in the setup menu.` +
    (stlChanged ? " If the server is already running, restart it so it picks up the model." : "")
  );
}

/* =================================================================== main */

function describe(report) {
  const [x0, y0, z0] = report.bbox.min;
  const [x1, y1, z1] = report.bbox.max;
  const f = (v) => v.toFixed(3);
  return [
    `  triangles: ${report.triangles}, vertices: ${report.vertices}, edges: ${report.edges}`,
    `  bounding box: x ${f(x0)} .. ${f(x1)}, y ${f(y0)} .. ${f(y1)}, z ${f(z0)} .. ${f(z1)} m`,
    `  size: span ${f(x1 - x0)} m, length ${f(y1 - y0)} m, height ${f(z1 - z0)} m`,
    `  volume: ${report.volume.toFixed(4)} m^3, connected components: ${report.components}, ` +
      `Euler characteristic: ${report.eulerCharacteristic}`,
    `  open edges: ${report.boundaryEdges}, edges used more than twice: ${report.nonManifoldEdges}, ` +
      `inconsistently oriented edges: ${report.flippedEdges}, degenerate triangles: ${report.degenerate}`,
    `  closed and consistently oriented: ${report.closed ? "yes" : "NO"}`
  ].join("\n");
}

function check(buffer) {
  const report = inspectStl(buffer);
  console.log(describe(report));
  if (!report.closed || report.components !== 1) {
    throw new Error("The model is not a single closed shell.");
  }
  return report;
}

function generate() {
  const started = Date.now();
  const stl = buildGliderStl();
  check(stl);
  fs.mkdirSync(EXAMPLES_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXAMPLES_DIR, STL_NAME), stl);
  fs.writeFileSync(path.join(EXAMPLES_DIR, `${SETUP_NAME}.json`), setupJson(), "utf8");
  const mb = (stl.length / 1048576).toFixed(2);
  console.log(`Wrote examples/${STL_NAME} (${mb} MB) and examples/${SETUP_NAME}.json ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
}

async function main(argv) {
  const args = new Set(argv);
  const known = new Set(["--install", "--force", "--check"]);
  for (const a of args) {
    if (!known.has(a)) throw new Error(`Unknown option "${a}". Allowed: --install, --force, --check.`);
  }

  if (args.has("--check")) {
    const file = path.join(EXAMPLES_DIR, STL_NAME);
    console.log(`Checking ${file}`);
    check(fs.readFileSync(file));
    return;
  }
  if (args.has("--install")) {
    await install(args.has("--force"));
    return;
  }
  generate();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}
