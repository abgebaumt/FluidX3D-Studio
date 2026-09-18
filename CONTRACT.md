# Contracts — FluidX3D Studio

The single source of truth for the interfaces between frontend, backend and
solver. Every module follows it. Changes are made here first, then in the code.

Everything is in English: code comments, identifiers and all user-facing texts.

---

## 0. Repository layout

FluidX3D Studio is a **standalone repo**. FluidX3D itself is included as a git
submodule under `fluidx3d/` (unmodified upstream repo, pinned commit). A
different checkout can be configured via `fluidx3dPath`.

```
fluidx3d-studio/
  fluidx3d/               submodule: github.com/ProjectPhysX/FluidX3D
  package.json
  studio.config.json      path to FluidX3D + GPU specs (gitignored, created from .example)
  studio.config.example.json
  CONTRACT.md  README.md
  server/                 Node backend
  web/                    frontend (ES modules, no bundler)
  solver/                 C++ files that are installed into FluidX3D
  scripts/                install-solver.js, uninstall-solver.js
  data/                   runtime data, gitignored
    setups/ uploads/ generated/ backup/
```

**Principle: FluidX3D is only touched by `scripts/install-solver.js`**,
idempotently, with a backup under `data/backup/`. At runtime the server writes
exclusively `<fluidx3d>/src/defines.hpp` — and only after a backup of it exists.

`studio.config.json`:

```jsonc
{
  "fluidx3dPath": "./fluidx3d",
  "dataPath": "./data",
  "port": 8787,
  "gpu": { "name": "My GPU", "vramMB": 8192, "bandwidthGBs": 400 }
}
```

If the file is missing, it is created from `.example` on first start.
If the FluidX3D path is missing, the server still starts and reports it via
`/api/health` — the editor stays usable, only building and running are disabled.

---

## 1. Setup config (schema version 1)

A simulation is fully described by this JSON. The frontend writes it, the
backend stores it, the solver reads it.

Location: `data/setups/<name>.json`

```jsonc
{
  "schema": 1,
  "name": "wind_tunnel_example",

  "domain": {
    "size_m": [36.0, 60.0, 18.0],      // x spanwise, y streamwise, z up
    "target_vram_mb": 10000             // resolution() is scaled to hit this
  },

  "fluid": {
    "velocity_ms": 30.0,
    "azimuth_deg": 0.0,                 // 0 = flow along +y
    "elevation_deg": 0.0,               // positive = flow tilted upwards
    "density_kgm3": 1.225,
    "viscosity_m2s": 1.48e-5,
    "u_lbm": 0.075                      // lattice velocity, stability knob
  },

  // one of: "equilibrium" | "solid" | "periodic" | "open"
  "boundaries": {
    "xmin": "equilibrium", "xmax": "equilibrium",
    "ymin": "equilibrium", "ymax": "equilibrium",
    "zmin": "equilibrium", "zmax": "equilibrium"
  },

  "reference": {
    "length_m": 25.5,                   // characteristic length for Reynolds
    "source": "object:obj-1"            // "manual" | "object:<id>"
  },

  "objects": [
    {
      "id": "obj-1",
      "name": "Fuselage",
      "type": "stl",                    // schema 1 supports "stl" only
      "file": "uploads/1785085378718-glider.stl",   // relative to data/
      "enabled": true,
      "visible": true,

      "sizing": { "mode": "longest_edge_m", "value": 25.5 },
      //        | { "mode": "scale",         "value": 1.0 }   // STL units are metres

      "position_frac": [0.5, 0.40, 0.50],   // centre, as fraction of the domain
      "rotation_deg": { "pitch": -4.0, "yaw": 0.0, "roll": 0.0 },

      "motion": {
        "type": "none",                 // "none" | "rotate"
        "axis": [0.0, 1.0, 0.0],        // unit vector in domain coordinates
        "rpm": 0.0,
        "revoxelize_interval": 4        // LBM steps between re-voxelisations
      },

      // See section 8. Parameters only — the solver seals at startup on the
      // grid of the run, so there is no stored result and nothing to refresh.
      "sealing": {
        "mode": "off",                  // "off" | "shell" | "fill"
        "close_holes": 1,               // 0..3 cells
        "min_thickness": 1              // 1..5 cells, shell mode only
      }
    }
  ],

  "visualization": {
    "modes": ["solid", "q_criterion"],  // solid|flags|field|streamlines|q_criterion
    "q_criterion": 0.0008,
    "u_max": 0.18,
    "background": "0xCCE4FF"
  },

  "solver": {
    "velocity_set": 19,                 // 15 | 19 | 27
    "precision": "FP16S",               // "FP32" | "FP16S" | "FP16C"
    "extensions": ["SUBGRID", "EQUILIBRIUM_BOUNDARIES", "MOVING_BOUNDARIES"]
  },

  "run": {
    "mode": "interactive",              // "interactive" | "render"
    "duration_s": 4.0,                  // simulated seconds, render mode
    "fps": 60,
    "camera": {
      "type": "orbit",                  // "orbit" | "fixed"
      "azimuth_from_deg": -70.0, "azimuth_to_deg": 70.0,
      "elevation_deg": 20.0, "distance": 60.0, "zoom": 1.3
    }
  }
}
```

### Rotation

`Rz(yaw) · Rx(pitch) · Ry(roll)`, column-major, applied about the object's own
centre. `euler()` in `web/js/derive.js` and `make_rotation()` in
`solver/setup_config.cpp` must produce the identical matrix — this is covered
by a test that prints both for a set of angles.

### Domain coordinates

`+x` spanwise, `+y` streamwise, `+z` up — the usual wind-tunnel convention:
the flow runs along `+y` and a model's span lies along `x`. `position_frac` is
measured from the domain's lower corner, so `[0.5, 0.4, 0.5]` sits centred in
x and z, slightly forward in y.

---

## 2. Derived quantities

Computed identically in `web/js/derive.js` and `solver/setup_config.cpp`, so
what the band shows is what the solver runs.

```
fp_size               = 4 if precision == "FP32" else 2

bytes_per_cell        = velocity_set * fp_size + 17
                        + 12 if FORCE_FIELD
                        + 12 if SURFACE
                        + (7 * fp_size + 4) if TEMPERATURE

bandwidth_per_cell    = velocity_set * 2 * fp_size + 1 + 16
                        + 4  if TEMPERATURE
                        + 12 if FORCE_FIELD
                        + (velocity_set - 1) if any of MOVING_BOUNDARIES, SURFACE, TEMPERATURE

scale                 = cbrt(target_vram_mb / (lx*ly*lz * bytes_per_cell / 1048576))
Nx, Ny, Nz            = max(2, round(scale * l{x,y,z}))
cell_m                = lx / Nx
vram_mb               = Nx*Ny*Nz * bytes_per_cell / 1048576
Re                    = velocity_ms * reference.length_m / viscosity_m2s
dt_s                  = (u_lbm / velocity_ms) * cell_m
nu_lbm                = viscosity_m2s * dt_s / cell_m^2
tau                   = 3 * nu_lbm + 0.5
```

Display-only throughput estimate:
`mlups = 0.78 * gpu.bandwidthGBs * 1e9 / bandwidth_per_cell / 1e6`.

---

## 3. HTTP API

`http://127.0.0.1:<port>`, JSON bodies. Errors: HTTP 4xx/5xx with
`{ "error": "<human-readable message>" }`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, fluidx3dPath, fluidx3dFound, hasMsbuild, exeExists, gpu, node }` |
| GET | `/api/stl` | `[{ id, name, file, sizeBytes, triangles, bbox:{min,max}, uploadedAt }]` |
| POST | `/api/stl` | `multipart/form-data`, field `file`. Returns the entry. Rejects >250 MB and anything that does not parse as STL. |
| DELETE | `/api/stl/:id` | Remove an upload. |
| GET | `/api/stl/:id/raw` | Raw bytes for the viewport, `application/octet-stream`. |
| GET | `/api/setups` | `[{ name, savedAt }]` |
| GET | `/api/setups/:name` | The config object. |
| PUT | `/api/setups/:name` | Body = config, validated against schema 1. |
| DELETE | `/api/setups/:name` | |
| POST | `/api/preview` | Body = config → `{ defines, needsRebuild, currentHash, targetHash, reason }` |
| POST | `/api/run` | Body = `{ config, forceRebuild? }` → `{ jobId }` |
| POST | `/api/jobs/:id/stop` | Terminate the job's process tree. |
| GET | `/api/jobs/:id/events` | **SSE** stream, see below. |
| GET | `/api/jobs` | `[{ id, state, mode, startedAt, endedAt, exitCode }]` |

Only one job may run at a time; `POST /api/run` returns 409 while one is active.

### SSE events

`text/event-stream`, one JSON object per `data:` line.

```jsonc
{ "type":"stage",  "stage":"save|defines|build|launch|running|done|error",
                   "text":"Rebuild needed — MOVING_BOUNDARIES changed" }
{ "type":"log",    "stream":"stdout|stderr|studio", "text":"..." }
{ "type":"status", "steps":12034, "mlups":6431, "simTime":1.77, "runtime":61.2 }
{ "type":"exit",   "code":0 }
```

The backend parses FluidX3D's console output into `status` events; unparsable
lines are forwarded as `log`.

---

## 4. Build integration

- `defines.hpp` is generated from `solver.*`, `run.mode` and `visualization.*`,
  then written to `<fluidx3d>/src/defines.hpp`.
- Everything not derived from the config is preserved from
  `server/defines.template.hpp`, which carries `{{PLACEHOLDER}}` markers.
- Before the first write, `<fluidx3d>/src/defines.hpp` is copied to
  `data/backup/defines.hpp.orig` — **never overwrite an existing backup.**
- A rebuild is needed exactly when the hash over
  `{velocity_set, precision, extensions, run.mode}` differs from
  `data/generated/built.json`.
- Windows build: `msbuild FluidX3D.sln /p:Configuration=Release /p:Platform=x64 /m`
  in the FluidX3D root, plus `/p:PlatformToolset=<newest installed>` when the
  toolset named in `FluidX3D.vcxproj` is not installed (upstream pins v142 =
  Visual Studio 2019). Non-Windows: `bash make.sh`.
  If neither is available, emit a `stage: error` explaining what is missing.
- Launch: `bin/FluidX3D.exe --config <absolute path to the setup json>`.

---

## 5. Solver side

Files in `solver/`, installed into `<fluidx3d>/src/` by
`scripts/install-solver.js`:

- `json.hpp` — minimal read-only JSON parser, header-only, no dependencies.
- `mesh_seal.hpp` — runtime mesh sealing so thin walls survive voxelisation
  (section 8).
- `setup_config.cpp` — a `main_setup()` that builds the scene from the config.
  Entirely wrapped in `#ifdef GUI_CONFIG_SETUP`.

The installer additionally, all idempotent and reversible:

1. copies the three files into `<fluidx3d>/src/`,
2. wraps the active `main_setup()` in `<fluidx3d>/src/setup.cpp` with
   `#ifndef GUI_CONFIG_SETUP` / `#endif`, marked by
   `// >>> fluidx3d-studio` / `// <<< fluidx3d-studio` comments so it can be
   found and removed again,
3. adds `<ClCompile Include="src\setup_config.cpp" />`,
   `<ClInclude Include="src\json.hpp" />` and
   `<ClInclude Include="src\mesh_seal.hpp" />` to `FluidX3D.vcxproj`,
4. writes `data/backup/*.orig` for every file it touches, once.

`make.sh` compiles `src/*.cpp` by wildcard and needs no change.

The config path is read from `main_arguments`: scan for `--config` followed by
a path. Arguments that are not part of that pair keep their existing meaning
(device selection), so `FluidX3D.exe 0 --config foo.json` still works.

---

## 6. Frontend module boundaries

ES modules, no bundler. Three.js served from `node_modules` through an import
map in `index.html`.

| Module | Owns | Exports |
|---|---|---|
| `schema.js` | defaults, validation | `defaultConfig()`, `validate(cfg)` |
| `state.js` | live config + notification | `state`, `subscribe(fn)`, `patch(path,v)`, `select(id)`, `selected()` |
| `derive.js` | derived numbers (§2), `euler()` | `derive(cfg, gpu)`, `euler(y,p,r)` |
| `api.js` | HTTP calls | one function per endpoint |
| `viewport.js` | renderer, camera, lights, render loop | `initViewport(el)`, `scene`, `camera`, `renderer`, `onTick(fn)` |
| `domain.js` | domain wireframe, ground grid, BC faces, axes | `updateDomain(cfg)` |
| `objects.js` | STL loading, meshes, TransformControls | `syncObjects(cfg)`, `focusObject(id)`, `setGizmoMode(m)` |
| `flow.js` | streamline tracers | `updateFlow(cfg)`, `tickFlow(dt)` |
| `tree.js` | left scene tree | `renderTree()` |
| `inspector.js` | right property panel | `renderInspector()` |
| `band.js` | bottom instrument band | `renderBand()` |
| `runner.js` | run/build UI, SSE console | `startRun(mode)`, `stopRun()` |
| `main.js` | wiring, boot | — |

Rules:
- Only `state.js` mutates the config; everything else reads and subscribes.
- UI modules never touch Three.js objects; viewport modules never touch the DOM
  outside the canvas element.
- Sliders must not rebuild the panel they live in — derived read-outs register
  a refresher and are updated in place, otherwise dragging breaks.

---

## 8. Sealing — making a mesh survive voxelisation

### Why

FluidX3D's `voxelize_mesh` casts one ray per cell column and stores the hit
distances as **integers** (`ushort distances[64]`, kernel.cpp:2271). When a wall
is thinner than one cell, its front and back hit land on the same integer, the
inside/outside state flips twice in the same step, and **the wall disappears
entirely** — not partially. A perfectly watertight STL with a 2 mm flap loses
that flap at 5.88 cm cell size. This is a resolution problem, not a mesh defect,
so STL repair tools do not help.

### Approach

Sealing happens **inside the solver, at startup, on the grid of the actual run**
— in `solver/setup_config.cpp` and `solver/mesh_seal.hpp`, which are our files.
FluidX3D itself is not touched.

```
voxelise as usual → rasterise triangles into cells (shell)
                  → close holes → flood-fill from outside → thicken
                  → OR into lbm.flags
```

Sealing is a **local** operation: the working grid spans the object's bounding
box plus a margin, not the simulation domain. For a 25 m sailplane in a 60 m box
at 5.88 cm that is roughly 3 million cells, not 190 million.

**Why not precompute it.** An earlier design had the server write a second,
sealed STL. That file is baked at one cell size: raise the VRAM target, and the
simulation runs on a finer grid but still gets the coarsely voxelised geometry —
*less* detail than the original. A stored result cannot follow the resolution it
was made for, so there is nothing to precompute and nothing that can go stale.
The `POST /api/stl/:id/seal` endpoint and `server/voxel-seal.js` remain as a
diagnostic (they can answer "what would be lost at this cell size?") but are not
part of the path a simulation takes.

Stages:

1. **Shell** — every triangle is rasterised into the cells it overlaps
   (triangle/box overlap, separating-axis test). This is what makes thin walls
   survive: a face becomes solid cells regardless of its thickness.
2. **Close holes** (`close_holes` = n > 0) — morphological closing with radius n:
   dilate, then erode. Seals openings up to 2n cells wide.
3. **Fill** (`mode` = "fill") — flood-fill from the grid border through all
   non-solid cells; everything unreached is interior and becomes solid.
4. **Thicken** (`min_thickness` > 1) — dilate the shell to the requested wall
   thickness. Applied to shell mode; in fill mode the body is solid anyway.
5. **Surface** — marching cubes over the mask, emitted as a binary STL.

`mode: "shell"` keeps the body hollow, `"fill"` makes it a solid block. For an
aerodynamic body only the wetted surface matters, so `"fill"` is the safe
default recommendation; `"shell"` exists for cases where an internal cavity is
deliberate.

### Cell size

There is nothing to record: the solver seals on whatever grid the run uses, so
changing the domain or the VRAM target changes the sealing with it.

### Diagnostic endpoint

Not part of the simulation path — it answers "what would this cell size cost?"
without changing what gets run.

`POST /api/stl/:id/seal`

```jsonc
// request
{ "mode": "fill", "close_holes": 1, "min_thickness": 1, "cell_m": 0.0588 }

// response
{
  "sealedId": "<id>-sealed.stl",
  "file": "uploads/<id>-sealed.stl",
  "cell_m": 0.0588,
  "seconds": 3.1,
  "stats": {
    "trianglesIn": 59670, "trianglesOut": 74210,
    "grid": [164, 164, 50], "cells": 1344800,
    "solidCells": 41233, "shellCells": 18904, "filledCells": 22329,
    "closed": true,
    "thinFaces": 812        // triangles smaller than one cell — the ones that
                            // would have been lost without sealing
  }
}
```

`closed` reports whether the flood-fill was contained, i.e. whether the shell
had no opening to the outside. `thinFaces` is the number that justifies the
whole feature — show it to the user.

Results are cached: an identical `(id, mode, close_holes, min_thickness, cell_m)`
returns the stored file without recomputing. Sealed files are ordinary uploads
and appear in `GET /api/stl` with `derivedFrom` set to the source id.

### Limits

Sealing is skipped for **moving** objects. FluidX3D re-voxelises those every few
steps; sealing each time would cost more than the simulation. Propeller blades
below cell size therefore remain lossy — the solver reports this once at startup.

## 7. Visual language

- **Neutral surfaces, one accent.** Zinc-neutral greys carry the interface; the
  accent is the fluid colour, cyan `#0891b2` (light) / `#06b6d4` (dark), so the
  product colour and the physics colour are the same thing. Solid geometry is
  amber `#a16207` / `#eab308`. Semantic `--c-ok` / `--c-warn` / `--c-crit` stay
  separate from both.
- **Sans carries the interface, monospace carries data.** Labels, headings and
  prose are `--sans` (system UI stack). `--mono` is reserved for measured values,
  always with `font-variant-numeric: tabular-nums`, so numbers align in columns
  and read as data rather than as text.
- **Radii and depth:** `--radius` 8px for panels and cards, `--radius-sm` 6px for
  controls, 10–14px for floating surfaces. Shadows are minimal and only used to
  lift something off the canvas (`--shadow-sm`/`-md`/`-lg`).
- Controls are 32px high (`--h-control`), 26px in dense strips. Focus is a 2px
  `--ring` outline with 2px offset, never a border colour change alone.
- Layout: header · scene tree · viewport · inspector · instrument band.
- Light and dark via custom properties, driven by `prefers-color-scheme` and
  overridable with `data-theme` on `:root`. Both directions must win over the
  media query.

`web/css/app.css` is the only source of colour, type and spacing tokens.

**The alias block at the top of that file is load-bearing.** The Three.js
modules resolve `--fluid`, `--solid`, `--ink`, `--ink-2`, `--muted`, `--faint`,
`--ground`, `--surface`, `--panel`, `--sunken`, `--line`, `--line-soft`, `--ok`,
`--warn` and `--crit` through `getComputedStyle` at runtime. Renaming or removing
any of them breaks the viewport silently — map new tokens onto those names
instead.
