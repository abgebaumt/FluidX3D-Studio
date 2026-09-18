/**
 * The shipped example in examples/: the setup is valid against schema 1 and
 * the glider is a single closed shell of plausible size and orientation.
 * A coarse run of the generator checks that the pipeline itself — marching
 * cubes on the sheared grid plus decimation — yields closed meshes, so a
 * regenerated model cannot silently break.
 *
 * Read-only: nothing is written to disk and no server is started.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { validate, SETUP_NAME_RE } from "../server/schema.js";
import { parseStl } from "../server/stl-info.js";
import {
  EXAMPLES_DIR, STL_NAME, SETUP_NAME, STL_REF,
  buildGliderStl, inspectStl
} from "../scripts/make-example.js";

const STL_FILE = path.join(EXAMPLES_DIR, STL_NAME);
const SETUP_FILE = path.join(EXAMPLES_DIR, `${SETUP_NAME}.json`);

/** Mean of the triangle centroids that satisfy `keep`, per axis. */
function centroidOf(buffer, keep) {
  const n = buffer.readUInt32LE(80);
  const sum = [0, 0, 0];
  let count = 0;
  for (let t = 0; t < n; t++) {
    const c = [0, 0, 0];
    for (let v = 0; v < 3; v++) {
      const off = 84 + t * 50 + 12 + v * 12;
      for (let a = 0; a < 3; a++) c[a] += buffer.readFloatLE(off + a * 4) / 3;
    }
    if (!keep(c)) continue;
    for (let a = 0; a < 3; a++) sum[a] += c[a];
    count++;
  }
  assert.ok(count > 0, "no triangles matched");
  return sum.map((s) => s / count);
}

function assertClosedShell(report) {
  assert.equal(report.boundaryEdges, 0, "open edges");
  assert.equal(report.nonManifoldEdges, 0, "edges used more than twice");
  assert.equal(report.flippedEdges, 0, "inconsistently oriented edges");
  assert.equal(report.degenerate, 0, "degenerate triangles");
  assert.equal(report.components, 1, "more than one shell");
  assert.equal(report.eulerCharacteristic, 2, "not a sphere-like surface");
  assert.ok(report.volume > 0, "normals point inwards");
  assert.equal(report.closed, true);
}

describe("example setup", () => {
  const raw = JSON.parse(fs.readFileSync(SETUP_FILE, "utf8"));

  it("validates against schema 1 without any error", () => {
    const { ok, errors, value } = validate(raw);
    assert.deepEqual(errors, []);
    assert.equal(ok, true);
    // Already normalised: what validate() returns is exactly what is stored.
    assert.deepEqual(value, raw);
  });

  it("is named after its file and references the example model", () => {
    assert.equal(raw.name, SETUP_NAME);
    assert.match(raw.name, SETUP_NAME_RE);
    assert.equal(raw.objects.length, 1);
    const [obj] = raw.objects;
    assert.equal(obj.file, STL_REF);
    assert.equal(obj.type, "stl");
    assert.deepEqual(obj.sizing, { mode: "scale", value: 1 });
    assert.equal(obj.enabled, true);
  });

  it("puts the model inside the domain with room for the wake", () => {
    const [lx, ly, lz] = raw.domain.size_m;
    const [fx, fy, fz] = raw.objects[0].position_frac;
    assert.ok(lx >= 2 * 15, "domain narrower than twice the span");
    assert.ok(fy * ly > 7 && (1 - fy) * ly > 2 * 7, "too little room ahead of or behind the glider");
    assert.ok(fz * lz > 2 && (1 - fz) * lz > 2);
    assert.equal(fx, 0.5);
  });
});

describe("example model", () => {
  const buffer = fs.readFileSync(STL_FILE);

  it("is a binary STL of moderate size", () => {
    assert.ok(buffer.length < 5 * 1024 * 1024, `${buffer.length} bytes`);
    const info = parseStl(buffer);
    assert.equal(info.format, "binary");
    assert.ok(info.triangles > 10000);
  });

  it("has glider dimensions in metres", () => {
    const { bbox } = parseStl(buffer);
    const span = bbox.max[0] - bbox.min[0];
    const length = bbox.max[1] - bbox.min[1];
    const height = bbox.max[2] - bbox.min[2];
    assert.ok(span > 14.8 && span < 15.2, `span ${span}`);
    assert.ok(length > 6.8 && length < 7.2, `length ${length}`);
    assert.ok(height > 1.4 && height < 2.0, `height ${height}`);
    assert.ok(Math.abs(bbox.min[0] + bbox.max[0]) < 1e-3, "not symmetric in x");
  });

  it("points its nose into the flow (-y) with the tail up (+z)", () => {
    const { bbox } = parseStl(buffer);
    const midY = (bbox.min[1] + bbox.max[1]) / 2;
    const wing = centroidOf(buffer, (c) => Math.abs(c[0]) > 3);
    const tail = centroidOf(buffer, (c) => c[2] > 1.0);
    assert.ok(wing[1] < midY, "wing is not in the front half");
    assert.ok(tail[1] > midY, "T-tail is not in the rear half");
  });

  it("is a single closed, consistently oriented shell", () => {
    const report = inspectStl(buffer);
    assertClosedShell(report);
    assert.ok(report.volume > 1.5 && report.volume < 3, `volume ${report.volume}`);
  });
});

describe("example generator", () => {
  it("produces a closed shell at coarse resolution too", () => {
    const stl = buildGliderStl({ coarsen: 4, triangles: 8000 });
    const report = inspectStl(stl);
    assertClosedShell(report);
    assert.equal(report.triangles, 8000);
  });
});
