/**
 * Surface extraction from a voxel mask — stage 5 of CONTRACT.md section 8.
 *
 * The tests work the way the feature works in production: build a mask, run
 * marching cubes over it, write a binary STL and read that STL back with the
 * very parser the upload endpoint uses (`server/stl-info.js`). Nothing here
 * starts a server, builds FluidX3D or writes a single byte to disk. The last
 * block runs the whole chain on a real binary STL named by the environment
 * variable STUDIO_TEST_STL; the file is only ever read, and without the
 * variable the block skips itself.
 *
 * The recurring assertions are:
 *   - the surface is closed — every directed edge is matched by exactly one
 *     edge running the other way,
 *   - the enclosed volume from the divergence theorem matches the solid cell
 *     count times the cell volume,
 *   - smoothing does not shrink the body.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { surfaceFromMask, writeBinaryStl, smoothSurface, MC_EDGE_TABLE, MC_TRI_TABLE } from "../server/mesh-surface.js";
import { parseStl } from "../server/stl-info.js";

/** The cell size of the default wind tunnel setup: 36 m / 612 cells. */
const CELL = 0.0588;

/** Optional real model for the last block: any binary STL, in any unit. */
const REAL_STL = process.env.STUDIO_TEST_STL ? path.resolve(process.env.STUDIO_TEST_STL) : null;

/**
 * Resolution of the real-STL test. The cell size is derived from the model, so
 * a part in millimetres and an aircraft in metres are treated alike: about 400
 * cells along the longest edge (a 25 m body at 5.88 cm has about 430), coarser
 * only where that would put more than four million cells into the bounding
 * box. It is then rounded to a power of two and the grid origin snapped to a
 * multiple of it, so every lattice coordinate is exact and openEdges(), which
 * matches vertices bit for bit, is not fooled by rounding.
 */
const REAL_CELLS_LONGEST = 400;
const REAL_CELL_BUDGET = 4_000_000;

// ---------------------------------------------------------------- helpers --

/** Index into a mask laid out with x running fastest. */
function at(dims, i, j, k) {
  return i + dims[0] * (j + dims[1] * k);
}

/** A solid box of cells inside an otherwise empty grid. */
function boxMask(dims, from, to) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  let cells = 0;
  for (let k = from[2]; k < to[2]; k++) {
    for (let j = from[1]; j < to[1]; j++) {
      for (let i = from[0]; i < to[0]; i++) {
        mask[at(dims, i, j, k)] = 1;
        cells++;
      }
    }
  }
  return { mask, cells };
}

/** Deterministic pseudo random numbers — the same masks on every run. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Signed volume enclosed by the triangles (divergence theorem). */
function meshVolume(t) {
  let sum = 0;
  for (let i = 0; i < t.length; i += 9) {
    const ax = t[i], ay = t[i + 1], az = t[i + 2];
    const bx = t[i + 3], by = t[i + 4], bz = t[i + 5];
    const cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
    sum += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

/**
 * Number of unmatched directed triangle edges. Zero means the surface is
 * closed and consistently wound — the property the sealed STL lives or dies by.
 */
function openEdges(t) {
  const seen = new Map();
  const key = (i) => `${t[i]},${t[i + 1]},${t[i + 2]}`;
  for (let i = 0; i < t.length; i += 9) {
    const c = [key(i), key(i + 3), key(i + 6)];
    for (let e = 0; e < 3; e++) {
      const a = c[e];
      const b = c[(e + 1) % 3];
      const back = `${b}|${a}`;
      const open = seen.get(back) || 0;
      if (open > 0) seen.set(back, open - 1);
      else {
        const forward = `${a}|${b}`;
        seen.set(forward, (seen.get(forward) || 0) + 1);
      }
    }
  }
  let unmatched = 0;
  for (const n of seen.values()) unmatched += n;
  return unmatched;
}

function bbox(t) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = t[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}

/** Reads the triangles back out of a binary STL buffer. */
function binaryTriangles(buffer) {
  const count = buffer.readUInt32LE(80);
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const off = 84 + t * 50 + 12;
    for (let v = 0; v < 9; v++) out[t * 9 + v] = buffer.readFloatLE(off + v * 4);
  }
  return out;
}

/** Reads the normals out of a binary STL buffer. */
function binaryNormals(buffer) {
  const count = buffer.readUInt32LE(80);
  const out = new Float32Array(count * 3);
  for (let t = 0; t < count; t++) {
    const off = 84 + t * 50;
    for (let v = 0; v < 3; v++) out[t * 3 + v] = buffer.readFloatLE(off + v * 4);
  }
  return out;
}

function close(actual, expected, rel, what) {
  assert.ok(Number.isFinite(actual), `${what}: ${actual} is not a number`);
  const diff = Math.abs(actual - expected);
  assert.ok(diff <= Math.abs(expected) * rel,
    `${what}: ${actual} deviates from ${expected} by more than ${rel * 100} %`);
}

// ------------------------------------------------------------ the tables ---

describe("marching cubes tables", () => {
  it("edge table and triangle table describe the same edges", () => {
    for (let cube = 0; cube < 256; cube++) {
      let used = 0;
      for (let s = 0; s < 16; s++) {
        const e = MC_TRI_TABLE[cube * 16 + s];
        if (e >= 0) used |= 1 << e;
      }
      assert.equal(used, MC_EDGE_TABLE[cube], `case ${cube}: edge mask does not match`);
    }
  });

  it("has 256 rows of 16 values, complete triangles and edges in 0..11", () => {
    assert.equal(MC_EDGE_TABLE.length, 256);
    assert.equal(MC_TRI_TABLE.length, 256 * 16);
    for (let cube = 0; cube < 256; cube++) {
      let entries = 0;
      let ended = false;
      for (let s = 0; s < 16; s++) {
        const e = MC_TRI_TABLE[cube * 16 + s];
        if (e < 0) { ended = true; continue; }
        assert.ok(!ended, `case ${cube}: values after the terminating -1`);
        assert.ok(e >= 0 && e <= 11, `case ${cube}: edge ${e} does not exist`);
        entries++;
      }
      assert.equal(entries % 3, 0, `case ${cube}: ${entries} values are not a multiple of 3`);
    }
  });

  it("empty and full cubes produce no surface", () => {
    assert.equal(MC_EDGE_TABLE[0], 0);
    assert.equal(MC_EDGE_TABLE[255], 0);
  });
});

// ------------------------------------------------------- surfaceFromMask ---

describe("surfaceFromMask", () => {
  it("a 3x3x3 block yields a closed surface with a plausible volume", () => {
    const dims = [7, 7, 7];
    const { mask, cells } = boxMask(dims, [2, 2, 2], [5, 5, 5]);
    assert.equal(cells, 27);

    const grid = { origin: [-1.0, 2.0, 0.5], cell: CELL, dims };
    const tri = surfaceFromMask(mask, grid);

    assert.ok(tri instanceof Float32Array, "the result is not a Float32Array");
    assert.equal(tri.length % 9, 0, "the length is not a multiple of 9");
    assert.ok(tri.length / 9 > 0, "no triangles were produced");

    assert.equal(openEdges(tri), 0, "the surface is not closed");

    // Divergence theorem against cell count times cell volume, 25 % tolerance.
    // Marching cubes cuts the corners of the block, so the mesh is a few
    // percent smaller than the cells — but never a different order of size.
    const expected = cells * CELL ** 3;
    const volume = meshVolume(tri);
    assert.ok(volume > 0, `the volume is not positive (${volume}) — wrong winding`);
    close(volume, expected, 0.25, "enclosed volume");

    // The surface sits halfway between the outermost solid cell centres and
    // their empty neighbours, i.e. exactly on the cell boundaries.
    const box = bbox(tri);
    for (let a = 0; a < 3; a++) {
      close(box.min[a], grid.origin[a] + 2 * CELL, 1e-5, `lower bound on axis ${a}`);
      close(box.max[a], grid.origin[a] + 5 * CELL, 1e-5, `upper bound on axis ${a}`);
    }
  });

  it("closes the surface at the grid border", () => {
    // The block fills the grid completely: every cube on the border reads
    // zeros from outside the mask, otherwise the body would be open.
    const dims = [3, 3, 3];
    const mask = new Uint8Array(27).fill(1);
    const tri = surfaceFromMask(mask, { origin: [0, 0, 0], cell: 0.1, dims });

    assert.equal(openEdges(tri), 0, "the body at the grid border is not closed");
    close(meshVolume(tri), 27 * 0.001, 0.25, "volume at the grid border");

    const box = bbox(tri);
    for (let a = 0; a < 3; a++) {
      close(box.min[a], 0, 1e-9, `lower bound on axis ${a}`);
      close(box.max[a], 0.3, 1e-5, `upper bound on axis ${a}`);
    }
  });

  it("a single cell becomes a closed body", () => {
    // Eight cubes each cut off one corner, so a lone cell becomes an
    // octahedron with the six face centres as its vertices — the exact answer
    // of marching cubes at this resolution, volume cell^3 / 6.
    const dims = [3, 3, 3];
    const mask = new Uint8Array(27);
    mask[at(dims, 1, 1, 1)] = 1;
    const tri = surfaceFromMask(mask, { origin: [0, 0, 0], cell: CELL, dims });

    assert.equal(tri.length / 9, 8, "a single cell does not yield an octahedron of 8 triangles");
    assert.equal(openEdges(tri), 0);
    close(meshVolume(tri), CELL ** 3 / 6, 1e-4, "volume of one cell");

    const box = bbox(tri);
    for (let a = 0; a < 3; a++) {
      close(box.min[a], CELL, 1e-6, `lower bound on axis ${a}`);
      close(box.max[a], 2 * CELL, 1e-6, `upper bound on axis ${a}`);
    }
  });

  it("an empty mask yields no triangles", () => {
    const dims = [5, 5, 5];
    const tri = surfaceFromMask(new Uint8Array(125), { origin: [0, 0, 0], cell: CELL, dims });
    assert.equal(tri.length, 0);
  });

  it("random masks always yield a closed surface", () => {
    // This is what validates the tables: staircases produce ambiguous faces,
    // and two neighbouring cubes must resolve them the same way.
    const random = lcg(20260726);
    const dims = [9, 9, 9];
    for (let run = 0; run < 25; run++) {
      const fill = 0.2 + 0.6 * random();
      const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
      let cells = 0;
      for (let i = 0; i < mask.length; i++) {
        if (random() < fill) { mask[i] = 1; cells++; }
      }
      const tri = surfaceFromMask(mask, { origin: [0.25, -3, 7], cell: CELL, dims });
      assert.equal(openEdges(tri), 0, `run ${run}: the surface is open`);
      assert.ok(meshVolume(tri) > 0, `run ${run}: negative volume`);
      assert.ok(meshVolume(tri) < cells * CELL ** 3 * 1.2,
        `run ${run}: the volume is larger than the filled cells`);
    }
  });

  it("reads every non-zero value as filled and leaves the mask unchanged", () => {
    const dims = [3, 3, 3];
    const mask = new Uint8Array(27);
    mask[at(dims, 1, 1, 1)] = 255;
    const copy = Uint8Array.from(mask);

    const tri = surfaceFromMask(mask, { origin: [0, 0, 0], cell: 1, dims });
    assert.equal(tri.length / 9, 8, "the value 255 was not read as filled");
    assert.deepEqual(Array.from(mask), Array.from(copy), "the mask was modified");
  });

  it("works in the coordinate system of the input", () => {
    const dims = [4, 6, 8];
    const { mask } = boxMask(dims, [1, 2, 3], [3, 4, 6]);
    const origin = [12.5, -40.25, 3.75];
    const cell = 0.25;
    const tri = surfaceFromMask(mask, { origin, cell, dims });

    const box = bbox(tri);
    const expectedMin = [1, 2, 3].map((c, a) => origin[a] + c * cell);
    const expectedMax = [3, 4, 6].map((c, a) => origin[a] + c * cell);
    for (let a = 0; a < 3; a++) {
      close(box.min[a], expectedMin[a], 1e-6, `lower bound on axis ${a}`);
      close(box.max[a], expectedMax[a], 1e-6, `upper bound on axis ${a}`);
    }
  });

  it("rejects unusable input with a readable message", () => {
    const dims = [2, 2, 2];
    const mask = new Uint8Array(8);
    const good = { origin: [0, 0, 0], cell: 1, dims };

    assert.throws(() => surfaceFromMask([0, 1], good), /Uint8Array/);
    assert.throws(() => surfaceFromMask(mask, null), /No grid was given/);
    assert.throws(() => surfaceFromMask(mask, { ...good, dims: [2, 2] }), /dims/);
    assert.throws(() => surfaceFromMask(mask, { ...good, dims: [2, 0, 2] }), /whole numbers/);
    assert.throws(() => surfaceFromMask(mask, { ...good, cell: 0 }), /cell size/);
    assert.throws(() => surfaceFromMask(mask, { ...good, origin: [0, 0] }), /origin/);
    assert.throws(() => surfaceFromMask(new Uint8Array(7), good), /too small/);

    try {
      surfaceFromMask(new Uint8Array(7), good);
      assert.fail("no exception");
    } catch (err) {
      assert.equal(err.status, 400);
      assert.equal(err.publicMessage, err.message);
    }
  });
});

// -------------------------------------------------------- writeBinaryStl ---

describe("writeBinaryStl", () => {
  it("writes a file that stl-info.js reads back — triangles and bounding box", () => {
    // The production path in one test: mask -> marching cubes -> STL -> the
    // parser behind POST /api/stl.
    const dims = [8, 9, 7];
    const { mask } = boxMask(dims, [1, 2, 1], [6, 7, 5]);
    const grid = { origin: [-0.3, 4.125, 0.0], cell: CELL, dims };
    const tri = surfaceFromMask(mask, grid);

    const buffer = writeBinaryStl(tri, "FluidX3D Studio sealed mesh");
    assert.equal(buffer.length, 84 + 50 * (tri.length / 9), "the file size does not match");

    const info = parseStl(buffer);
    assert.equal(info.format, "binary");
    assert.equal(info.triangles, tri.length / 9, "the triangle count changed");

    const box = bbox(tri);
    for (let a = 0; a < 3; a++) {
      close(info.bbox.min[a], box.min[a], 1e-6, `bounding box min on axis ${a}`);
      close(info.bbox.max[a], box.max[a], 1e-6, `bounding box max on axis ${a}`);
    }
    // ... and the box is exactly the block's cell boundaries again.
    for (let a = 0; a < 3; a++) {
      const from = [1, 2, 1][a];
      const to = [6, 7, 5][a];
      close(info.bbox.min[a], grid.origin[a] + from * CELL, 1e-5, `block boundary min ${a}`);
      close(info.bbox.max[a], grid.origin[a] + to * CELL, 1e-5, `block boundary max ${a}`);
    }

    // Every vertex survives the round trip bit for bit.
    assert.deepEqual(Array.from(binaryTriangles(buffer)), Array.from(tri));
  });

  it("lays out the 80-byte header, triangle count and attribute field correctly", () => {
    const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    // Non-ASCII characters are written as Latin-1, one byte each.
    const header = `Header with Latin-1 characters: ${String.fromCharCode(0xe4, 0xf6, 0xfc)}`;
    const buffer = writeBinaryStl(tri, header);

    assert.equal(buffer.readUInt32LE(80), 1);
    assert.equal(buffer.toString("latin1", 0, header.length), header);
    for (let i = header.length; i < 80; i++) assert.equal(buffer[i], 0, `header byte ${i} is not zero`);
    assert.equal(buffer.readUInt16LE(84 + 48), 0, "the attribute field is not zero");
    assert.equal(buffer.length, 134);
  });

  it("cuts overlong headers to 80 bytes and prevents a leading solid", () => {
    const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const long = writeBinaryStl(tri, "A".repeat(200));
    assert.equal(long.length, 134);
    assert.equal(long.toString("latin1", 0, 80), "A".repeat(80));
    assert.equal(long.readUInt32LE(80), 1);

    const solid = writeBinaryStl(tri, "solid body");
    assert.equal(solid.toString("latin1", 0, 17), "binary solid body");
    assert.equal(parseStl(solid).format, "binary");
  });

  it("normalises the normals from the cross product and points them outwards", () => {
    const dims = [5, 5, 5];
    const { mask } = boxMask(dims, [1, 1, 1], [4, 4, 4]);
    const grid = { origin: [0, 0, 0], cell: CELL, dims };
    const tri = surfaceFromMask(mask, grid);
    const buffer = writeBinaryStl(tri);
    const normals = binaryNormals(buffer);

    const centre = [2.5 * CELL, 2.5 * CELL, 2.5 * CELL];
    for (let t = 0; t < normals.length / 3; t++) {
      const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
      close(Math.hypot(nx, ny, nz), 1, 1e-5, `normal ${t} is not unit length`);

      const cx = (tri[t * 9] + tri[t * 9 + 3] + tri[t * 9 + 6]) / 3 - centre[0];
      const cy = (tri[t * 9 + 1] + tri[t * 9 + 4] + tri[t * 9 + 7]) / 3 - centre[1];
      const cz = (tri[t * 9 + 2] + tri[t * 9 + 5] + tri[t * 9 + 8]) / 3 - centre[2];
      assert.ok(nx * cx + ny * cy + nz * cz > 0, `normal ${t} points inwards`);
    }
  });

  it("writes a zero normal instead of NaN for degenerate triangles", () => {
    const tri = new Float32Array([
      0, 0, 0, 1, 0, 0, 2, 0, 0,       // collinear
      1, 2, 3, 1, 2, 3, 1, 2, 3,       // all three vertices identical
      0, 0, 0, 1, 0, 0, 0, 1, 0        // a healthy one for comparison
    ]);
    const normals = binaryNormals(writeBinaryStl(tri));
    for (let i = 0; i < normals.length; i++) {
      assert.ok(Number.isFinite(normals[i]), `normal ${i} is not a number`);
    }
    assert.deepEqual(Array.from(normals.slice(0, 6)), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(Array.from(normals.slice(6, 9)), [0, 0, 1]);
  });

  it("rejects lists that are not a multiple of nine values", () => {
    assert.throws(() => writeBinaryStl(new Float32Array(8)), /nine values/);
    assert.throws(() => writeBinaryStl("no triangles"), /No triangle data/);
    assert.throws(() => writeBinaryStl(null), /No triangle data/);
    assert.equal(writeBinaryStl(new Float32Array(0)).length, 84);
  });

  it("also accepts a plain array of numbers", () => {
    const buffer = writeBinaryStl([0, 0, 0, 1, 0, 0, 0, 1, 0], "list");
    assert.equal(buffer.readUInt32LE(80), 1);
    assert.deepEqual(Array.from(binaryNormals(buffer)), [0, 0, 1]);
  });
});

// --------------------------------------------------------- smoothSurface ---

describe("smoothSurface", () => {
  const dims = [9, 9, 9];
  const { mask, cells } = boxMask(dims, [2, 2, 2], [7, 7, 7]);
  const grid = { origin: [0, 0, 0], cell: CELL, dims };

  it("changes the volume by less than 5 % over three passes", () => {
    const tri = surfaceFromMask(mask, grid);
    const before = meshVolume(tri);
    const smoothed = smoothSurface(tri, 3);

    assert.ok(smoothed instanceof Float32Array);
    assert.equal(smoothed.length, tri.length, "the triangle count changed");

    const after = meshVolume(smoothed);
    const change = (after - before) / before;
    assert.ok(Math.abs(change) < 0.05,
      `smoothing changes the volume by ${(change * 100).toFixed(2)} %`);
    assert.ok(after > 0);
    close(before, cells * CELL ** 3, 0.25, "volume before smoothing");
  });

  it("does not shrink the body even after many passes", () => {
    const tri = surfaceFromMask(mask, grid);
    const before = meshVolume(tri);
    for (const iterations of [1, 2, 5, 10]) {
      const after = meshVolume(smoothSurface(tri, iterations));
      const change = (after - before) / before;
      assert.ok(change > -0.05,
        `${iterations} passes shrink the body by ${(-change * 100).toFixed(2)} %`);
    }
  });

  it("keeps the surface closed and the vertices together", () => {
    const tri = surfaceFromMask(mask, grid);
    const smoothed = smoothSurface(tri, 3);
    assert.equal(openEdges(smoothed), 0, "the smoothed surface is open");
    assert.equal(openEdges(tri), 0, "the input was modified");
  });

  it("passes the input through unchanged at iterations = 0", () => {
    const tri = surfaceFromMask(mask, grid);
    assert.equal(smoothSurface(tri, 0), tri);
    assert.equal(smoothSurface(tri), tri);
    assert.equal(smoothSurface(tri, -3), tri);
  });

  it("caps the displacement at half a cell size on request", () => {
    const tri = surfaceFromMask(mask, grid);
    const limit = CELL / 2;
    const smoothed = smoothSurface(tri, 8, { lambda: 0.9, mu: 0, maxDisplacement: limit });
    for (let i = 0; i < tri.length; i += 3) {
      const d = Math.hypot(smoothed[i] - tri[i], smoothed[i + 1] - tri[i + 1], smoothed[i + 2] - tri[i + 2]);
      assert.ok(d <= limit * 1.001, `vertex ${i / 3} was moved by ${d} m`);
    }
  });

  it("actually rounds off the block steps", () => {
    // Without an effect there would be no point: the smoothed mesh must have
    // moved, and it must have moved every vertex only a fraction of a cell.
    const tri = surfaceFromMask(mask, grid);
    const smoothed = smoothSurface(tri, 3);
    let moved = 0;
    let maxShift = 0;
    for (let i = 0; i < tri.length; i += 3) {
      const d = Math.hypot(smoothed[i] - tri[i], smoothed[i + 1] - tri[i + 1], smoothed[i + 2] - tri[i + 2]);
      if (d > 1e-6) moved++;
      if (d > maxShift) maxShift = d;
    }
    assert.ok(moved > tri.length / 3 * 0.5, "hardly any vertex moved");
    assert.ok(maxShift < CELL, `a vertex was moved by ${maxShift} m, more than one cell`);
  });

  it("survives an empty triangle list", () => {
    const empty = new Float32Array(0);
    assert.equal(smoothSurface(empty, 3).length, 0);
  });
});

// ------------------------------------------------ an optional real model ---

describe("a real STL (STUDIO_TEST_STL)", () => {
  it("mask → marching cubes → STL → stl-info returns the same geometry", (t) => {
    if (!REAL_STL) {
      t.skip("STUDIO_TEST_STL is not set — give the path to a binary STL to run this test");
      return;
    }
    if (!fs.existsSync(REAL_STL)) {
      t.skip(`STUDIO_TEST_STL points to ${REAL_STL}, the file does not exist`);
      return;
    }
    const source = fs.readFileSync(REAL_STL);
    const info = parseStl(source);
    if (info.format !== "binary") {
      t.skip(`${REAL_STL} is an ASCII STL — this test only reads binary STL`);
      return;
    }
    assert.ok(info.triangles > 0, "the test file contains no triangles");

    const extent = [0, 1, 2].map((a) => info.bbox.max[a] - info.bbox.min[a]);
    const longest = Math.max(...extent);
    assert.ok(longest > 0, "the test file has no extent");
    const wanted = Math.max(longest / REAL_CELLS_LONGEST,
      Math.cbrt((extent[0] * extent[1] * extent[2]) / REAL_CELL_BUDGET));
    const cell = 2 ** Math.round(Math.log2(wanted));
    t.diagnostic(`file: ${REAL_STL}, ${info.triangles} triangles, cell size ${cell.toPrecision(3)}`);

    // A deliberately simple shell rasteriser stands in for stage 1 of the
    // sealing pipeline — this module is not responsible for it, it only needs
    // a realistic mask at a realistic resolution.
    const margin = 2;
    const origin = [0, 1, 2].map((a) => (Math.floor(info.bbox.min[a] / cell) - margin) * cell);
    const dims = [0, 1, 2].map((a) => Math.floor((info.bbox.max[a] - origin[a]) / cell) + margin + 1);
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);

    const v = new Float64Array(9);
    let solidCells = 0;
    for (let f = 0; f < info.triangles; f++) {
      const off = 84 + f * 50 + 12;
      for (let c = 0; c < 9; c++) v[c] = source.readFloatLE(off + c * 4);
      const e1 = Math.hypot(v[3] - v[0], v[4] - v[1], v[5] - v[2]);
      const e2 = Math.hypot(v[6] - v[0], v[7] - v[1], v[8] - v[2]);
      // Samples at most half a cell apart; the cap still keeps them below one
      // cell for a triangle spanning the whole bounding-box diagonal.
      const n = Math.min(1024, Math.max(1, Math.ceil((Math.max(e1, e2) / cell) * 2)));
      for (let a = 0; a <= n; a++) {
        for (let b = 0; a + b <= n; b++) {
          const wa = a / n, wb = b / n, wc = 1 - wa - wb;
          const i = Math.floor((v[0] * wc + v[3] * wa + v[6] * wb - origin[0]) / cell);
          const j = Math.floor((v[1] * wc + v[4] * wa + v[7] * wb - origin[1]) / cell);
          const k = Math.floor((v[2] * wc + v[5] * wa + v[8] * wb - origin[2]) / cell);
          if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) continue;
          const idx = at(dims, i, j, k);
          if (!mask[idx]) { mask[idx] = 1; solidCells++; }
        }
      }
    }
    // A surface spanning n cells along its longest edge touches at least n.
    const span = Math.floor(longest / cell);
    assert.ok(solidCells >= span, "the stand-in rasterisation filled hardly any cells");

    const tri = surfaceFromMask(mask, { origin, cell, dims });
    assert.ok(tri.length / 9 >= span, "hardly any triangles were produced");
    assert.equal(openEdges(tri), 0, "the sealed surface is not closed");
    assert.ok(meshVolume(tri) > 0, "negative volume — wrong winding");

    const smoothed = smoothSurface(tri, 3);
    const change = (meshVolume(smoothed) - meshVolume(tri)) / meshVolume(tri);
    assert.ok(Math.abs(change) < 0.05,
      `smoothing changes the body's volume by ${(change * 100).toFixed(2)} %`);

    const buffer = writeBinaryStl(smoothed, `FluidX3D Studio sealed mesh, cell ${cell} m`);
    const back = parseStl(buffer);
    assert.equal(back.format, "binary");
    assert.equal(back.triangles, smoothed.length / 9, "the triangle count changed");

    // The sealed body encloses the original and grows by less than two cells:
    // that is the shell rasterisation, not a displaced or mis-scaled mesh.
    for (let a = 0; a < 3; a++) {
      assert.ok(back.bbox.min[a] <= info.bbox.min[a] + 1e-6,
        `axis ${a}: the sealed hull lies inside the original`);
      assert.ok(back.bbox.max[a] >= info.bbox.max[a] - 1e-6,
        `axis ${a}: the sealed hull lies inside the original`);
      assert.ok(info.bbox.min[a] - back.bbox.min[a] < 2 * cell,
        `axis ${a}: the hull grew by more than two cells at the bottom`);
      assert.ok(back.bbox.max[a] - info.bbox.max[a] < 2 * cell,
        `axis ${a}: the hull grew by more than two cells at the top`);
    }
  });
});
