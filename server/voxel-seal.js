/**
 * Voxel sealing — stages 1 to 4 of CONTRACT.md section 8.
 *
 * Turns a triangle soup into a dense voxel mask in which every wall is at
 * least one cell thick. The mask is what the surface extraction turns back
 * into a sealed STL. Nothing here reads or writes anything inside FluidX3D.
 *
 * Why the shell rasterisation matters: FluidX3D voxelises by ray casting and
 * stores hit distances as integers, so a wall thinner than one cell flips the
 * inside/outside state twice within the same integer step and vanishes
 * completely. Rasterising every triangle into the cells it overlaps makes a
 * face solid regardless of how thin it is.
 *
 * Memory rules honoured throughout:
 *   - one flat Uint8Array per mask, one byte per cell, never objects per cell,
 *   - the flood fill is iterative with an explicit Int32Array queue,
 *   - morphology runs as three separable 1D passes, not as a 3D kernel.
 *
 * Grid convention: cell (i,j,k) covers
 *   [origin[a] + n*cell, origin[a] + (n+1)*cell] per axis a,
 * and is stored at index i + nx*(j + ny*k) — x runs fastest.
 */

import { raycastVoxelise, compareMasks } from "./raycast-reference.js";

/**
 * Upper bound on the grid size a single sealing run may allocate.
 * 64 M cells are 64 MB of mask plus 256 MB of flood-fill queue; anything
 * beyond that is a wrong cell size rather than a real request.
 */
export const MAX_CELLS = 64_000_000;

function fail(message) {
  const err = new Error(message);
  err.publicMessage = message;
  err.status = 400;
  return err;
}

/** Accepts {min,max} or a flat [minx,miny,minz,maxx,maxy,maxz] box. */
function readBox(bbox) {
  let min;
  let max;
  if (Array.isArray(bbox) && bbox.length === 6) {
    min = [bbox[0], bbox[1], bbox[2]];
    max = [bbox[3], bbox[4], bbox[5]];
  } else if (bbox && bbox.min && bbox.max) {
    min = [Number(bbox.min[0]), Number(bbox.min[1]), Number(bbox.min[2])];
    max = [Number(bbox.max[0]), Number(bbox.max[1]), Number(bbox.max[2])];
  } else {
    throw fail("No valid bounding box was given.");
  }
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a]) || max[a] < min[a]) {
      throw fail("The bounding box contains invalid values.");
    }
  }
  return { min, max };
}

/** Validates a grid descriptor and returns its parts as plain numbers. */
function readGrid(grid) {
  if (!grid || !Array.isArray(grid.origin) || !Array.isArray(grid.dims)) {
    throw fail("No valid grid was given.");
  }
  const cell = Number(grid.cell);
  if (!Number.isFinite(cell) || cell <= 0) {
    throw fail("The cell size must be a positive number.");
  }
  const origin = [Number(grid.origin[0]), Number(grid.origin[1]), Number(grid.origin[2])];
  const dims = [Math.trunc(grid.dims[0]), Math.trunc(grid.dims[1]), Math.trunc(grid.dims[2])];
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(origin[a])) throw fail("The grid origin contains invalid values.");
    if (!Number.isFinite(dims[a]) || dims[a] < 1) throw fail("The grid dimensions must be at least 1.");
  }
  const cells = dims[0] * dims[1] * dims[2];
  if (cells > MAX_CELLS) {
    throw fail(`The sealing grid would be too large at ${cells} cells. Please choose a larger cell size.`);
  }
  return { origin, cell, dims, cells };
}

function readDims(dims, mask) {
  if (!Array.isArray(dims) || dims.length !== 3) throw fail("The grid dimensions must have three values.");
  const nx = Math.trunc(dims[0]);
  const ny = Math.trunc(dims[1]);
  const nz = Math.trunc(dims[2]);
  if (!(nx >= 1 && ny >= 1 && nz >= 1)) throw fail("The grid dimensions must be at least 1.");
  const n = nx * ny * nz;
  if (mask && mask.length !== n) {
    throw fail(`The mask does not match the grid (${mask.length} instead of ${n} cells).`);
  }
  return { nx, ny, nz, n };
}

/** Number of triangles in a flat 9-values-per-triangle array. */
function triangleCount(triangles) {
  if (!triangles || typeof triangles.length !== "number") {
    throw fail("No triangle data was given.");
  }
  if (triangles.length % 9 !== 0) {
    throw fail("The triangle data must contain a multiple of 9 values.");
  }
  return triangles.length / 9;
}

/** Counts solid cells in a mask. */
export function countSolid(mask) {
  let solid = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) solid++;
  return solid;
}

/**
 * Axis-aligned bounding box of a triangle soup.
 * @param {Float32Array|number[]} triangles 9 values per triangle
 * @returns {{min:number[], max:number[]}}
 */
export function meshBounds(triangles) {
  const count = triangleCount(triangles);
  if (count === 0) throw fail("The mesh contains no triangles.");
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < triangles.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = triangles[i + a];
      if (!Number.isFinite(v)) continue;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a])) {
      throw fail("The mesh contains no valid coordinates.");
    }
  }
  return { min, max };
}

/**
 * Grid covering a bounding box plus `margin` cells of empty space on every
 * side. The origin is snapped down to a multiple of the cell size so that a
 * given cell size always yields the same lattice, whatever the object.
 *
 * @param {{min:number[],max:number[]}|number[]} bbox
 * @param {number} cell edge length of one cell in metres
 * @param {number} [margin] empty cells added on each side
 * @returns {{origin:number[], cell:number, dims:number[]}}
 */
export function gridFor(bbox, cell, margin = 2) {
  const { min, max } = readBox(bbox);
  const c = Number(cell);
  if (!Number.isFinite(c) || c <= 0) throw fail("The cell size must be a positive number.");
  const m = Math.max(0, Math.round(Number(margin) || 0));

  const origin = [0, 0, 0];
  const dims = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const aligned = Math.floor(min[a] / c) * c; // lattice is a multiple of the cell size
    const span = Math.max(1, Math.ceil((max[a] - aligned) / c));
    origin[a] = aligned - m * c;
    dims[a] = span + 2 * m;
  }

  const cells = dims[0] * dims[1] * dims[2];
  if (!Number.isFinite(cells) || cells > MAX_CELLS) {
    throw fail(
      `The sealing grid would be too large at ${dims[0]}x${dims[1]}x${dims[2]} cells. ` +
        "Please choose a larger cell size."
    );
  }
  return { origin, cell: c, dims };
}

/* ------------------------------------------------------------------ *
 * Stage 1 — shell rasterisation
 * ------------------------------------------------------------------ */

/**
 * Separating-axis overlap test between a triangle and an axis-aligned cube
 * (Akenine-Möller, "Fast 3D Triangle-Box Overlap Testing"). Thirteen axes:
 * three box normals, nine edge/box-axis cross products, one triangle normal.
 * Touching counts as overlap, which is what we want — a face lying exactly on
 * a cell boundary must not fall through the grid.
 *
 * @param {number} cx box centre
 * @param {number} h half edge length of the cube
 * @returns {boolean}
 */
function triBoxOverlap(cx, cy, cz, h, ax, ay, az, bx, by, bz, gx, gy, gz) {
  // Triangle vertices relative to the box centre.
  const v0x = ax - cx, v0y = ay - cy, v0z = az - cz;
  const v1x = bx - cx, v1y = by - cy, v1z = bz - cz;
  const v2x = gx - cx, v2y = gy - cy, v2z = gz - cz;

  // Triangle edges.
  const e0x = v1x - v0x, e0y = v1y - v0y, e0z = v1z - v0z;
  const e1x = v2x - v1x, e1y = v2y - v1y, e1z = v2z - v1z;
  const e2x = v0x - v2x, e2y = v0y - v2y, e2z = v0z - v2z;

  let p0, p1, p2, lo, hi, rad;

  // --- nine axes: edge x box axis ---------------------------------------
  let fx = Math.abs(e0x), fy = Math.abs(e0y), fz = Math.abs(e0z);
  // e0 x (1,0,0)
  p0 = e0z * v0y - e0y * v0z;
  p2 = e0z * v2y - e0y * v2z;
  lo = p0 < p2 ? p0 : p2; hi = p0 < p2 ? p2 : p0;
  rad = (fz + fy) * h;
  if (lo > rad || hi < -rad) return false;
  // e0 x (0,1,0)
  p0 = -e0z * v0x + e0x * v0z;
  p2 = -e0z * v2x + e0x * v2z;
  lo = p0 < p2 ? p0 : p2; hi = p0 < p2 ? p2 : p0;
  rad = (fz + fx) * h;
  if (lo > rad || hi < -rad) return false;
  // e0 x (0,0,1)
  p1 = e0y * v1x - e0x * v1y;
  p2 = e0y * v2x - e0x * v2y;
  lo = p1 < p2 ? p1 : p2; hi = p1 < p2 ? p2 : p1;
  rad = (fy + fx) * h;
  if (lo > rad || hi < -rad) return false;

  fx = Math.abs(e1x); fy = Math.abs(e1y); fz = Math.abs(e1z);
  // e1 x (1,0,0)
  p0 = e1z * v0y - e1y * v0z;
  p2 = e1z * v2y - e1y * v2z;
  lo = p0 < p2 ? p0 : p2; hi = p0 < p2 ? p2 : p0;
  rad = (fz + fy) * h;
  if (lo > rad || hi < -rad) return false;
  // e1 x (0,1,0)
  p0 = -e1z * v0x + e1x * v0z;
  p2 = -e1z * v2x + e1x * v2z;
  lo = p0 < p2 ? p0 : p2; hi = p0 < p2 ? p2 : p0;
  rad = (fz + fx) * h;
  if (lo > rad || hi < -rad) return false;
  // e1 x (0,0,1)
  p0 = e1y * v0x - e1x * v0y;
  p1 = e1y * v1x - e1x * v1y;
  lo = p0 < p1 ? p0 : p1; hi = p0 < p1 ? p1 : p0;
  rad = (fy + fx) * h;
  if (lo > rad || hi < -rad) return false;

  fx = Math.abs(e2x); fy = Math.abs(e2y); fz = Math.abs(e2z);
  // e2 x (1,0,0)
  p0 = e2z * v0y - e2y * v0z;
  p1 = e2z * v1y - e2y * v1z;
  lo = p0 < p1 ? p0 : p1; hi = p0 < p1 ? p1 : p0;
  rad = (fz + fy) * h;
  if (lo > rad || hi < -rad) return false;
  // e2 x (0,1,0)
  p0 = -e2z * v0x + e2x * v0z;
  p1 = -e2z * v1x + e2x * v1z;
  lo = p0 < p1 ? p0 : p1; hi = p0 < p1 ? p1 : p0;
  rad = (fz + fx) * h;
  if (lo > rad || hi < -rad) return false;
  // e2 x (0,0,1)
  p1 = e2y * v1x - e2x * v1y;
  p2 = e2y * v2x - e2x * v2y;
  lo = p1 < p2 ? p1 : p2; hi = p1 < p2 ? p2 : p1;
  rad = (fy + fx) * h;
  if (lo > rad || hi < -rad) return false;

  // --- three box normals -------------------------------------------------
  lo = v0x < v1x ? v0x : v1x; if (v2x < lo) lo = v2x;
  hi = v0x > v1x ? v0x : v1x; if (v2x > hi) hi = v2x;
  if (lo > h || hi < -h) return false;

  lo = v0y < v1y ? v0y : v1y; if (v2y < lo) lo = v2y;
  hi = v0y > v1y ? v0y : v1y; if (v2y > hi) hi = v2y;
  if (lo > h || hi < -h) return false;

  lo = v0z < v1z ? v0z : v1z; if (v2z < lo) lo = v2z;
  hi = v0z > v1z ? v0z : v1z; if (v2z > hi) hi = v2z;
  if (lo > h || hi < -h) return false;

  // --- the triangle normal (plane against box) ---------------------------
  const nx = e0y * e1z - e0z * e1y;
  const ny = e0z * e1x - e0x * e1z;
  const nz = e0x * e1y - e0y * e1x;
  const d = -(nx * v0x + ny * v0y + nz * v0z);
  // Support point of the box in +/- normal direction.
  const support = Math.abs(nx) * h + Math.abs(ny) * h + Math.abs(nz) * h;
  return d <= support && d >= -support;
}

/**
 * Stage 1: every cell a triangle overlaps becomes 1.
 *
 * Only the cells inside each triangle's own bounding box are visited, so the
 * cost scales with the surface, not with the volume of the grid.
 *
 * @param {Float32Array|number[]} triangles 9 values per triangle
 * @param {{origin:number[], cell:number, dims:number[]}} grid
 * @returns {Uint8Array} mask with one byte per cell
 */
export function rasteriseShell(triangles, grid) {
  const count = triangleCount(triangles);
  const { origin, cell, dims, cells } = readGrid(grid);
  const [nx, ny, nz] = dims;
  const mask = new Uint8Array(cells);
  const [ox, oy, oz] = origin;
  const inv = 1 / cell;
  const h = cell * 0.5;
  const nxy = nx * ny;

  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const ax = triangles[o], ay = triangles[o + 1], az = triangles[o + 2];
    const bx = triangles[o + 3], by = triangles[o + 4], bz = triangles[o + 5];
    const gx = triangles[o + 6], gy = triangles[o + 7], gz = triangles[o + 8];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)
    ) continue;

    // Cell range of this triangle's own bounding box, clamped to the grid.
    let lo = ax < bx ? ax : bx; if (gx < lo) lo = gx;
    let hi = ax > bx ? ax : bx; if (gx > hi) hi = gx;
    let i0 = Math.floor((lo - ox) * inv);
    let i1 = Math.floor((hi - ox) * inv);
    if (i1 < 0 || i0 > nx - 1) continue;
    if (i0 < 0) i0 = 0;
    if (i1 > nx - 1) i1 = nx - 1;

    lo = ay < by ? ay : by; if (gy < lo) lo = gy;
    hi = ay > by ? ay : by; if (gy > hi) hi = gy;
    let j0 = Math.floor((lo - oy) * inv);
    let j1 = Math.floor((hi - oy) * inv);
    if (j1 < 0 || j0 > ny - 1) continue;
    if (j0 < 0) j0 = 0;
    if (j1 > ny - 1) j1 = ny - 1;

    lo = az < bz ? az : bz; if (gz < lo) lo = gz;
    hi = az > bz ? az : bz; if (gz > hi) hi = gz;
    let k0 = Math.floor((lo - oz) * inv);
    let k1 = Math.floor((hi - oz) * inv);
    if (k1 < 0 || k0 > nz - 1) continue;
    if (k0 < 0) k0 = 0;
    if (k1 > nz - 1) k1 = nz - 1;

    for (let k = k0; k <= k1; k++) {
      const cz = oz + (k + 0.5) * cell;
      for (let j = j0; j <= j1; j++) {
        const cy = oy + (j + 0.5) * cell;
        const row = nxy * k + nx * j;
        for (let i = i0; i <= i1; i++) {
          const idx = row + i;
          if (mask[idx]) continue;
          const cx = ox + (i + 0.5) * cell;
          if (triBoxOverlap(cx, cy, cz, h, ax, ay, az, bx, by, bz, gx, gy, gz)) mask[idx] = 1;
        }
      }
    }
  }
  return mask;
}

/* ------------------------------------------------------------------ *
 * Stage 2 — morphology
 * ------------------------------------------------------------------ */

/**
 * One separable 1D pass over a single line of the grid.
 *
 * The mask is binary, so a prefix sum over the line answers both filters in
 * constant time per cell, whatever the radius: the window contains a solid
 * cell (dilate) or contains nothing but solid cells (erode).
 *
 * Cells outside the grid are ignored, so the window is clipped rather than
 * padded: dilation never invents material beyond the border and erosion never
 * eats a body that touches the border. With the margin the caller lays around
 * the object neither case can occur anyway.
 */
function filterLine(src, dst, count, stride, base, radius, isMax, line, prefix) {
  for (let i = 0, p = base; i < count; i++, p += stride) line[i] = src[p];
  prefix[0] = 0;
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i] + line[i];
  const last = count - 1;
  for (let i = 0, p = base; i < count; i++, p += stride) {
    const lo = i - radius > 0 ? i - radius : 0;
    const hi = i + radius < last ? i + radius : last;
    const sum = prefix[hi + 1] - prefix[lo];
    dst[p] = isMax ? (sum > 0 ? 1 : 0) : (sum === hi - lo + 1 ? 1 : 0);
  }
}

/**
 * Separable morphology with a cube-shaped structuring element of edge
 * 2*radius+1: three 1D passes instead of one 3D kernel.
 */
function morph(mask, dims, radius, isMax) {
  const { nx, ny, nz, n } = readDims(dims, mask);
  const r = Math.max(0, Math.round(Number(radius) || 0));
  if (r === 0) return Uint8Array.from(mask);

  const longest = Math.max(nx, ny, nz);
  const line = new Uint8Array(longest);
  const prefix = new Int32Array(longest + 1);
  const a = new Uint8Array(n);
  const b = new Uint8Array(n);
  const nxy = nx * ny;

  // x, stride 1
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) filterLine(mask, a, nx, 1, nxy * k + nx * j, r, isMax, line, prefix);
  }
  // y, stride nx
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) filterLine(a, b, ny, nx, nxy * k + i, r, isMax, line, prefix);
  }
  // z, stride nx*ny — writes back into `a`, which is no longer read
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) filterLine(b, a, nz, nxy, nx * j + i, r, isMax, line, prefix);
  }
  return a;
}

/**
 * Grows every solid cell by `radius` cells in each direction.
 * @returns {Uint8Array} a new mask; the input is left untouched
 */
export function dilate(mask, dims, radius) {
  return morph(mask, dims, radius, true);
}

/**
 * Removes every solid cell that has a non-solid cell within `radius`.
 * @returns {Uint8Array} a new mask; the input is left untouched
 */
export function erode(mask, dims, radius) {
  return morph(mask, dims, radius, false);
}

/**
 * Morphological closing: dilate, then erode. Seals openings up to 2*radius
 * cells wide while leaving the outer shape where it was.
 * @returns {Uint8Array} a new mask; the input is left untouched
 */
export function closeHoles(mask, dims, radius) {
  const r = Math.max(0, Math.round(Number(radius) || 0));
  if (r === 0) {
    readDims(dims, mask);
    return Uint8Array.from(mask);
  }
  return erode(dilate(mask, dims, r), dims, r);
}

/* ------------------------------------------------------------------ *
 * Stage 3 — flood fill
 * ------------------------------------------------------------------ */

const OUTSIDE = 2; // scratch marker inside the working copy

/**
 * Flood-fills from the grid border through all non-solid cells and turns
 * everything the fill never reached into solid — that is the interior.
 *
 * Iterative, with an explicit Int32Array queue over cell indices: a body of a
 * few million cells would blow the call stack with recursion.
 *
 * `closed` reports whether the shell was watertight, i.e. whether an enclosed
 * interior existed at all. An open shell lets the fill walk inside, nothing is
 * left over, and `closed` is false.
 *
 * @param {Uint8Array} mask
 * @param {number[]} dims
 * @returns {{mask:Uint8Array, closed:boolean, filledCells:number}}
 */
export function fillInterior(mask, dims) {
  const { nx, ny, nz, n } = readDims(dims, mask);
  const out = Uint8Array.from(mask);
  const queue = new Int32Array(n);
  const nxy = nx * ny;
  let head = 0;
  let tail = 0;

  // Seed: every empty cell on the six border faces belongs to the outside.
  for (let k = 0; k < nz; k++) {
    const onZBorder = k === 0 || k === nz - 1;
    for (let j = 0; j < ny; j++) {
      const onYBorder = j === 0 || j === ny - 1;
      if (onZBorder || onYBorder) {
        const row = nxy * k + nx * j;
        for (let i = 0; i < nx; i++) {
          const idx = row + i;
          if (out[idx] === 0) { out[idx] = OUTSIDE; queue[tail++] = idx; }
        }
      } else {
        const row = nxy * k + nx * j;
        let idx = row;
        if (out[idx] === 0) { out[idx] = OUTSIDE; queue[tail++] = idx; }
        idx = row + nx - 1;
        if (out[idx] === 0) { out[idx] = OUTSIDE; queue[tail++] = idx; }
      }
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const k = (idx / nxy) | 0;
    const rest = idx - k * nxy;
    const j = (rest / nx) | 0;
    const i = rest - j * nx;

    let m;
    if (i > 0) { m = idx - 1; if (out[m] === 0) { out[m] = OUTSIDE; queue[tail++] = m; } }
    if (i < nx - 1) { m = idx + 1; if (out[m] === 0) { out[m] = OUTSIDE; queue[tail++] = m; } }
    if (j > 0) { m = idx - nx; if (out[m] === 0) { out[m] = OUTSIDE; queue[tail++] = m; } }
    if (j < ny - 1) { m = idx + nx; if (out[m] === 0) { out[m] = OUTSIDE; queue[tail++] = m; } }
    if (k > 0) { m = idx - nxy; if (out[m] === 0) { out[m] = OUTSIDE; queue[tail++] = m; } }
    if (k < nz - 1) { m = idx + nxy; if (out[m] === 0) { out[m] = OUTSIDE; queue[tail++] = m; } }
  }

  let filledCells = 0;
  for (let idx = 0; idx < n; idx++) {
    const v = out[idx];
    if (v === 0) { out[idx] = 1; filledCells++; }      // never reached -> interior
    else if (v === OUTSIDE) out[idx] = 0;              // reached -> plain empty again
  }
  return { mask: out, closed: filledCells > 0, filledCells };
}

/* ------------------------------------------------------------------ *
 * The whole chain
 * ------------------------------------------------------------------ */

/**
 * Runs stages 1 to 4 of CONTRACT.md section 8 and reports what happened.
 *
 * @param {Float32Array|number[]} triangles 9 values per triangle
 * @param {{cell:number, mode?:"shell"|"fill", closeHoles?:number,
 *          minThickness?:number, margin?:number, maxCells?:number,
 *          reference?:boolean}} options `reference` defaults to true and adds
 *          the FluidX3D ray-cast comparison (lostCells / lostFraction /
 *          raycastCells); set it to false to skip that extra pass, in which
 *          case those three fields come back as null
 * @returns {{mask:Uint8Array, grid:object, stats:object,
 *            dims:number[], origin:number[], cell:number}}
 */
export function sealMesh(triangles, options = {}) {
  const trianglesIn = triangleCount(triangles);
  if (trianglesIn === 0) throw fail("The mesh contains no triangles.");

  const cell = Number(options.cell);
  if (!Number.isFinite(cell) || cell <= 0) throw fail("The cell size must be a positive number.");

  const mode = options.mode === "shell" ? "shell" : "fill";
  const closeRadius = clampInt(options.closeHoles, 0, 0, 8);
  const minThickness = clampInt(options.minThickness, 1, 1, 16);
  // Thickening is a shell-mode step — in fill mode the body is solid anyway
  // (CONTRACT.md section 8, stage 4).
  const thickenRadius = mode === "shell" ? minThickness - 1 : 0;

  // At least radius+2 empty cells around the object. This is a lower bound,
  // not a preference: with a thinner border the closing would reach the outer
  // cell layer, the flood fill would find no outside left and would declare
  // the whole grid solid. A caller asking for more gets more.
  const requested = Number(options.margin);
  const needed = Math.max(closeRadius, thickenRadius) + 2;
  const margin = Number.isFinite(requested) && requested > needed ? Math.round(requested) : needed;

  const bbox = meshBounds(triangles);
  const grid = gridFor(bbox, cell, margin);
  const dims = grid.dims;

  // A caller may lower — never raise — the cell budget of this module.
  const budget = Number(options.maxCells);
  if (Number.isFinite(budget) && budget > 0 && dims[0] * dims[1] * dims[2] > budget) {
    throw fail(
      `The sealing grid would be too large at ${dims[0]}x${dims[1]}x${dims[2]} cells. ` +
        "Please choose a larger cell size."
    );
  }

  // Stage 1 — shell.
  const shell = rasteriseShell(triangles, grid);
  const shellCells = countSolid(shell);

  // Stage 2 — close holes.
  let mask = closeRadius > 0 ? closeHoles(shell, dims, closeRadius) : shell;

  // Stage 3 — flood fill. The analysis runs in both modes, because whether
  // the body is watertight is worth reporting either way; only in fill mode
  // is its result kept.
  const fill = fillInterior(mask, dims);
  let filledCells = 0;
  if (mode === "fill") {
    mask = fill.mask;
    filledCells = fill.filledCells;
  }

  // A generous closing radius can swallow a small cavity whole. That body is
  // watertight, it simply has no interior left, so fall back to the raw shell
  // to tell "no opening" from "no cavity".
  let closed = fill.closed;
  if (!closed && closeRadius > 0) closed = fillInterior(shell, dims).closed;

  // Stage 4 — thicken.
  if (thickenRadius > 0) mask = dilate(mask, dims, thickenRadius);

  const solidCells = countSolid(mask);

  // What FluidX3D would actually make of the same mesh. This is the honest
  // measure of what sealing is for: `lostCells` are body cells the solver's
  // own ray-cast voxeliser never marks solid — a wall that falls through the
  // lattice, a trailing edge thinner than one cell, a sheet between two
  // lattice lines.
  //
  // Read it with one caveat: the two methods also differ by convention at the
  // surface. Rasterisation claims every cell a triangle touches, ray casting
  // only cells whose centre is inside, and the kernel's hmesh correction drops
  // one more cell at the far end of each ray. So a body that loses nothing
  // structurally still shows a loss of roughly its surface layer. A number far
  // above that layer is what indicates real geometry falling through.
  //
  // Costs about a quarter of a sealing pass (~8 ms for a 60 k-triangle
  // fuselage at 5.88 cm); `reference: false` turns it off.
  let raycastCells = null;
  let lostCells = null;
  let lostFraction = null;
  if (options.reference !== false) {
    const compared = compareMasks(mask, raycastVoxelise(triangles, grid));
    raycastCells = compared.raycastCells;
    lostCells = compared.lostCells;
    lostFraction = solidCells > 0 ? lostCells / solidCells : 0;
  }

  const stats = {
    trianglesIn,
    grid: [dims[0], dims[1], dims[2]],
    cells: dims[0] * dims[1] * dims[2],
    solidCells,
    shellCells,
    filledCells,
    closed,
    // Cells FluidX3D would lose without sealing, and the share of the body
    // that is. These three are the numbers that justify the feature.
    lostCells,
    lostFraction,
    raycastCells,
    // NOT a loss figure: this only says how finely the mesh is triangulated
    // (triangles shorter than one cell). A solid wall made of a thousand tiny
    // triangles survives voxelisation perfectly well, so a high count here
    // means nothing on its own. Kept because callers already read it.
    thinFaces: countThinFaces(triangles, grid)
  };
  // `grid` carries origin, cell and dims together; the same three are repeated
  // at the top level so a consumer does not have to reach into it.
  return { mask, grid, stats, dims: [dims[0], dims[1], dims[2]], origin: [...grid.origin], cell };
}

function clampInt(value, fallback, lo, hi) {
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * A measure of how fine the triangulation is relative to the grid: triangles
 * whose longest edge is shorter than one cell, plus those contained in a
 * single cell.
 *
 * This is NOT a count of lost geometry, and it must not be presented as one.
 * A finely tessellated mesh puts nearly every triangle in this bucket while
 * losing nothing at all — what a ray-cast voxeliser loses depends on the
 * thickness of the body, not on the size of its triangles. The figure that
 * answers that question is `lostCells` in sealMesh()'s statistics, measured
 * against server/raycast-reference.js.
 *
 * @param {Float32Array|number[]} triangles
 * @param {{origin:number[], cell:number, dims:number[]}} grid
 * @returns {number}
 */
export function countThinFaces(triangles, grid) {
  const count = triangleCount(triangles);
  const { origin, cell } = readGrid(grid);
  const [ox, oy, oz] = origin;
  const inv = 1 / cell;
  const cell2 = cell * cell;
  let thin = 0;

  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const ax = triangles[o], ay = triangles[o + 1], az = triangles[o + 2];
    const bx = triangles[o + 3], by = triangles[o + 4], bz = triangles[o + 5];
    const gx = triangles[o + 6], gy = triangles[o + 7], gz = triangles[o + 8];
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az) ||
      !Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz) ||
      !Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(gz)
    ) continue;

    let dx = bx - ax, dy = by - ay, dz = bz - az;
    let longest = dx * dx + dy * dy + dz * dz;
    dx = gx - bx; dy = gy - by; dz = gz - bz;
    let d = dx * dx + dy * dy + dz * dz;
    if (d > longest) longest = d;
    dx = ax - gx; dy = ay - gy; dz = az - gz;
    d = dx * dx + dy * dy + dz * dz;
    if (d > longest) longest = d;

    if (longest < cell2) { thin++; continue; }

    const i = Math.floor((ax - ox) * inv);
    if (i !== Math.floor((bx - ox) * inv) || i !== Math.floor((gx - ox) * inv)) continue;
    const j = Math.floor((ay - oy) * inv);
    if (j !== Math.floor((by - oy) * inv) || j !== Math.floor((gy - oy) * inv)) continue;
    const k = Math.floor((az - oz) * inv);
    if (k !== Math.floor((bz - oz) * inv) || k !== Math.floor((gz - oz) * inv)) continue;
    thin++;
  }
  return thin;
}

export default {
  MAX_CELLS,
  gridFor,
  meshBounds,
  rasteriseShell,
  dilate,
  erode,
  closeHoles,
  fillInterior,
  countThinFaces,
  countSolid,
  sealMesh
};
