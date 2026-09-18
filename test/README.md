# Tests

Backend tests for FluidX3D Studio, written with Node's built-in test runner
(`node:test`) — no extra framework, no further dependencies.

## Running

```bash
node --test
```

Each file runs in its own process; together they take about 1.5 seconds.
Individually:

```bash
node --test test/derive.test.js     # pure calculation, no server
node --test test/api.test.js        # starts its own server
```

### With your own model

One test each in `mesh-surface.test.js` and `voxel-seal.test.js` runs sealing
over a real model. This needs any **binary** STL whose path is set in
`STUDIO_TEST_STL`; the unit does not matter, the cell size follows the model
size (about 400 cells along the longest edge, coarser for compact models so
that the bounding box does not cover much more than four million cells). The
file is only read. Without the variable, both tests are skipped with a notice.

```
STUDIO_TEST_STL=/path/to/model.stl node --test          # bash
$env:STUDIO_TEST_STL = "C:\path\to\model.stl"; node --test   # PowerShell
```

Only properties that hold for any model are checked: the generated surface is
closed and correctly oriented, smoothing changes the volume by less than 5 %,
the sealed hull encloses the original and is at most two cells larger, and the
sealing grid stays limited to the bounding box plus margin.

> **Note:** `npm test` currently calls `node --test test/`. With Node ≥ 22 the
> trailing slash makes Node resolve the directory as a module, and the run
> aborts with `MODULE_NOT_FOUND`. `node --test` without an argument works from
> Node 20 to 24 and finds the same files.

## What the tests touch — and what they don't

`api.test.js` does **not** start the server on port 8787 and does **not** use
the real `data/` directory. Instead, a sandbox is created for the test run:

```
%TEMP%/fx3d-studio-test-XXXXXX/
  server/               copy of server/ — the code under test
  node_modules          link to the real node_modules (removed first)
  studio.config.json    points to the dummy below, free port
  fluidx3d/             dummy: src/lbm.hpp, src/defines.hpp, bin/FluidX3D.exe
  data/                 setups/, uploads/, generated/ — entirely its own
```

This means:

- Existing setups and uploaded STL files under `data/` are neither read,
  modified nor deleted.
- Nothing is written to the real FluidX3D tree; a dedicated test checks that
  `/api/preview` leaves `src/defines.hpp` untouched.
- **`POST /api/run` is never called.** Nothing is compiled and no simulation
  is started — the GPU stays free.
- At the end, the link and then the whole sandbox directory are removed; before
  that, the path is checked to really be inside the temp directory.

## `derive.test.js` — the formulas from CONTRACT.md §2

Checks `web/js/derive.js` against values calculated by hand, against the byte
figures in FluidX3D's own `defines.hpp`, and against the second implementation
on the server side (`estimateDtSeconds()` in `server/run.js`).

The reference case is a wind tunnel modelled on the default configuration —
box 36 × 60 × 18 m, target 10000 MB, D3Q19, FP16S:

| Quantity | Expected | Calculation |
|---|---|---|
| Bytes per cell | 55 | 19 · 2 + 17 |
| Resolution | 612 × 1019 × 306 | `scale = ∛(10000 / 2.039337) = 16.9893` |
| Cell size | 5.88 cm | 36 m / 612 |
| Memory | 10009.44 MB = 9.77 GB | 190 830 168 · 55 / 1048576 |
| Reynolds | 5.17 · 10⁷ | 30 · 25.5 / 1.48 · 10⁻⁵ |
| τ − 0.5 | 1.89 · 10⁻⁶ | 3 · ν · u_lbm / (u · Δx) |
| Bandwidth per cell | 93 bytes | 19 · 2 · 2 + 1 + 16 |

In addition: `bytes_per_cell` and `bandwidth_per_cell` for all velocity sets,
precisions and memory-relevant extensions; the clamping to at least 2 cells per
axis; the reference length from `reference.source = "object:<id>"`; `euler()`
against an independently written reference matrix (the same order
`Rz(yaw) · Rx(pitch) · Ry(roll)` as `make_rotation()` in
`solver/setup_config.cpp`) including orthonormality and determinant 1;
`windDir()`.

## `api.test.js` — the backend end-to-end

- **`/api/health`**: all fields required by the contract, installation found,
  unknown endpoints with a 404 error message.
- **STL**: upload of a generated binary and an ASCII STL (triangle count and
  bounding box are compared with the vertices of the fixtures), listing, raw
  download byte-for-byte identical, deletion; a corrupt file, a truncated
  binary file and a file without triangles are rejected with 400 **and not
  stored**; `../../etc/passwd` as an ID yields 404, and as a file name on upload
  the file ends up sanitized in `data/uploads`; two uploads with the same name
  remain distinguishable.
- **Setups**: save → load → save again is a fixed point (including object,
  sizing, rotation and `reference.source`); the name from the URL wins; invalid
  names and path attacks in the name and in `objects[].file` are rejected with
  400 and nothing is stored; the semantic rules of the contract (rotating
  object without `MOVING_BOUNDARIES`, `PARTICLES` without `VOLUME_FORCE` +
  `FORCE_FIELD`) return 400 with an error message, and with the missing
  extensions added the same configuration passes; damaged files and broken
  JSON are reported with a readable error message.
- **`/api/preview`**: `needsRebuild` — the tool's central promise. Fourteen
  changes to geometry, inflow, domain, boundaries, reference length, name and
  run parameters trigger **no** rebuild; `velocity_set`, `precision`, every
  added or removed extension, `TRT` and `run.mode` trigger **one** and are each
  named in `reason`. Order and letter case of the extensions do not matter.
- **`defines.hpp`**: for the base configuration, the complete list of active
  and commented-out switches is compared, plus background colour,
  `GRAPHICS_U_MAX` and `GRAPHICS_Q_CRITERION`; `GUI_CONFIG_SETUP` is set in
  every variant; FP32 means "both FP16 formats off"; render mode swaps
  `INTERACTIVE_GRAPHICS` for `GRAPHICS`; no `{{PLACEHOLDER}}` is left over.
- **Restart**: the STL index and the setups survive a server restart
  unchanged, and a file that disappears in the meantime drops out of the list.

## Deliberate deviations from the pure hash comparison

CONTRACT.md §4 says a rebuild is needed exactly when the hash over
`{velocity_set, precision, extensions, run.mode}` changes. The backend
additionally reports `needsRebuild` in two cases, and both are tested and
correct:

1. The compiled executable is missing (`bin/FluidX3D.exe`).
2. The graphics constants in `defines.hpp` (`visualization.background`,
   `u_max`, `q_criterion`) have changed — they are compile-time values as well.

## Not covered

Deliberately left out because it would occupy the GPU, compile for minutes or
require a real Visual Studio installation:

- `POST /api/run`, the build run and the SSE events of a real solver. Of the
  pure helpers in it, `estimateDtSeconds()` is covered via `derive.test.js`;
  `parseStatusLine()` is not covered at all.
- The 250 MB upload cap (the test file would have to be larger than 250 MB).
- The C++ side (`solver/setup_config.cpp`); `euler()` is checked against the
  order fixed in the contract, not against the compiled solver.
