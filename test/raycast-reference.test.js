/**
 * Tests for server/raycast-reference.js — the replica of FluidX3D's own
 * `voxelize_mesh` kernel.
 *
 * The point of the module is to reproduce a specific failure, so the decisive
 * test is a plate thinner than one cell: the shell rasteriser must keep it,
 * the ray cast must lose it completely. Without that the loss statistic in
 * sealMesh() would be measuring nothing.
 *
 * The counterweight is a thick cube: both methods must agree closely there,
 * otherwise the replica is merely pessimistic and every reported loss would be
 * inflated by it.
 *
 * Nothing here starts a server, builds FluidX3D or writes a file.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  gridFor,
  rasteriseShell,
  fillInterior,
  countSolid,
  sealMesh
} from "../server/voxel-seal.js";
import { raycastVoxelise, chooseDirection, compareMasks } from "../server/raycast-reference.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Closed axis-aligned box as a flat triangle list, 9 values per triangle. */
function boxMesh(min, max) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const v = [];
  const tri = (a, b, c) => v.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return new Float32Array(v);
}

/** The mask the correct pipeline produces: shell rasterisation plus interior. */
function solidReference(triangles, grid) {
  return fillInterior(rasteriseShell(triangles, grid), grid.dims).mask;
}

/* ------------------------------------------------------------------ *
 * Direction choice — lbm.cpp lines 297-306
 * ------------------------------------------------------------------ */

test("chooseDirection picks the axis with the smallest cross-section area", () => {
  // Flat in z: the two cross-sections containing z are the smallest, and of
  // those the one with the shorter second edge wins.
  assert.equal(chooseDirection([0, 0, 0], [20, 10, 1]), 0); // 10*1 < 1*20 < 20*10
  assert.equal(chooseDirection([0, 0, 0], [10, 20, 1]), 1); // 1*10 < 20*1 < 10*20
  assert.equal(chooseDirection([0, 0, 0], [10, 1, 20]), 2); // 10*1 < 1*20, 20*10
});

test("chooseDirection stays on axis 0 on a tie", () => {
  assert.equal(chooseDirection([0, 0, 0], [5, 5, 5]), 0);
});

/* ------------------------------------------------------------------ *
 * The decisive test: a plate thinner than one cell
 * ------------------------------------------------------------------ */

test("a plate thinner than one cell survives rasterisation but not the ray cast", () => {
  // 0.3 cells thick and placed so that no lattice line runs through it: in
  // lattice coordinates the plate lies at z = 2.1 … 2.4.
  const triangles = boxMesh([0, 0, 2.6], [10, 6, 2.9]);
  const grid = gridFor({ min: [0, 0, 2.6], max: [10, 6, 2.9] }, 1, 2);

  const shell = rasteriseShell(triangles, grid);
  const rays = raycastVoxelise(triangles, grid);

  assert.ok(countSolid(shell) > 0, "the rasterisation must fill the plate");
  assert.equal(countSolid(rays), 0, "FluidX3D loses the plate completely");
});

test("the thin plate shows up as a loss in the statistics", () => {
  const triangles = boxMesh([0, 0, 2.6], [10, 6, 2.9]);
  const { stats } = sealMesh(triangles, { cell: 1, mode: "fill", closeHoles: 0, minThickness: 1 });

  assert.equal(stats.raycastCells, 0);
  assert.equal(stats.lostCells, stats.solidCells);
  assert.equal(stats.lostFraction, 1);
});

test("a plate lying exactly on a lattice line becomes a full cell layer", () => {
  // Cross-check of the test above: when the ray does hit the plate, it fills
  // its whole cell column — the fault is the sampling, not the geometry.
  const triangles = boxMesh([0, 0, 2.4], [10, 6, 2.7]); // lattice coordinates 1.9 … 2.2
  const grid = gridFor({ min: [0, 0, 2.4], max: [10, 6, 2.7] }, 1, 2);
  assert.ok(countSolid(raycastVoxelise(triangles, grid)) > 0);
});

/* ------------------------------------------------------------------ *
 * The counterweight: a thick body must come out nearly the same
 * ------------------------------------------------------------------ */

test("both methods fill a thick cube almost identically", () => {
  // 120 cells edge length. The systematic difference is just under one cell
  // layer at the surface; at this ratio it stays below 5 %.
  const triangles = boxMesh([0.3, 0.3, 0.3], [120.3, 120.3, 120.3]);
  const grid = gridFor({ min: [0.3, 0.3, 0.3], max: [120.3, 120.3, 120.3] }, 1, 2);

  const correct = countSolid(solidReference(triangles, grid));
  const rays = countSolid(raycastVoxelise(triangles, grid));

  assert.ok(correct > 1_000_000, `unexpectedly small cube: ${correct}`);
  const deviation = Math.abs(rays - correct) / correct;
  assert.ok(deviation < 0.05, `deviation of ${(deviation * 100).toFixed(2)} % is too large`);
});

test("a solid box loses only a surface layer, nothing in the core", () => {
  const triangles = boxMesh([0.3, 0.3, 0.3], [30.3, 20.3, 15.3]);
  const grid = gridFor({ min: [0.3, 0.3, 0.3], max: [30.3, 20.3, 15.3] }, 1, 2);
  const correct = solidReference(triangles, grid);
  const rays = raycastVoxelise(triangles, grid);

  // The difference is purely a sampling convention: rasterisation fills every
  // cell a triangle touches, FluidX3D only those whose centre lies inside,
  // and the hmesh correction takes one more cell at the far end of the ray.
  // Eroded two cells deep, no loss is left.
  const [nx, ny, nz] = grid.dims;
  const nxy = nx * ny;
  const r = 2;
  let coreLost = 0;
  let core = 0;
  for (let k = r; k < nz - r; k++) {
    for (let j = r; j < ny - r; j++) {
      for (let i = r; i < nx - r; i++) {
        const idx = i + nx * j + nxy * k;
        if (!correct[idx]) continue;
        let boundary = false;
        for (let d = 1; d <= r && !boundary; d++) {
          boundary =
            !correct[idx - d] || !correct[idx + d] ||
            !correct[idx - d * nx] || !correct[idx + d * nx] ||
            !correct[idx - d * nxy] || !correct[idx + d * nxy];
        }
        if (boundary) continue;
        core++;
        if (!rays[idx]) coreLost++;
      }
    }
  }
  assert.ok(core > 1000, `too few core cells for the test: ${core}`);
  assert.equal(coreLost, 0, "no cell may be missing in the core of a solid body");
});

/* ------------------------------------------------------------------ *
 * Hollow shells — the case sealing actually exists for
 * ------------------------------------------------------------------ */

test("a hollow shell with a sub-cell wall loses most of the wall", () => {
  // Two nested boxes, wall thickness 0.4 cells. Where the ray pierces the
  // wall crosswise, entry and exit fall on the same integer distance and
  // cancel out; only what the ray runs through lengthwise remains.
  const outer = boxMesh([0.2, 0.2, 0.2], [20.2, 12.2, 12.2]);
  const inner = boxMesh([0.6, 0.6, 0.6], [19.8, 11.8, 11.8]);
  const triangles = new Float32Array(outer.length + inner.length);
  triangles.set(outer, 0);
  triangles.set(inner, outer.length);

  const grid = gridFor({ min: [0.2, 0.2, 0.2], max: [20.2, 12.2, 12.2] }, 1, 2);
  const shell = rasteriseShell(triangles, grid);
  const rays = raycastVoxelise(triangles, grid);
  const kept = countSolid(rays);
  const wall = countSolid(shell);

  assert.ok(wall > 0);
  assert.ok(kept < 0.5 * wall, `ray casting keeps ${kept} of ${wall} wall cells`);
});

/* ------------------------------------------------------------------ *
 * Contract of the module itself
 * ------------------------------------------------------------------ */

test("raycastVoxelise returns the same mask layout and index scheme as rasteriseShell", () => {
  const triangles = boxMesh([0.3, 0.3, 0.3], [8.3, 6.3, 4.3]);
  const grid = gridFor({ min: [0.3, 0.3, 0.3], max: [8.3, 6.3, 4.3] }, 1, 2);
  const rays = raycastVoxelise(triangles, grid);
  const shell = rasteriseShell(triangles, grid);

  assert.ok(rays instanceof Uint8Array);
  assert.equal(rays.length, shell.length);
  assert.equal(rays.length, grid.dims[0] * grid.dims[1] * grid.dims[2]);
  for (let i = 0; i < rays.length; i++) assert.ok(rays[i] === 0 || rays[i] === 1);
});

test("raycastVoxelise hits the same cells as the rasterisation, no others", () => {
  // A solid box: every cell the ray cast fills must also lie in the correctly
  // filled body. Ray casting may only lose cells.
  const triangles = boxMesh([0.3, 0.3, 0.3], [12.3, 9.3, 7.3]);
  const grid = gridFor({ min: [0.3, 0.3, 0.3], max: [12.3, 9.3, 7.3] }, 1, 2);
  const correct = solidReference(triangles, grid);
  const rays = raycastVoxelise(triangles, grid);
  for (let i = 0; i < rays.length; i++) {
    if (rays[i]) assert.ok(correct[i], `cell ${i} is solid only in the ray cast`);
  }
});

test("raycastVoxelise rejects invalid input", () => {
  const grid = gridFor({ min: [0, 0, 0], max: [1, 1, 1] }, 1, 2);
  assert.throws(() => raycastVoxelise(new Float32Array(5), grid), /multiple of 9/);
  assert.throws(() => raycastVoxelise(new Float32Array(9), { cell: 0, origin: [0, 0, 0], dims: [1, 1, 1] }), /cell size/);
  assert.throws(() => raycastVoxelise(new Float32Array(9), null), /No valid grid/);
  assert.equal(countSolid(raycastVoxelise(new Float32Array(0), grid)), 0);
});

test("compareMasks counts the loss and the reference fill", () => {
  const correct = Uint8Array.from([1, 1, 1, 0]);
  const rays = Uint8Array.from([1, 0, 0, 1]);
  assert.deepEqual(compareMasks(correct, rays), { raycastCells: 2, lostCells: 2 });
  assert.throws(() => compareMasks(correct, new Uint8Array(3)), /do not match/);
});

/* ------------------------------------------------------------------ *
 * The statistics wiring in sealMesh()
 * ------------------------------------------------------------------ */

test("sealMesh returns lostCells, lostFraction and raycastCells", () => {
  const triangles = boxMesh([0.3, 0.3, 0.3], [12.3, 9.3, 7.3]);
  const { stats } = sealMesh(triangles, { cell: 1, mode: "fill", closeHoles: 0, minThickness: 1 });

  assert.equal(typeof stats.lostCells, "number");
  assert.equal(typeof stats.raycastCells, "number");
  assert.ok(stats.lostCells >= 0 && stats.lostCells <= stats.solidCells);
  assert.ok(Math.abs(stats.lostFraction - stats.lostCells / stats.solidCells) < 1e-12);
});

test("sealMesh lets the reference computation be switched off", () => {
  const triangles = boxMesh([0.3, 0.3, 0.3], [12.3, 9.3, 7.3]);
  const { stats } = sealMesh(triangles, { cell: 1, reference: false });
  assert.equal(stats.lostCells, null);
  assert.equal(stats.lostFraction, null);
  assert.equal(stats.raycastCells, null);
  assert.equal(typeof stats.solidCells, "number");
});

test("thinFaces and lostCells are independent of each other", () => {
  // The same solid cube, triangulated once coarsely and once finely: the
  // fineness drives thinFaces up, the actual loss stays the same.
  const coarse = boxMesh([0.3, 0.3, 0.3], [12.3, 9.3, 7.3]);
  let fine = coarse;
  for (let i = 0; i < 5; i++) fine = subdivide(fine); // edges down to 1/32

  const a = sealMesh(coarse, { cell: 1, mode: "fill", closeHoles: 0, minThickness: 1 }).stats;
  const b = sealMesh(fine, { cell: 1, mode: "fill", closeHoles: 0, minThickness: 1 }).stats;

  assert.ok(b.thinFaces > a.thinFaces * 10, "the fine version has many more thin triangles");
  assert.equal(a.lostCells, b.lostCells, "the actual loss does not change");
});

/** Splits every triangle into four by its edge midpoints. */
function subdivide(triangles) {
  const count = triangles.length / 9;
  const out = new Float32Array(count * 36);
  let w = 0;
  const push = (a, b, c) => {
    out[w++] = a[0]; out[w++] = a[1]; out[w++] = a[2];
    out[w++] = b[0]; out[w++] = b[1]; out[w++] = b[2];
    out[w++] = c[0]; out[w++] = c[1]; out[w++] = c[2];
  };
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const a = [triangles[o], triangles[o + 1], triangles[o + 2]];
    const b = [triangles[o + 3], triangles[o + 4], triangles[o + 5]];
    const c = [triangles[o + 6], triangles[o + 7], triangles[o + 8]];
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    push(a, ab, ca);
    push(ab, b, bc);
    push(ca, bc, c);
    push(ab, bc, ca);
  }
  return out;
}
