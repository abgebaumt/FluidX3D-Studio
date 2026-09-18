/**
 * Derived quantities and number formatting.
 *
 * Every formula here is CONTRACT.md section 2 verbatim and must stay in step
 * with solver/setup_config.cpp — what the instrument band shows is what the
 * solver runs.
 */

const DEG = Math.PI / 180;

/* ============================================================ cell footprint */

const fpSize = precision => (precision === "FP32" ? 4 : 2);

const hasExt = (solver, name) =>
  Array.isArray(solver.extensions) && solver.extensions.includes(name);

/** Device memory per lattice cell, in bytes. */
export function bytesPerCell(solver) {
  const s = solver || {};
  const fp = fpSize(s.precision);
  const set = Number(s.velocity_set) || 19;       // an absent solver section must not poison the derived numbers
  let b = set * fp + 17;                          // fi, rho, u, flags
  if (hasExt(s, "FORCE_FIELD")) b += 12;     // F
  if (hasExt(s, "SURFACE")) b += 12;         // phi, mass, massex
  if (hasExt(s, "TEMPERATURE")) b += 7 * fp + 4;  // gi, T
  return b;
}

/** Host memory per cell — display only, not part of the contract. */
export function bytesPerCellHost(solver) {
  const s = solver || {};
  return 17
    + (hasExt(s, "FORCE_FIELD") ? 12 : 0)
    + (hasExt(s, "SURFACE") ? 4 : 0)
    + (hasExt(s, "TEMPERATURE") ? 4 : 0);
}

/** Bytes moved per cell and time step — the quantity that sets the speed. */
export function bandwidthPerCell(solver) {
  const s = solver || {};
  const fp = fpSize(s.precision);
  const set = Number(s.velocity_set) || 19;
  let b = set * 2 * fp + 1;                       // 2 x fi, flags
  b += 16;                                        // UPDATE_FIELDS: rho, u
  if (hasExt(s, "TEMPERATURE")) b += 4;
  if (hasExt(s, "FORCE_FIELD")) b += 12;
  if (hasExt(s, "MOVING_BOUNDARIES") || hasExt(s, "SURFACE") || hasExt(s, "TEMPERATURE")) {
    b += set - 1;                                 // neighbour flags
  }
  return b;
}

/* ================================================================= reference */

/**
 * Characteristic length for the Reynolds number. `reference.source` may point
 * at an object; then the object's own metre size wins, so the read-out cannot
 * drift away from the geometry.
 */
export function referenceLength(cfg) {
  const ref = cfg.reference || {};
  const src = typeof ref.source === "string" ? ref.source : "manual";
  if (src.startsWith("object:")) {
    const obj = (cfg.objects || []).find(o => o.id === src.slice(7));
    if (obj && obj.sizing && obj.sizing.mode === "longest_edge_m" && obj.sizing.value > 0) {
      return obj.sizing.value;
    }
  }
  const l = Number(ref.length_m);
  return Number.isFinite(l) && l > 0 ? l : 1;
}

/* =================================================================== derived */

/**
 * All numbers the panels and the band display.
 *
 * @param {object} cfg setup config (schema 1)
 * @param {{name?:string, vramMB?:number, bandwidthGBs?:number}} gpu
 * @returns {{
 *   Nx:number, Ny:number, Nz:number, N:number, scale:number,
 *   cell:number, vramMB:number, hostMB:number, vramFrac:number, gpuVramMB:number,
 *   bytesPerCell:number, bandwidthPerCell:number,
 *   Re:number, dt:number, nuLbm:number, tau:number, refLength:number, lbmSpan:number,
 *   mlups:number, stepsPerSec:number, secPerSimSec:number,
 *   runSteps:number, runSeconds:number, frames:number
 * }}
 */
export function derive(cfg, gpu = {}) {
  const solver = cfg.solver || {};
  const dom = cfg.domain || {};
  const fluid = cfg.fluid || {};

  const size = Array.isArray(dom.size_m) ? dom.size_m : [1, 1, 1];
  const lx = pos(size[0]), ly = pos(size[1]), lz = pos(size[2]);
  const target = pos(dom.target_vram_mb, 1000);

  const bpc = bytesPerCell(solver);
  const bwc = bandwidthPerCell(solver);
  const hostBpc = bytesPerCellHost(solver);

  // resolution(): scale the box's aspect ratio until the VRAM target is met
  const perUnit = lx * ly * lz * bpc / 1048576;
  const scale = Math.cbrt(target / perUnit);
  const Nx = Math.max(2, Math.round(scale * lx));
  const Ny = Math.max(2, Math.round(scale * ly));
  const Nz = Math.max(2, Math.round(scale * lz));
  const N = Nx * Ny * Nz;

  const cell = lx / Nx;
  const vramMB = N * bpc / 1048576;
  const hostMB = N * hostBpc / 1048576;

  const u = pos(fluid.velocity_ms, 1);
  const nu = pos(fluid.viscosity_m2s, 1.48e-5);
  const uLbm = pos(fluid.u_lbm, 0.075);

  const refLength = referenceLength(cfg);
  const Re = u * refLength / nu;
  const dt = (uLbm / u) * cell;
  const nuLbm = nu * dt / (cell * cell);
  const tau = 3 * nuLbm + 0.5;
  const lbmSpan = refLength / cell;

  // display-only throughput estimate; FluidX3D lands near 78 % of peak bandwidth
  const bandwidthGBs = pos(gpu.bandwidthGBs, 400);
  const mlups = 0.78 * bandwidthGBs * 1e9 / bwc / 1e6;
  const stepsPerSec = mlups * 1e6 / N;
  const secPerSimSec = dt > 0 && stepsPerSec > 0 ? 1 / (stepsPerSec * dt) : Infinity;

  const gpuVramMB = pos(gpu.vramMB, 8192);

  const run = cfg.run || {};
  const duration = pos(run.duration_s, 0);
  const runSteps = dt > 0 ? duration / dt : 0;
  const runSeconds = stepsPerSec > 0 ? runSteps / stepsPerSec : Infinity;
  const frames = Math.round(duration * pos(run.fps, 60));

  return {
    Nx, Ny, Nz, N, scale,
    cell, vramMB, hostMB, vramFrac: gpuVramMB > 0 ? vramMB / gpuVramMB : 0, gpuVramMB,
    bytesPerCell: bpc, bandwidthPerCell: bwc,
    Re, dt, nuLbm, tau, refLength, lbmSpan,
    mlups, stepsPerSec, secPerSimSec,
    runSteps, runSeconds, frames
  };
}

/* ==================================================================== matrix */

/** Column-major 3x3 product. */
export function mat3Mul(a, b) {
  const o = new Array(9);
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[k * 3 + r] * b[c * 3 + k];
      o[c * 3 + r] = s;
    }
  }
  return o;
}

/** Applies a column-major 3x3 to a vector. */
export function applyMat3(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2]
  ];
}

/**
 * Rz(yaw) · Rx(pitch) · Ry(roll) as nine column-major values.
 * Identical to make_rotation() in solver/setup_config.cpp.
 */
export function euler(yawDeg, pitchDeg, rollDeg) {
  const cy = Math.cos(yawDeg * DEG), sy = Math.sin(yawDeg * DEG);
  const cp = Math.cos(pitchDeg * DEG), sp = Math.sin(pitchDeg * DEG);
  const cr = Math.cos(rollDeg * DEG), sr = Math.sin(rollDeg * DEG);
  const Rz = [cy, sy, 0, -sy, cy, 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, cp, sp, 0, -sp, cp];
  const Ry = [cr, 0, -sr, 0, 1, 0, sr, 0, cr];
  return mat3Mul(mat3Mul(Rz, Rx), Ry);
}

/** Unit vector of the inflow: azimuth 0 points along +y, elevation tilts up. */
export function windDir(fluid) {
  const a = pos(fluid.azimuth_deg, 0, true) * DEG;
  const e = pos(fluid.elevation_deg, 0, true) * DEG;
  const v = [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/* ================================================================ formatting */

/** Fixed-decimal number. */
export const nf = (v, d = 2) =>
  Number.isFinite(v)
    ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
    : "—";

/** Rounded integer with thousands separators. */
export const ni = v => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—");

const SUP = { "-": "⁻", 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹" };
const sup = e => String(e).split("").map(c => SUP[c] || "").join("");

/** Scientific notation with a real superscript exponent. */
export function sci(v, d = 2) {
  if (!Number.isFinite(v) || v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  return nf(v / Math.pow(10, e), d) + "·10" + sup(e);
}

/** Cell counts in millions and billions. */
export function bigCells(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e9) return nf(n / 1e9, 2) + " B";
  if (n >= 1e6) return nf(n / 1e6, 1) + " M";
  return ni(n);
}

/** Durations in the largest sensible unit. */
export function dur(s) {
  if (!Number.isFinite(s)) return "—";
  if (s < 90) return nf(s, 1) + " s";
  if (s < 5400) return nf(s / 60, 1) + " min";
  if (s < 172800) return nf(s / 3600, 1) + " h";
  return nf(s / 86400, 1) + " d";
}

/** Accepts both "1,5" and "1.5" from number inputs. */
export function parseNum(text, fallback = 0) {
  if (typeof text === "number") return Number.isFinite(text) ? text : fallback;
  const n = Number(String(text).trim().replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

/** Byte counts for the upload list. */
export function bytes(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1048576) return nf(n / 1048576, 1) + " MB";
  if (n >= 1024) return nf(n / 1024, 0) + " kB";
  return ni(n) + " B";
}

/** Guards a value against zero, NaN and undefined. `signed` allows negatives. */
function pos(v, fallback = 1, signed = false) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (!signed && n <= 0) return fallback;
  return n;
}
