/**
 * The formulas of CONTRACT.md section 2, checked against numbers worked out by
 * hand and against the second implementation on the server side.
 *
 * Reference case (the default wind tunnel setup):
 *   box 36 x 60 x 18 m, target 10000 MB, D3Q19, FP16S
 *   -> 612 x 1019 x 306 cells, 5.88 cm per cell, 9.77 GB
 *   with u = 30 m/s, L = 25.5 m, nu = 1.48e-5 m^2/s
 *   -> Re = 5.17e7 and tau - 0.5 = 1.89e-6
 *
 * Nothing here starts a server or touches any file.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  derive, bytesPerCell, bandwidthPerCell, referenceLength, euler, applyMat3, windDir
} from "../web/js/derive.js";
import { estimateDtSeconds } from "../server/run.js";
import { defaultConfig } from "../server/schema.js";

const DEG = Math.PI / 180;
const GPU = { name: "Test card", vramMB: 24576, bandwidthGBs: 936 };

/** Relative comparison, because these are floating point results. */
function close(actual, expected, rel, what) {
  assert.ok(Number.isFinite(actual), `${what}: ${actual} is not a number`);
  const diff = Math.abs(actual - expected);
  const bound = Math.abs(expected) * rel;
  assert.ok(diff <= bound, `${what}: ${actual} differs from ${expected} by more than ${rel * 100} %`);
}

/** Value rounded to `digits` significant digits, for "5.17e7"-style checks. */
function sig(value, digits) {
  return Number(value.toPrecision(digits));
}

/** The reference case, spelled out rather than taken from any default. */
function referenceConfig() {
  return {
    schema: 1,
    name: "reference",
    domain: { size_m: [36.0, 60.0, 18.0], target_vram_mb: 10000 },
    fluid: {
      velocity_ms: 30.0, azimuth_deg: 0.0, elevation_deg: 0.0,
      density_kgm3: 1.225, viscosity_m2s: 1.48e-5, u_lbm: 0.075
    },
    boundaries: {
      xmin: "equilibrium", xmax: "equilibrium",
      ymin: "equilibrium", ymax: "equilibrium",
      zmin: "equilibrium", zmax: "equilibrium"
    },
    reference: { length_m: 25.5, source: "manual" },
    objects: [],
    visualization: { modes: ["solid", "q_criterion"], q_criterion: 0.0008, u_max: 0.18, background: "0xCCE4FF" },
    solver: { velocity_set: 19, precision: "FP16S", extensions: ["EQUILIBRIUM_BOUNDARIES", "SUBGRID"] },
    run: {
      mode: "interactive", duration_s: 4.0, fps: 60,
      camera: { type: "orbit", azimuth_from_deg: -70, azimuth_to_deg: 70, elevation_deg: 20, distance: 60, zoom: 1.3 }
    }
  };
}

/* ========================================================== reference case */

describe("Reference case 36 x 60 x 18 m, 10000 MB, D3Q19, FP16S", () => {
  const d = derive(referenceConfig(), GPU);

  it("uses 55 bytes per cell", () => {
    // 19 * 2 + 17 = 55, exactly what FluidX3D's own defines.hpp annotates
    assert.equal(d.bytesPerCell, 55);
  });

  it("resolves to 612 x 1019 x 306 cells", () => {
    // perUnit = 36*60*18*55/1048576 = 2.039337158203125 MB
    // scale   = cbrt(10000/2.039337158203125) = 16.98926...
    close(d.scale, 16.98926, 1e-4, "scale");
    assert.equal(d.Nx, 612);
    assert.equal(d.Ny, 1019);
    assert.equal(d.Nz, 306);
    assert.equal(d.N, 612 * 1019 * 306);
    assert.equal(d.N, 190830168);
  });

  it("gives a cell size of 5.88 cm", () => {
    // 36 m / 612 = 0.0588235294... m
    close(d.cell, 36 / 612, 1e-12, "cell");
    assert.equal(Number((d.cell * 100).toFixed(2)), 5.88);
  });

  it("needs 9.77 GB of memory", () => {
    // 190830168 * 55 = 10495659240 Byte, / 1048576 = 10009.44065 MB
    close(d.vramMB, 10495659240 / 1048576, 1e-12, "vramMB");
    close(d.vramMB, 10009.44065, 1e-9, "vramMB");
    assert.equal(Number((d.vramMB / 1024).toFixed(2)), 9.77);
    close(d.vramFrac, 10009.44065 / 24576, 1e-9, "vramFrac");
  });

  it("gives Re = 5.17e7", () => {
    // 30 * 25.5 / 1.48e-5 = 51689189.19
    close(d.Re, 765 / 1.48e-5, 1e-12, "Re");
    assert.equal(sig(d.Re, 3), 5.17e7);
  });

  it("gives tau - 0.5 = 1.89e-6", () => {
    // dt     = (0.075/30) * 0.05882353 = 1.4705882e-4 s
    // nu_lbm = nu * u_lbm / (u * cell) = 1.48e-5*0.075/(30*0.05882353) = 6.29e-7
    close(d.dt, 0.0025 * (36 / 612), 1e-12, "dt");
    close(d.nuLbm, 6.29e-7, 1e-4, "nu_lbm");
    close(d.tau - 0.5, 1.887e-6, 1e-3, "tau-0.5");
    assert.equal(sig(d.tau - 0.5, 3), 1.89e-6);
  });

  it("gives 93 bytes of bandwidth per cell and the matching MLUPs estimate", () => {
    // 19 * 2 * 2 + 1 + 16 = 93
    assert.equal(d.bandwidthPerCell, 93);
    close(d.mlups, 0.78 * 936 * 1e9 / 93 / 1e6, 1e-12, "mlups");
    close(d.mlups, 7850.32, 1e-4, "mlups");
  });

  it("measures the reference length in cells", () => {
    close(d.lbmSpan, 25.5 / (36 / 612), 1e-12, "lbmSpan");
    close(d.lbmSpan, 433.5, 1e-9, "lbmSpan");
  });

  it("holds for the server's default configuration as well", () => {
    const cfg = defaultConfig("standard");
    cfg.reference = { length_m: 25.5, source: "manual" };
    const s = derive(cfg, GPU);
    assert.equal(s.Nx, 612);
    assert.equal(s.Ny, 1019);
    assert.equal(s.Nz, 306);
    close(s.Re, 765 / 1.48e-5, 1e-12, "Re");
  });
});

/* =============================================================== footprint */

describe("bytes_per_cell", () => {
  const cases = [
    // Reference values from FluidX3D's own defines.hpp comments.
    [{ velocity_set: 9, precision: "FP32" }, 53],
    [{ velocity_set: 9, precision: "FP16S" }, 35],
    [{ velocity_set: 15, precision: "FP32" }, 77],
    [{ velocity_set: 15, precision: "FP16S" }, 47],
    [{ velocity_set: 19, precision: "FP32" }, 93],
    [{ velocity_set: 19, precision: "FP16C" }, 55],
    [{ velocity_set: 27, precision: "FP32" }, 125],
    [{ velocity_set: 27, precision: "FP16S" }, 71],
    // Extensions on top: +12 for FORCE_FIELD, +12 for SURFACE, +7*fp+4 for TEMPERATURE
    [{ velocity_set: 19, precision: "FP16S", extensions: ["FORCE_FIELD"] }, 67],
    [{ velocity_set: 19, precision: "FP16S", extensions: ["SURFACE"] }, 67],
    [{ velocity_set: 19, precision: "FP16S", extensions: ["TEMPERATURE"] }, 73],
    [{ velocity_set: 19, precision: "FP32", extensions: ["TEMPERATURE"] }, 125],
    [{ velocity_set: 19, precision: "FP16S", extensions: ["FORCE_FIELD", "SURFACE", "TEMPERATURE"] }, 97],
    // Extensions without a memory footprint change nothing.
    [{ velocity_set: 19, precision: "FP16S", extensions: ["SUBGRID", "EQUILIBRIUM_BOUNDARIES", "MOVING_BOUNDARIES"] }, 55]
  ];

  for (const [solver, expected] of cases) {
    it(`D${solver.velocity_set === 9 ? "2" : "3"}Q${solver.velocity_set} ${solver.precision}` +
      `${solver.extensions ? " + " + solver.extensions.join("+") : ""} = ${expected} bytes`, () => {
      assert.equal(bytesPerCell(solver), expected);
    });
  }
});

describe("bandwidth_per_cell", () => {
  const cases = [
    [{ velocity_set: 19, precision: "FP16S" }, 93],                  // 19*2*2 + 1 + 16
    [{ velocity_set: 19, precision: "FP32" }, 169],                  // 19*2*4 + 1 + 16
    [{ velocity_set: 27, precision: "FP16S" }, 125],                 // 27*2*2 + 1 + 16
    [{ velocity_set: 15, precision: "FP16S" }, 77],                  // 15*2*2 + 1 + 16
    [{ velocity_set: 19, precision: "FP16S", extensions: ["MOVING_BOUNDARIES"] }, 111], // + (19-1)
    [{ velocity_set: 19, precision: "FP16S", extensions: ["SURFACE"] }, 111],
    [{ velocity_set: 19, precision: "FP16S", extensions: ["TEMPERATURE"] }, 115],       // + 4 + (19-1)
    [{ velocity_set: 19, precision: "FP16S", extensions: ["FORCE_FIELD"] }, 105],       // + 12
    [{ velocity_set: 19, precision: "FP16S", extensions: ["MOVING_BOUNDARIES", "SURFACE"] }, 111], // counted once
    [{ velocity_set: 19, precision: "FP16S", extensions: ["SUBGRID"] }, 93]
  ];

  for (const [solver, expected] of cases) {
    it(`Q${solver.velocity_set} ${solver.precision}` +
      `${solver.extensions ? " + " + solver.extensions.join("+") : ""} = ${expected} bytes`, () => {
      assert.equal(bandwidthPerCell(solver), expected);
    });
  }
});

/* ============================================== frontend versus server side */

describe("Frontend and server compute the same numbers", () => {
  /** A spread of configs, so a divergence cannot hide in one corner. */
  const variants = [
    ["reference", (c) => c],
    ["FP32", (c) => { c.solver.precision = "FP32"; return c; }],
    ["D3Q27", (c) => { c.solver.velocity_set = 27; return c; }],
    ["D3Q15 + FORCE_FIELD", (c) => { c.solver.velocity_set = 15; c.solver.extensions = ["VOLUME_FORCE", "FORCE_FIELD"]; return c; }],
    ["SURFACE", (c) => { c.solver.extensions = ["SURFACE"]; return c; }],
    ["TEMPERATURE", (c) => { c.solver.extensions = ["TEMPERATURE"]; return c; }],
    ["small box", (c) => { c.domain.size_m = [2.5, 4, 1.5]; c.domain.target_vram_mb = 500; return c; }],
    ["large box", (c) => { c.domain.size_m = [120, 400, 90]; c.domain.target_vram_mb = 22000; return c; }],
    ["flat box", (c) => { c.domain.size_m = [50, 50, 1]; return c; }],
    ["slow flow", (c) => { c.fluid.velocity_ms = 2.5; c.fluid.u_lbm = 0.02; return c; }],
    ["fast flow", (c) => { c.fluid.velocity_ms = 280; c.fluid.u_lbm = 0.14; return c; }]
  ];

  for (const [label, edit] of variants) {
    it(`dt matches: ${label}`, () => {
      const cfg = edit(referenceConfig());
      const front = derive(cfg, GPU);
      const back = estimateDtSeconds(cfg);
      assert.ok(back !== null, `estimateDtSeconds() returns nothing for "${label}"`);
      close(back, front.dt, 1e-12, `dt (${label})`);
    });
  }

  it("returns no time step for an incomplete configuration", () => {
    assert.equal(estimateDtSeconds(null), null);
    assert.equal(estimateDtSeconds({}), null);
    assert.equal(estimateDtSeconds({ domain: { size_m: [1, 2, 3] } }), null);
  });
});

/* ================================================================== edges */

describe("Resolution edge cases", () => {
  it("enforces at least 2 cells per axis", () => {
    const cfg = referenceConfig();
    cfg.domain.size_m = [1000, 0.0005, 0.0005];
    cfg.domain.target_vram_mb = 50;
    const d = derive(cfg, GPU);
    // Without the clamp the short axes would round to a single cell.
    assert.ok(Math.round(d.scale * 0.0005) < 2, "The test case no longer hits the clamp");
    assert.equal(d.Ny, 2);
    assert.equal(d.Nz, 2);
    assert.ok(d.Nx > 2);
  });

  it("handles missing sections instead of returning NaN", () => {
    const d = derive({ solver: { velocity_set: 19, precision: "FP16S" } }, {});
    for (const key of ["Nx", "Ny", "Nz", "cell", "vramMB", "Re", "dt", "tau", "mlups"]) {
      assert.ok(Number.isFinite(d[key]), `${key} is not finite`);
    }
    // Defaults per derive(): 1 m box, 1000 MB target, 8192 MB GPU, 400 GB/s.
    assert.ok(d.Nx >= 2);
    assert.equal(d.gpuVramMB, 8192);
  });

  it("scales the cell count with the cube root of the VRAM target", () => {
    const small = derive({ ...referenceConfig(), domain: { size_m: [36, 60, 18], target_vram_mb: 1250 } }, GPU);
    const large = derive(referenceConfig(), GPU);
    // eight times the memory means twice the resolution per axis
    close(large.Nx / small.Nx, 2, 2e-3, "Nx ratio");
    close(large.Ny / small.Ny, 2, 2e-3, "Ny ratio");
  });
});

/* =============================================================== reference */

describe("Reference length", () => {
  it('uses the object size when source points to "object:<id>"', () => {
    const cfg = referenceConfig();
    cfg.objects = [{ id: "obj-1", sizing: { mode: "longest_edge_m", value: 9.63 } }];
    cfg.reference = { length_m: 25.5, source: "object:obj-1" };
    assert.equal(referenceLength(cfg), 9.63);
    close(derive(cfg, GPU).Re, 30 * 9.63 / 1.48e-5, 1e-12, "Re");
  });

  it("falls back to length_m when the object is missing or sized differently", () => {
    const cfg = referenceConfig();
    cfg.objects = [{ id: "obj-1", sizing: { mode: "scale", value: 2 } }];
    cfg.reference = { length_m: 25.5, source: "object:obj-1" };
    assert.equal(referenceLength(cfg), 25.5);

    cfg.reference = { length_m: 25.5, source: "object:does-not-exist" };
    assert.equal(referenceLength(cfg), 25.5);
  });
});

/* ================================================================== euler */

describe("euler() — Rz(yaw) · Rx(pitch) · Ry(roll)", () => {
  /** Independent row-major reference, written straight from the contract. */
  function reference(yaw, pitch, roll) {
    const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG);
    const cp = Math.cos(pitch * DEG), sp = Math.sin(pitch * DEG);
    const cr = Math.cos(roll * DEG), sr = Math.sin(roll * DEG);
    const rz = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]];
    const rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
    const ry = [[cr, 0, sr], [0, 1, 0], [-sr, 0, cr]];
    const mul = (a, b) => a.map((row, r) => [0, 1, 2].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c]));
    return mul(mul(rz, rx), ry);
  }

  const angles = [
    [0, 0, 0], [90, 0, 0], [0, 90, 0], [0, 0, 90],
    [30, -4, 10], [-70, 20, -15], [180, 45, 90], [359, -89, 12.5]
  ];

  for (const [yaw, pitch, roll] of angles) {
    it(`matches for yaw=${yaw}, pitch=${pitch}, roll=${roll}`, () => {
      const m = euler(yaw, pitch, roll);          // column-major, 9 values
      const ref = reference(yaw, pitch, roll);    // row-major, 3 x 3
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 3; r++) {
          assert.ok(
            Math.abs(m[c * 3 + r] - ref[r][c]) < 1e-12,
            `Element (${r},${c}): ${m[c * 3 + r]} instead of ${ref[r][c]}`
          );
        }
      }
    });
  }

  it("rotates the axes as expected", () => {
    const eq = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
    // yaw 90°: +x becomes +y
    assert.ok(eq(applyMat3(euler(90, 0, 0), [1, 0, 0]), [0, 1, 0]));
    // pitch 90°: +y becomes +z
    assert.ok(eq(applyMat3(euler(0, 90, 0), [0, 1, 0]), [0, 0, 1]));
    // roll 90°: +z becomes +x
    assert.ok(eq(applyMat3(euler(0, 0, 90), [0, 0, 1]), [1, 0, 0]));
  });

  it("returns a rotation matrix: orthonormal with determinant 1", () => {
    const m = euler(37, -12, 63);
    const col = (i) => [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let i = 0; i < 3; i++) close(dot(col(i), col(i)), 1, 1e-12, `column ${i} normalised`);
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      assert.ok(Math.abs(dot(col(i), col(j))) < 1e-12, `columns ${i} and ${j} are not orthogonal`);
    }
    const det =
      m[0] * (m[4] * m[8] - m[7] * m[5]) -
      m[3] * (m[1] * m[8] - m[7] * m[2]) +
      m[6] * (m[1] * m[5] - m[4] * m[2]);
    close(det, 1, 1e-12, "determinant");
  });
});

/* =============================================================== windDir */

describe("windDir()", () => {
  it("points along +y at azimuth 0", () => {
    const v = windDir({ azimuth_deg: 0, elevation_deg: 0 });
    assert.ok(Math.abs(v[0]) < 1e-12 && Math.abs(v[1] - 1) < 1e-12 && Math.abs(v[2]) < 1e-12);
  });

  it("turns towards +x with azimuth and towards +z with elevation", () => {
    const a = windDir({ azimuth_deg: 90, elevation_deg: 0 });
    close(a[0], 1, 1e-9, "x");
    const e = windDir({ azimuth_deg: 0, elevation_deg: 30 });
    close(e[2], 0.5, 1e-9, "z");
    close(e[1], Math.cos(30 * DEG), 1e-9, "y");
  });

  it("always returns a unit vector", () => {
    for (const [az, el] of [[0, 0], [37, -12], [-140, 85], [359, 0]]) {
      const v = windDir({ azimuth_deg: az, elevation_deg: el });
      close(Math.hypot(v[0], v[1], v[2]), 1, 1e-12, `length at ${az}/${el}`);
    }
  });
});
