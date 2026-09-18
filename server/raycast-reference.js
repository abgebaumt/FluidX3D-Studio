/**
 * Ray-cast reference voxeliser — a deliberately faithful replica of what
 * FluidX3D itself does to a triangle mesh, weaknesses included.
 *
 * Source of truth: `kernel void voxelize_mesh` in FluidX3D/src/kernel.cpp
 * (from line 2271) plus the direction choice in FluidX3D/src/lbm.cpp
 * (LBM_Domain::voxelize_mesh_on_device, from line 275). Nothing in this
 * module reads, writes or builds anything inside FluidX3D; it only re-derives
 * the same numbers so the studio can say how many cells the solver would lose
 * if the mesh were handed to it unsealed.
 *
 * The properties that matter — and that are reproduced literally:
 *
 *   - ONE ray per cell column, along ONE axis only. The axis is the one with
 *     the smallest bounding-box cross-section area, exactly as lbm.cpp picks
 *     it. Anything a single axis-aligned ray misses is simply gone.
 *   - Ray origins sit at integer lattice coordinates, i.e. at cell centres.
 *     Geometry that fits between two lattice lines is never sampled.
 *   - Möller-Trumbore, bidirectional: hits in front of the origin are counted
 *     separately from hits behind it (the kernel's error correction).
 *   - Hit distances are stored as `(ushort)d`, i.e. TRUNCATED TO WHOLE CELLS.
 *     This is the actual cause of the vanishing-wall problem: two surfaces
 *     less than one cell apart collapse onto the same integer distance, the
 *     inside/outside state flips twice at the same column position, and the
 *     wall between them never becomes solid. This rounding is preserved on
 *     purpose — removing it would defeat the point of this module.
 *   - At most 64 intersections per column; further hits still increment the
 *     counter but are not stored.
 *   - The full odd/even logic including the two corrections in the kernel:
 *     `inside = intersections%2 && intersections_check%2`, the start bit
 *     `intersections%2 != intersections_check%2`, and the `hmesh` clamp that
 *     forces a cell outside once no further intersection lies ahead.
 *
 * Lattice convention. voxel-seal.js places cell (i,j,k) over
 * [origin[a]+n*cell, origin[a]+(n+1)*cell]. FluidX3D works in lattice units
 * where one cell is one unit and the ray origin of cell n is at coordinate n
 * (kernel.cpp: `position(xyz)+offset` reduces to `xyz + domain offset`). The
 * conversion is therefore
 *
 *     lattice = (world - origin) / cell - 0.5,
 *
 * which puts the centre of cell n at exactly n. The returned mask uses the
 * same index scheme as rasteriseShell(): i + nx*(j + ny*k), x runs fastest —
 * which is also FluidX3D's own `index()`.
 */

/** Same ceiling as voxel-seal.js; kept local so this module stands alone. */
export const MAX_CELLS = 64_000_000;

/** Slack added to a triangle's projected bounding box when bucketing it. */
const BUCKET_EPS = 1e-4;

function fail(message) {
  const err = new Error(message);
  err.publicMessage = message;
  err.status = 400;
  return err;
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
    throw fail(`The reference grid would be too large at ${cells} cells. Please choose a larger cell size.`);
  }
  return { origin, cell, dims, cells };
}

/** C's `(int)x` — truncation towards zero — followed by clamping to [0, n-1]. */
function clampTrunc(x, n) {
  const t = Math.trunc(x);
  if (!Number.isFinite(t)) return 0;
  if (t < 0) return 0;
  if (t > n - 1) return n - 1;
  return t;
}

/**
 * Axis FluidX3D casts along: the one with the smallest bounding-box
 * cross-section area. Mirrors lbm.cpp lines 297-306, including the strict `<`
 * that keeps axis 0 on a tie. The rotational-velocity branch is irrelevant
 * here — the studio voxelises static geometry.
 *
 * @param {number[]} lo expanded bounding-box minimum, lattice units
 * @param {number[]} hi expanded bounding-box maximum, lattice units
 * @returns {0|1|2}
 */
export function chooseDirection(lo, hi) {
  const ex = hi[0] - lo[0];
  const ey = hi[1] - lo[1];
  const ez = hi[2] - lo[2];
  const v = [ey * ez, ez * ex, ex * ey];
  let direction = 0;
  let vmin = v[0];
  for (let i = 1; i < 3; i++) {
    if (v[i] < vmin) {
      vmin = v[i];
      direction = i;
    }
  }
  return direction;
}

/**
 * Voxelises a triangle soup the way FluidX3D would.
 *
 * Same signature and same index scheme as rasteriseShell() in voxel-seal.js,
 * so the two masks can be compared cell by cell.
 *
 * @param {Float32Array|number[]} triangles 9 values per triangle
 * @param {{origin:number[], cell:number, dims:number[]}} grid
 * @returns {Uint8Array} one byte per cell, 1 = FluidX3D would mark it solid
 */
export function raycastVoxelise(triangles, grid) {
  const count = triangleCount(triangles);
  const { origin, cell, dims, cells } = readGrid(grid);
  const [nx, ny, nz] = dims;
  const mask = new Uint8Array(cells);
  if (count === 0) return mask;

  // --- world -> lattice -------------------------------------------------
  // Stored as float32 because that is the precision FluidX3D's mesh buffers
  // and its ray-triangle test actually work in.
  const p = new Float32Array(count * 9);
  const inv = 1 / cell;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const usable = new Uint8Array(count); // 0 = contains a non-finite coordinate
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    let ok = 1;
    for (let c = 0; c < 9; c++) {
      const a = c % 3;
      const w = Number(triangles[o + c]);
      if (!Number.isFinite(w)) { ok = 0; break; }
      const l = (w - origin[a]) * inv - 0.5;
      p[o + c] = l;
    }
    if (!ok) continue;
    usable[t] = 1;
    for (let c = 0; c < 9; c++) {
      const a = c % 3;
      const l = p[o + c];
      if (l < lo[a]) lo[a] = l;
      if (l > hi[a]) hi[a] = l;
    }
  }
  if (!Number.isFinite(lo[0]) || !Number.isFinite(hi[0])) return mask;

  // lbm.cpp line 280: the bounding box handed to the kernel is padded by two
  // cells on every side.
  const b0 = [lo[0] - 2, lo[1] - 2, lo[2] - 2];
  const b1 = [hi[0] + 2, hi[1] + 2, hi[2] + 2];

  const direction = chooseDirection(b0, b1);

  // Axis roles: `h` runs along the ray, `u` and `v` span the column plane.
  const hAxis = direction;
  const uAxis = direction === 0 ? 1 : 0;
  const vAxis = direction === 2 ? 1 : 2;
  const nh = dims[hAxis];
  const nu = dims[uAxis];
  const nv = dims[vAxis];

  // kernel.cpp lines 2281-2289: the column starts at hmin and stops at hmax.
  const hmin = clampTrunc(b0[hAxis], nh);
  const hmax = clampTrunc(b1[hAxis], nh);

  // idx = baseOf(u,v) + h*stepH, matching i + nx*(j + ny*k).
  const nxy = nx * ny;
  let stepH;
  let stepU;
  let stepV;
  if (direction === 0) { stepH = 1; stepU = nx; stepV = nxy; }
  else if (direction === 1) { stepH = nx; stepU = 1; stepV = nxy; }
  else { stepH = nxy; stepU = 1; stepV = nx; }

  // --- column buckets ---------------------------------------------------
  // A ray at (u,v) can only meet a triangle whose projection onto the column
  // plane covers the integer point (u,v). Bucketing by that box is exact:
  // it can only add candidates, never drop a real hit, and every candidate
  // still goes through the unmodified Möller-Trumbore test below.
  const columns = nu * nv;
  const counts = new Int32Array(columns + 1);
  const uLo = new Int32Array(count);
  const uHi = new Int32Array(count);
  const vLo = new Int32Array(count);
  const vHi = new Int32Array(count);
  let entries = 0;
  for (let t = 0; t < count; t++) {
    if (!usable[t]) { uLo[t] = 0; uHi[t] = -1; continue; }
    const o = t * 9;
    const a1 = p[o + uAxis], b1u = p[o + 3 + uAxis], c1 = p[o + 6 + uAxis];
    const a2 = p[o + vAxis], b2 = p[o + 3 + vAxis], c2 = p[o + 6 + vAxis];
    let mn = a1 < b1u ? a1 : b1u; if (c1 < mn) mn = c1;
    let mx = a1 > b1u ? a1 : b1u; if (c1 > mx) mx = c1;
    let i0 = Math.ceil(mn - BUCKET_EPS);
    let i1 = Math.floor(mx + BUCKET_EPS);
    if (i0 < 0) i0 = 0;
    if (i1 > nu - 1) i1 = nu - 1;
    mn = a2 < b2 ? a2 : b2; if (c2 < mn) mn = c2;
    mx = a2 > b2 ? a2 : b2; if (c2 > mx) mx = c2;
    let j0 = Math.ceil(mn - BUCKET_EPS);
    let j1 = Math.floor(mx + BUCKET_EPS);
    if (j0 < 0) j0 = 0;
    if (j1 > nv - 1) j1 = nv - 1;
    uLo[t] = i0; uHi[t] = i1; vLo[t] = j0; vHi[t] = j1;
    if (i1 < i0 || j1 < j0) continue;
    for (let j = j0; j <= j1; j++) {
      const row = nu * j;
      for (let i = i0; i <= i1; i++) counts[row + i + 1]++;
    }
    entries += (i1 - i0 + 1) * (j1 - j0 + 1);
  }
  for (let c = 0; c < columns; c++) counts[c + 1] += counts[c];
  const start = counts; // prefix sums; counts[c] is now the first slot of column c
  const cursor = Int32Array.from(start.subarray(0, columns));
  const items = new Int32Array(entries);
  for (let t = 0; t < count; t++) {
    const i0 = uLo[t], i1 = uHi[t], j0 = vLo[t], j1 = vHi[t];
    if (i1 < i0 || j1 < j0) continue;
    for (let j = j0; j <= j1; j++) {
      const row = nu * j;
      for (let i = i0; i <= i1; i++) items[cursor[row + i]++] = t;
    }
  }

  // --- one ray per column ------------------------------------------------
  const rdx = direction === 0 ? 1 : 0;
  const rdy = direction === 1 ? 1 : 0;
  const rdz = direction === 2 ? 1 : 0;
  const distances = new Uint16Array(64); // kernel.cpp line 2294
  const uMin = b0[uAxis], uMax = b1[uAxis];
  const vMin = b0[vAxis], vMax = b1[vAxis];

  for (let v = 0; v < nv; v++) {
    // kernel.cpp line 2295-2296: columns outside the padded box return early.
    if (v < vMin || v >= vMax) continue;
    for (let u = 0; u < nu; u++) {
      if (u < uMin || u >= uMax) continue;
      const first = start[nu * v + u];
      const last = start[nu * v + u + 1];
      if (first === last) continue; // no candidate triangle: column stays empty

      // Ray origin: cell centre of (hmin, u, v) in lattice units, i.e. always
      // an integer triple. Geometry between two lattice lines is never sampled.
      const ox = direction === 0 ? hmin : u;                       // dir 1|2: uAxis is x
      const oy = direction === 0 ? u : direction === 1 ? hmin : v; // dir 0: uAxis is y
      const oz = direction === 2 ? hmin : v;                       // dir 0|1: vAxis is z

      let intersections = 0;
      let intersectionsCheck = 0;
      distances.fill(0);

      for (let e = first; e < last; e++) {
        const o = items[e] * 9;
        const p0x = p[o], p0y = p[o + 1], p0z = p[o + 2];
        // Möller-Trumbore, bidirectional — kernel.cpp lines 2302-2311.
        const ux = p[o + 3] - p0x, uy = p[o + 4] - p0y, uz = p[o + 5] - p0z;
        const vx = p[o + 6] - p0x, vy = p[o + 7] - p0y, vz = p[o + 8] - p0z;
        const wx = ox - p0x, wy = oy - p0y, wz = oz - p0z;
        const hx = rdy * vz - rdz * vy;
        const hy = rdz * vx - rdx * vz;
        const hz = rdx * vy - rdy * vx;
        const qx = wy * uz - wz * uy;
        const qy = wz * ux - wx * uz;
        const qz = wx * uy - wy * ux;
        const g = ux * hx + uy * hy + uz * hz;
        if (g === 0) continue; // guard against 1/0 exactly as the kernel does
        const f = 1 / g;
        const s = f * (wx * hx + wy * hy + wz * hz);
        const tb = f * (rdx * qx + rdy * qy + rdz * qz);
        const d = f * (vx * qx + vy * qy + vz * qz);
        if (s >= 0 && s < 1 && tb >= 0 && s + tb < 1) {
          if (d > 0) { // intersection ahead of the ray origin
            // The truncation that loses sub-cell geometry.
            if (intersections < 64 && d < 65536) distances[intersections] = Math.trunc(d);
            intersections++;
          } else { // intersection behind: second ray, used as a sanity check
            intersectionsCheck++;
          }
        }
      }

      if (intersections === 0) continue; // nothing ahead: whole column outside

      // Insertion sort over the stored distances — kernel.cpp lines 2313-2321.
      const stored = intersections < 64 ? intersections : 64;
      for (let i = 1; i < stored; i++) {
        const key = distances[i];
        let j = i;
        while (j > 0 && distances[j - 1] > key) {
          distances[j] = distances[j - 1];
          j--;
        }
        distances[j] = key;
      }

      let inside = intersections % 2 !== 0 && intersectionsCheck % 2 !== 0;
      // Start at the second intersection when the forward and backward hit
      // counts disagree in evenness (the kernel's error correction).
      let intersection = intersections % 2 !== intersectionsCheck % 2 ? 1 : 0;
      // `intersections-1u` underflows to 0xFFFFFFFF when there are none, so
      // the kernel's min() lands on slot 63; intersections>0 is granted here.
      const hmesh = hmin + distances[intersections - 1 < 63 ? intersections - 1 : 63];

      const base = stepU * u + stepV * v;
      for (let h = hmin; h <= hmax; h++) {
        while (intersection < intersections && h > hmin + distances[intersection < 63 ? intersection : 63]) {
          inside = !inside; // crossed a surface, flip the state
          intersection++;
        }
        // A cell must be outside once no further intersection lies ahead.
        inside = inside && intersection < intersections && h < hmesh;
        if (inside) mask[base + stepH * h] = 1;
      }
    }
  }

  return mask;
}

/**
 * Cells the reference method marks solid, and cells it drops relative to a
 * correctly voxelised mask.
 *
 * @param {Uint8Array} correct mask from the sealing pipeline
 * @param {Uint8Array} reference mask from raycastVoxelise()
 * @returns {{raycastCells:number, lostCells:number}}
 */
export function compareMasks(correct, reference) {
  if (!correct || !reference || correct.length !== reference.length) {
    throw fail("The two masks do not match.");
  }
  let raycastCells = 0;
  let lostCells = 0;
  for (let i = 0; i < correct.length; i++) {
    const r = reference[i] !== 0;
    if (r) raycastCells++;
    if (correct[i] !== 0 && !r) lostCells++;
  }
  return { raycastCells, lostCells };
}

export default { MAX_CELLS, chooseDirection, raycastVoxelise, compareMasks };
