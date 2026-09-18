/**
 * Tests for server/voxel-seal.js — the voxel side of CONTRACT.md section 8.
 *
 * Nothing here starts a server, builds FluidX3D or writes a file. The last
 * test seals a real binary STL named by the environment variable
 * STUDIO_TEST_STL (read only) and skips itself when the variable is not set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  gridFor,
  meshBounds,
  rasteriseShell,
  dilate,
  erode,
  closeHoles,
  fillInterior,
  countSolid,
  countThinFaces,
  sealMesh
} from "../server/voxel-seal.js";
import { parseStl } from "../server/stl-info.js";

/** Optional real model for the last test: any binary STL, in any unit. */
const REAL_STL = process.env.STUDIO_TEST_STL ? path.resolve(process.env.STUDIO_TEST_STL) : null;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Collects triangles as a flat list, 9 values each. */
function mesh() {
  const values = [];
  const m = {
    tri(a, b, c) {
      values.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      return m;
    },
    /** Quad a-b-c-d as two triangles. */
    quad(a, b, c, d) {
      return m.tri(a, b, c).tri(a, c, d);
    },
    get count() {
      return values.length / 9;
    },
    build() {
      return new Float32Array(values);
    }
  };
  return m;
}

/**
 * Closed axis-aligned box. `skip` names faces to leave out, which is how the
 * open-body fixtures are made.
 */
function boxMesh(min, max, skip = []) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const m = mesh();
  const want = (face) => !skip.includes(face);
  if (want("zmin")) m.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  if (want("zmax")) m.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  if (want("ymin")) m.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  if (want("ymax")) m.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
  if (want("xmin")) m.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
  if (want("xmax")) m.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return m.build();
}

/** Box whose top face carries a rectangular hole — the fixture for closing. */
function boxWithHole(min, max, hole) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const [hx0, hy0, hx1, hy1] = hole;
  const m = mesh();
  m.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  m.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  m.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
  m.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
  m.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  // Top face as four strips around the opening.
  m.quad([x0, y0, z1], [x1, y0, z1], [x1, hy0, z1], [x0, hy0, z1]);
  m.quad([x0, hy1, z1], [x1, hy1, z1], [x1, y1, z1], [x0, y1, z1]);
  m.quad([x0, hy0, z1], [hx0, hy0, z1], [hx0, hy1, z1], [x0, hy1, z1]);
  m.quad([hx1, hy0, z1], [x1, hy0, z1], [x1, hy1, z1], [hx1, hy1, z1]);
  return m.build();
}

/**
 * Thin plate whose top and bottom are tessellated into `nu` x `nv` quads —
 * the way a real STL export looks. Every one of those triangles is smaller
 * than a typical cell; the four narrow side walls stay single quads and are
 * not.
 */
function tessellatedPlate(min, max, nu, nv) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const m = mesh();
  const dx = (x1 - x0) / nu;
  const dy = (y1 - y0) / nv;
  for (const z of [z0, z1]) {
    for (let u = 0; u < nu; u++) {
      for (let v = 0; v < nv; v++) {
        const a = x0 + u * dx;
        const b = y0 + v * dy;
        m.quad([a, b, z], [a + dx, b, z], [a + dx, b + dy, z], [a, b + dy, z]);
      }
    }
  }
  m.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  m.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
  m.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
  m.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return m.build();
}

/** Closed UV sphere. */
function sphereMesh(centre, radius, stacks = 24, slices = 48) {
  const [cx, cy, cz] = centre;
  const m = mesh();
  const point = (s, l) => {
    const phi = (Math.PI * s) / stacks;
    const theta = (2 * Math.PI * l) / slices;
    return [
      cx + radius * Math.sin(phi) * Math.cos(theta),
      cy + radius * Math.sin(phi) * Math.sin(theta),
      cz + radius * Math.cos(phi)
    ];
  };
  for (let s = 0; s < stacks; s++) {
    for (let l = 0; l < slices; l++) {
      const a = point(s, l);
      const b = point(s + 1, l);
      const c = point(s + 1, l + 1);
      const d = point(s, l + 1);
      if (s === 0) m.tri(a, b, c);
      else if (s === stacks - 1) m.tri(a, b, d);
      else m.quad(a, b, c, d);
    }
  }
  return m.build();
}

/** Reads a binary STL buffer into a flat Float32Array, 9 values per triangle. */
function readBinaryStl(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const count = view.getUint32(80, true);
  assert.ok(buffer.byteLength >= 84 + 50 * count, "the STL is shorter than its header claims");
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    let off = 84 + t * 50 + 12; // skip the normal
    for (let v = 0; v < 9; v++, off += 4) out[t * 9 + v] = view.getFloat32(off, true);
  }
  return out;
}

/** Mask with a single solid cell in the middle of a cubic grid. */
function singleCell(n) {
  const mask = new Uint8Array(n * n * n);
  const c = (n - 1) >> 1;
  mask[c + n * (c + n * c)] = 1;
  return { mask, dims: [n, n, n], centre: c };
}

/* ------------------------------------------------------------------ *
 * gridFor
 * ------------------------------------------------------------------ */

test("gridFor snaps the origin to a multiple of the cell size and adds a margin", () => {
  const grid = gridFor({ min: [0.2, -1.3, 5.05], max: [4.2, 0.7, 5.9] }, 1, 2);
  assert.deepEqual(grid.origin, [-2, -4, 3]); // floor(min/cell)*cell - margin*cell
  assert.equal(grid.cell, 1);
  assert.deepEqual(grid.dims, [9, 7, 5]);
});

test("gridFor encloses the box completely", () => {
  const bbox = { min: [-2.6, -3.97, -1.14], max: [2.6, 5.69, 1.4] };
  const cell = 0.0588;
  const grid = gridFor(bbox, cell, 3);
  for (let a = 0; a < 3; a++) {
    assert.ok(grid.origin[a] <= bbox.min[a] - 3 * cell + 1e-9, `origin on axis ${a}`);
    const end = grid.origin[a] + grid.dims[a] * cell;
    assert.ok(end >= bbox.max[a] + 3 * cell - 1e-9, `end on axis ${a}`);
  }
});

test("gridFor rejects unusable input with a readable message", () => {
  assert.throws(() => gridFor({ min: [0, 0, 0], max: [1, 1, 1] }, 0), /cell size/);
  assert.throws(() => gridFor({ min: [0, 0, 0], max: [1, 1, 1] }, -1), /cell size/);
  assert.throws(() => gridFor(null, 1), /bounding box/);
  assert.throws(() => gridFor({ min: [0, 0, 0], max: [1, 1, 1] }, 1e-6), /too large/);
});

test("meshBounds returns the hull of all vertices", () => {
  const bounds = meshBounds(boxMesh([0.2, -1, 3], [4.2, 2, 3.5]));
  assert.deepEqual(bounds.min.map((v) => Number(v.toFixed(3))), [0.2, -1, 3]);
  assert.deepEqual(bounds.max.map((v) => Number(v.toFixed(3))), [4.2, 2, 3.5]);
});

/* ------------------------------------------------------------------ *
 * rasteriseShell
 * ------------------------------------------------------------------ */

test("rasteriseShell marks exactly the surface cells of a cube", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  const grid = gridFor(meshBounds(triangles), 1, 2);
  assert.deepEqual(grid.dims, [9, 9, 9]);
  const mask = rasteriseShell(triangles, grid);
  // 5x5x5 cells touched, of which 3x3x3 inside stay empty.
  assert.equal(countSolid(mask), 5 * 5 * 5 - 3 * 3 * 3);

  const [nx, ny] = grid.dims;
  const at = (i, j, k) => mask[i + nx * (j + ny * k)];
  assert.equal(at(2, 2, 2), 1, "corner cell of the cube");
  assert.equal(at(4, 4, 4), 0, "cell in the middle of the hollow cube");
  assert.equal(at(1, 4, 4), 0, "cell in the margin outside");
});

test("CORE CASE: a plate thinner than one cell keeps solid cells", () => {
  const cell = 0.5;
  // 2 cm thick at a 50 cm cell size — FluidX3D's ray-cast voxelisation makes
  // a wall like this vanish completely.
  const triangles = boxMesh([1.03, 1.07, 1.21], [2.97, 2.44, 1.23]);
  const grid = gridFor(meshBounds(triangles), cell, 2);
  const mask = rasteriseShell(triangles, grid);

  const solid = countSolid(mask);
  assert.ok(solid > 0, "the thin plate must not vanish");
  // Footprint: 4 cells in x, 3 in y, exactly one layer in z.
  assert.equal(solid, 4 * 3 * 1);

  const [nx, ny, nz] = grid.dims;
  let layers = 0;
  for (let k = 0; k < nz; k++) {
    let any = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) any |= mask[i + nx * (j + ny * k)];
    if (any) layers++;
  }
  assert.equal(layers, 1, "the plate lies entirely within one cell layer");
});

test("a thin plate on a cell boundary fills both neighbouring layers", () => {
  const triangles = boxMesh([1.03, 1.07, 1.49], [2.97, 2.44, 1.51]);
  const grid = gridFor(meshBounds(triangles), 0.5, 2);
  assert.equal(countSolid(rasteriseShell(triangles, grid)), 4 * 3 * 2);
});

test("a single triangle smaller than one cell fills one cell", () => {
  const triangles = new Float32Array([
    2.10, 2.10, 2.10,
    2.13, 2.10, 2.10,
    2.10, 2.13, 2.12
  ]);
  const grid = gridFor(meshBounds(triangles), 1, 2);
  assert.equal(countSolid(rasteriseShell(triangles, grid)), 1);
});

test("rasteriseShell skips triangles outside the grid", () => {
  const grid = { origin: [0, 0, 0], cell: 1, dims: [4, 4, 4] };
  const triangles = new Float32Array([
    20, 20, 20, 21, 20, 20, 20, 21, 20, // far outside
    1.5, 1.5, 1.5, 1.6, 1.5, 1.5, 1.5, 1.6, 1.5 // cell (1,1,1)
  ]);
  const mask = rasteriseShell(triangles, grid);
  assert.equal(countSolid(mask), 1);
  assert.equal(mask[1 + 4 * (1 + 4 * 1)], 1);
});

/* ------------------------------------------------------------------ *
 * Morphology
 * ------------------------------------------------------------------ */

test("dilate grows by radius cells in every direction", () => {
  const { mask, dims } = singleCell(11);
  assert.equal(countSolid(dilate(mask, dims, 0)), 1);
  assert.equal(countSolid(dilate(mask, dims, 1)), 27);
  assert.equal(countSolid(dilate(mask, dims, 2)), 125);
  assert.equal(countSolid(dilate(mask, dims, 3)), 343);
  assert.equal(countSolid(mask), 1, "the input mask stays unchanged");
});

test("erode reverses dilate, closeHoles keeps a single cell", () => {
  const { mask, dims, centre } = singleCell(11);
  const grown = dilate(mask, dims, 2);
  const shrunk = erode(grown, dims, 2);
  assert.equal(countSolid(shrunk), 1);
  assert.equal(shrunk[centre + 11 * (centre + 11 * centre)], 1);
  assert.equal(countSolid(closeHoles(mask, dims, 2)), 1);
  assert.equal(countSolid(closeHoles(mask, dims, 0)), 1);
});

test("erode removes a blob smaller than the radius", () => {
  const { mask, dims } = singleCell(11);
  assert.equal(countSolid(erode(dilate(mask, dims, 1), dims, 2)), 0);
});

test("the grid border neither dilates nor erodes wrongly", () => {
  const dims = [5, 5, 5];
  const corner = new Uint8Array(125);
  corner[0] = 1; // cell (0,0,0)
  assert.equal(countSolid(dilate(corner, dims, 1)), 8, "dilation stops at the grid border");

  const full = new Uint8Array(125).fill(1);
  assert.equal(countSolid(erode(full, dims, 2)), 125, "cells outside the grid do not erode the body");
});

test("closeHoles closes a gap narrower than 2*radius", () => {
  // A margin of radius+2 cells all round, as the contract requires of the caller.
  const dims = [9, 9, 7];
  const mask = new Uint8Array(9 * 9 * 7);
  const at = (i, j, k) => i + 9 * (j + 9 * k);
  for (let j = 2; j <= 6; j++) for (let i = 2; i <= 6; i++) mask[at(i, j, 3)] = 1;
  mask[at(4, 4, 3)] = 0; // a one-cell hole
  assert.equal(countSolid(mask), 24);
  const closed = closeHoles(mask, dims, 1);
  assert.equal(closed[at(4, 4, 3)], 1, "the hole is closed");
  assert.equal(countSolid(closed), 25, "the outer contour stays where it was");
});

/* ------------------------------------------------------------------ *
 * fillInterior
 * ------------------------------------------------------------------ */

test("fillInterior fills a hollow body and reports closed=true", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  const grid = gridFor(meshBounds(triangles), 1, 2);
  const shell = rasteriseShell(triangles, grid);
  const result = fillInterior(shell, grid.dims);

  assert.equal(result.closed, true);
  assert.equal(result.filledCells, 27);
  assert.equal(countSolid(result.mask), 125);
  assert.equal(countSolid(shell), 98, "the input mask stays unchanged");

  const [nx, ny] = grid.dims;
  assert.equal(result.mask[4 + nx * (4 + ny * 4)], 1, "the centre is solid now");
  assert.equal(result.mask[0], 0, "the outside stays empty");
});

test("fillInterior reports closed=false for an open body", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2], ["zmax"]);
  const grid = gridFor(meshBounds(triangles), 1, 2);
  const result = fillInterior(rasteriseShell(triangles, grid), grid.dims);
  assert.equal(result.closed, false);
  assert.equal(result.filledCells, 0);
});

test("fillInterior reports closed=false for a single face", () => {
  const m = mesh().quad([0.2, 0.2, 1.2], [4.2, 0.2, 1.2], [4.2, 4.2, 1.2], [0.2, 4.2, 1.2]);
  const triangles = m.build();
  const grid = gridFor(meshBounds(triangles), 1, 2);
  const result = fillInterior(rasteriseShell(triangles, grid), grid.dims);
  assert.equal(result.closed, false);
  assert.equal(result.filledCells, 0);
});

test("closeHoles seals a housing with a hole, after which the fill is closed", () => {
  const triangles = boxWithHole([3.05, 3.05, 3.05], [9.05, 9.05, 9.05], [4.9, 4.9, 7.1, 7.1]);
  const grid = gridFor(meshBounds(triangles), 1, 3);
  const shell = rasteriseShell(triangles, grid);

  const leaky = fillInterior(shell, grid.dims);
  assert.equal(leaky.closed, false, "the fill runs inside through the hole");
  assert.equal(leaky.filledCells, 0);

  const sealed = fillInterior(closeHoles(shell, grid.dims, 1), grid.dims);
  assert.equal(sealed.closed, true, "after closing, the body is watertight");
  assert.ok(sealed.filledCells > 0);
});

test("a hole that is too large needs a larger radius", () => {
  const triangles = boxWithHole([3.05, 3.05, 3.05], [9.05, 9.05, 9.05], [4.9, 4.9, 8.1, 8.1]);
  const grid = gridFor(meshBounds(triangles), 1, 4);
  const shell = rasteriseShell(triangles, grid);
  assert.equal(fillInterior(closeHoles(shell, grid.dims, 1), grid.dims).closed, false);
  assert.equal(fillInterior(closeHoles(shell, grid.dims, 2), grid.dims).closed, true);
});

test("a sphere is filled and matches its volume", () => {
  const cell = 0.4;
  const radius = 2.5;
  const triangles = sphereMesh([0.13, -0.27, 0.41], radius, 32, 64);
  const grid = gridFor(meshBounds(triangles), cell, 2);
  const result = fillInterior(rasteriseShell(triangles, grid), grid.dims);

  assert.equal(result.closed, true);
  // Every cell whose cube intersects the sphere is solid: at least the sphere
  // volume, at most that of a sphere one cell larger.
  const volume = (r) => ((4 / 3) * Math.PI * r ** 3) / cell ** 3;
  const solid = countSolid(result.mask);
  assert.ok(solid > volume(radius), `too few cells: ${solid}`);
  assert.ok(solid < volume(radius + cell), `too many cells: ${solid}`);
});

/* ------------------------------------------------------------------ *
 * thinFaces
 * ------------------------------------------------------------------ */

test("countThinFaces counts triangles below the cell size", () => {
  const m = mesh();
  // Four large triangles, edge length 4 and 5.66 — not thin.
  m.quad([0.2, 0.2, 0.2], [4.2, 0.2, 0.2], [4.2, 4.2, 0.2], [0.2, 4.2, 0.2]);
  m.quad([0.2, 0.2, 4.2], [4.2, 0.2, 4.2], [4.2, 4.2, 4.2], [0.2, 4.2, 4.2]);
  // Five triangles with a longest edge of 0.1.
  for (let i = 0; i < 5; i++) {
    const x = 1 + i * 0.5;
    m.tri([x, 1, 1], [x + 0.1, 1, 1], [x, 1.1, 1]);
  }
  const triangles = m.build();
  const grid = gridFor(meshBounds(triangles), 1, 2);
  assert.equal(countThinFaces(triangles, grid), 5);
});

test("countThinFaces also counts triangles lying entirely within one cell", () => {
  // Longest edge 1.27 > cell size 1, yet entirely inside the cell [2,3]^3.
  const inside = [2.05, 2.05, 2.05, 2.95, 2.95, 2.05, 2.95, 2.05, 2.95];
  // Same size, but placed across a cell boundary — not thin.
  const across = [2.55, 2.55, 2.55, 3.45, 3.45, 2.55, 3.45, 2.55, 3.45];
  const grid = { origin: [0, 0, 0], cell: 1, dims: [8, 8, 8] };
  assert.equal(countThinFaces(new Float32Array(inside), grid), 1);
  assert.equal(countThinFaces(new Float32Array(across), grid), 0);
});

/* ------------------------------------------------------------------ *
 * sealMesh — the whole chain
 * ------------------------------------------------------------------ */

test("sealMesh in fill mode turns the hollow body into a block", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  const { mask, grid, stats } = sealMesh(triangles, {
    cell: 1,
    mode: "fill",
    closeHoles: 0,
    minThickness: 1
  });

  assert.deepEqual(grid.dims, [9, 9, 9]);
  assert.deepEqual(stats.grid, [9, 9, 9]);
  assert.equal(stats.cells, 729);
  assert.equal(mask.length, 729);
  assert.equal(stats.trianglesIn, 12);
  assert.equal(stats.shellCells, 98);
  assert.equal(stats.filledCells, 27);
  assert.equal(stats.solidCells, 125);
  assert.equal(stats.closed, true);
  assert.equal(stats.thinFaces, 0);
});

test("sealMesh in shell mode leaves the body hollow", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  const { stats } = sealMesh(triangles, { cell: 1, mode: "shell", closeHoles: 0, minThickness: 1 });
  assert.equal(stats.solidCells, 98);
  assert.equal(stats.shellCells, 98);
  assert.equal(stats.filledCells, 0);
  assert.equal(stats.closed, true, "watertightness is reported in shell mode too");
});

test("sealMesh thickens the shell to the requested minimum thickness", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  const thin = sealMesh(triangles, { cell: 1, mode: "shell", closeHoles: 0, minThickness: 1 });
  const thick = sealMesh(triangles, { cell: 1, mode: "shell", closeHoles: 0, minThickness: 2 });
  assert.ok(thick.stats.solidCells > thin.stats.solidCells);
  // 5^3 - 3^3 becomes 7^3 - 1^3: one more cell of wall inwards and outwards.
  assert.equal(thick.stats.solidCells, 7 ** 3 - 1);
  assert.equal(thick.stats.shellCells, 98, "shellCells stays the raw rasterisation");
});

test("sealMesh reports the thin faces that would be lost without sealing", () => {
  const cell = 0.5;
  // A 2 cm thick plate, top and bottom split into 10 x 7 tiles of about
  // 0.19 m — each of these 280 triangles is smaller than one cell.
  const triangles = tessellatedPlate([1.03, 1.07, 1.21], [2.97, 2.44, 1.23], 10, 7);
  const { stats } = sealMesh(triangles, { cell, mode: "fill", closeHoles: 0, minThickness: 1 });

  assert.equal(stats.trianglesIn, 2 * 2 * 10 * 7 + 8);
  assert.equal(stats.thinFaces, 2 * 2 * 10 * 7, "the long side walls do not count");
  assert.equal(stats.solidCells, 12, "the plate survives rasterisation completely");
});

test("sealMesh does not count coarsely meshed faces as thin", () => {
  // The same plate, but made of a few large triangles: thinFaces measures the
  // triangle size, not the wall thickness.
  const triangles = boxMesh([1.03, 1.07, 1.21], [2.97, 2.44, 1.23]);
  const { stats } = sealMesh(triangles, { cell: 0.5, mode: "fill", closeHoles: 0, minThickness: 1 });
  assert.equal(stats.trianglesIn, 12);
  assert.equal(stats.thinFaces, 0);
  assert.equal(stats.solidCells, 12);
});

test("sealMesh still fills a housing with a hole thanks to close_holes", () => {
  const triangles = boxWithHole([3.05, 3.05, 3.05], [9.05, 9.05, 9.05], [4.9, 4.9, 7.1, 7.1]);
  const open = sealMesh(triangles, { cell: 1, mode: "fill", closeHoles: 0, minThickness: 1 });
  assert.equal(open.stats.closed, false);
  assert.equal(open.stats.filledCells, 0);

  const sealed = sealMesh(triangles, { cell: 1, mode: "fill", closeHoles: 1, minThickness: 1 });
  assert.equal(sealed.stats.closed, true);
  assert.ok(sealed.stats.filledCells > 0);
  assert.ok(sealed.stats.solidCells > open.stats.solidCells);
});

test("sealMesh also returns origin, cell size and dimensions directly", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  const out = sealMesh(triangles, { cell: 1, mode: "fill", closeHoles: 0, minThickness: 1 });
  assert.deepEqual(out.dims, out.grid.dims);
  assert.deepEqual(out.origin, out.grid.origin);
  assert.equal(out.cell, out.grid.cell);
  assert.deepEqual(out.origin, [-2, -2, -2]);
  assert.equal(out.mask.length, out.dims[0] * out.dims[1] * out.dims[2]);
});

test("sealMesh keeps the margin clear even when the caller asks for too little", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  for (const closeRadius of [0, 1, 2, 3]) {
    const { mask, grid, stats } = sealMesh(triangles, {
      cell: 1,
      mode: "fill",
      closeHoles: closeRadius,
      minThickness: 1,
      margin: 2 // too tight for radius 2 and 3 — sealMesh must enlarge it
    });
    const [nx, ny, nz] = grid.dims;
    assert.equal(nx, 5 + 2 * Math.max(2, closeRadius + 2), `margin at radius ${closeRadius}`);
    let border = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const onBorder = i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1;
          if (onBorder) border += mask[i + nx * (j + ny * k)];
        }
      }
    }
    assert.equal(border, 0, `margin is occupied at radius ${closeRadius}`);
    assert.ok(stats.solidCells < stats.cells / 2, "the fill has not leaked out");
    assert.equal(stats.closed, true, `closed at radius ${closeRadius}`);
  }
});

test("a cavity filled up entirely by closing still counts as watertight", () => {
  // Radius 3 swallows the 3x3x3 cavity completely: nothing is left to fill,
  // yet the body was watertight.
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  const { stats } = sealMesh(triangles, { cell: 1, mode: "fill", closeHoles: 3, minThickness: 1 });
  assert.equal(stats.filledCells, 0);
  assert.equal(stats.closed, true);
  assert.equal(stats.solidCells, 125, "the outer contour stays where it was");
});

test("sealMesh honours a cell limit lowered by the caller", () => {
  const triangles = boxMesh([0.2, 0.2, 0.2], [4.2, 4.2, 4.2]);
  assert.throws(() => sealMesh(triangles, { cell: 1, maxCells: 100 }), /too large/);
  assert.doesNotThrow(() => sealMesh(triangles, { cell: 1, maxCells: 1000 }));
});

test("sealMesh rejects unusable input with a readable message", () => {
  assert.throws(() => sealMesh(new Float32Array(0), { cell: 1 }), /contains no triangles/);
  assert.throws(() => sealMesh(new Float32Array(5), { cell: 1 }), /multiple of 9/);
  assert.throws(() => sealMesh(boxMesh([0, 0, 0], [1, 1, 1]), { cell: 0 }), /cell size/);
});

/* ------------------------------------------------------------------ *
 * A real STL (STUDIO_TEST_STL)
 * ------------------------------------------------------------------ */

test("a real STL from STUDIO_TEST_STL is sealed locally", { timeout: 180000 }, (t) => {
  if (!REAL_STL) {
    t.skip("STUDIO_TEST_STL is not set — give the path to a binary STL to run this test");
    return;
  }
  if (!fs.existsSync(REAL_STL)) {
    t.skip(`STUDIO_TEST_STL points to ${REAL_STL}, the file does not exist`);
    return;
  }
  const buffer = fs.readFileSync(REAL_STL);
  const info = parseStl(buffer);
  if (info.format !== "binary") {
    t.skip(`${REAL_STL} is an ASCII STL — this test only reads binary STL`);
    return;
  }
  const triangles = readBinaryStl(buffer);
  assert.equal(triangles.length / 9, info.triangles);

  // The cell size follows the model, whatever its unit: at least 400 cells
  // along the longest edge (a 25 m body at 5.88 cm has about 430), coarser
  // only where that would put more than four million cells into the bounding
  // box. Same rule as the real-STL test in mesh-surface.test.js.
  const extent = [0, 1, 2].map((a) => info.bbox.max[a] - info.bbox.min[a]);
  const longest = Math.max(...extent);
  assert.ok(longest > 0, "the test file has no extent");
  const cell = Math.max(longest / 400, Math.cbrt((extent[0] * extent[1] * extent[2]) / 4_000_000));

  const closeRadius = 1;
  const started = process.hrtime.bigint();
  const { mask, grid, stats } = sealMesh(triangles, {
    cell,
    mode: "fill",
    closeHoles: closeRadius,
    minThickness: 1
  });
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  assert.equal(stats.trianglesIn, info.triangles);
  assert.equal(mask.length, stats.cells);
  assert.ok(stats.solidCells > 0);
  assert.ok(stats.shellCells > 0);
  assert.ok(stats.solidCells >= stats.shellCells);
  assert.ok(stats.lostFraction >= 0 && stats.lostFraction <= 1, `lostFraction ${stats.lostFraction}`);

  // The grid is local: it covers the bounding box and adds no more than the
  // margin sealMesh() needs (closing radius + 2) plus one cell of snapping.
  const margin = closeRadius + 2;
  for (let a = 0; a < 3; a++) {
    assert.ok(grid.origin[a] <= info.bbox.min[a] + 1e-9 * longest, `axis ${a}: grid starts too late`);
    assert.ok(grid.origin[a] + grid.dims[a] * cell >= info.bbox.max[a] - 1e-9 * longest, `axis ${a}: grid ends too early`);
    assert.ok(grid.dims[a] <= Math.ceil(extent[a] / cell) + 1 + 2 * margin,
      `axis ${a}: grid is not local (${grid.dims[a]} cells)`);
  }

  const size = [0, 1, 2].map((a) => (grid.dims[a] * cell).toPrecision(3));
  t.diagnostic(`file: ${REAL_STL}, ${stats.trianglesIn} triangles, cell size ${cell.toPrecision(3)}`);
  t.diagnostic(`grid: ${stats.grid.join(" x ")} = ${stats.cells} cells, ${size.join(" x ")}`);
  t.diagnostic(`shell: ${stats.shellCells}, filled: ${stats.filledCells}, solid: ${stats.solidCells}`);
  t.diagnostic(`closed: ${stats.closed}, thin faces: ${stats.thinFaces}`);
  t.diagnostic(`runtime: ${seconds.toFixed(2)} s`);
});
