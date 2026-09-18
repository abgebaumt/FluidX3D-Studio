# FluidX3D Studio — Design

Status: 26 July 2026 · sub-project ① (end-to-end slice) implemented

## The problem

FluidX3D describes a simulation as C++ code. Domain size, angle of attack,
free-stream velocity and propeller speed live in `setup.cpp`; whether an
extension such as `MOVING_BOUNDARIES` is active is decided by `defines.hpp` at
compile time. Every variant therefore costs a compile run, and because variants
are needed side by side, they grow into a zoo of binaries — soon there are
several of them in `bin/`, told apart by name suffixes such as `_prop`,
`_render`, `_interactive`.

The real nuisance is not the build time but that quantities which belong
together are spread across three places: box resolution and VRAM budget in a
`resolution()` call, the geometry in rotation matrices, the stability condition
nowhere — you have to work out τ yourself to know whether a run will diverge.

## The approach

The scene becomes a **runtime configuration**. A generic `main_setup()` reads a
JSON file and builds the domain, geometry, boundary conditions and
visualization from it. A recompile is only needed when a compile-time option
actually changes — which is rare.

This is deliberately a **hybrid** and not pure code generation:

| | Code generation | Runtime config | Chosen: hybrid |
|---|---|---|---|
| Change geometry | rebuild (~1 min) | immediate | immediate |
| Toggle an extension | rebuild | not possible | rebuild |
| Readability for the user | generated code | opaque | config readable, `defines.hpp` visible |

The cost: the generic setup has to be able to do everything the hand-written
setups could do. The gain: the binary zoo disappears, and the editor can tell
whether a rebuild is needed before you trigger one.

### Why a separate repo

FluidX3D Studio sits **next to** FluidX3D, not inside it. That keeps the fork
mergeable with upstream and makes the tool usable for other FluidX3D users. The
intervention is limited to two new files and two lines in `setup.cpp`, applied
by an idempotent install script and fully reversible.

## Architecture

```
Browser                    Node backend                 FluidX3D
───────                    ────────────                 ────────
Three.js viewport   ─────► POST /api/run  ─────► write defines.hpp
Inspector                        │                      │
Instrument band                  │               msbuild (only if the
     │                           │                      hash changed)
     └── Config (JSON) ──────────┤                      │
                                 │               FluidX3D.exe --config …
                                 │                      │
                          SSE ◄──┴──────────────── stdout/stderr
```

Four components, each with one job:

**Config schema** (`CONTRACT.md` §1) — the seam. Versioned and tolerant of
unknown fields, so that older setups do not break as the schema grows.

**Frontend** — ES modules without a bundler, Three.js from `node_modules` via
an import map. Only `state.js` modifies the config; everything else reads and
subscribes. UI modules do not touch Three.js objects, viewport modules do not
touch the DOM outside the canvas.

**Backend** — Express. Every route module exports `register(router, ctx)`. The
server stays usable when FluidX3D is missing: the editor works, only building
and running are disabled.

**Solver integration** — `json.hpp` (header-only, read-only) and
`setup_config.cpp`, fully wrapped in `#ifdef GUI_CONFIG_SETUP`. Without this
define, FluidX3D behaves exactly as before.

### The duplicated calculation

The derived quantities — grid resolution, cell size, VRAM, Re, τ, time step —
are computed **identically in two places**: in `web/js/derive.js` for the
display and in `setup_config.cpp` for the run. This redundancy is deliberate:
what the instrument band shows has to be what the solver does, otherwise the
display is worthless. A test checks both sides against reference values
calculated by hand.

### What the instrument band does

It shows the quantities you previously had to balance in your head, side by
side:

- **VRAM against the card's limit** — with thresholds at 82 % (tight) and 94 % (not enough)
- **τ − ½** instead of τ, because at high Reynolds numbers τ sits practically at
  0.5 and four decimal places say nothing. The traffic light takes into account
  whether `SUBGRID` is active: without an LES model the same value is critical,
  with it it is normal.
- **Compute time per second of real time** — the number that decides whether a
  project runs overnight or for a week.

## Decisions and their reasons

**Coordinate system `+x` spanwise, `+y` streamwise, `+z` up.** The usual
wind-tunnel orientation, rather than imposing the Three.js convention (`+y`
up). Less conversion at the seam, fewer opportunities for sign errors.

**Rotation as `Rz(yaw) · Rx(pitch) · Ry(roll)`.** One order, fixed in the
contract, implemented identically in both languages.

**One run at a time.** The GPU is the scarce resource; parallel runs would only
slow each other down. `POST /api/run` responds with 409 while a job is active.

**SSE instead of WebSocket.** The data flow is one-way — server to browser. SSE
needs no additional dependency and survives reconnects; missed events are
replayed from a buffer.

**Native window instead of a browser stream.** Interactive mode opens the
familiar FluidX3D window with full rendering performance and the built-in
keyboard controls. Streaming frames through the browser would have required
camera control to travel back through the chain — a lot of rework for a worse
view.

## Limitations of the current state

- Schema 1 only knows STL geometry. Primitives from `shapes.cpp` are missing.
- Camera paths are limited to orbit and fixed camera; a keyframe editor has not
  been built.
- The streamlines in the editor are a potential flow, not a preview of the
  solution — they show direction and the rough flow around the body, nothing
  more.
- On Linux and macOS the build runs through `make.sh` but has not been tested.

## Roadmap

The original breakdown planned five steps; ① is implemented.

**② Full scene editor** — primitives via `shapes.cpp`, multiple moving objects,
boundary-condition zones finer than whole box faces.

**③ Extensions across the board** — free surface, temperature, particles,
multi-GPU. Plus a build cache that keeps several define combinations as named
binaries, so that switching between extensions also works without a rebuild.

**④ Camera paths and render jobs** — keyframes in the viewport, path preview,
render queue, frame gallery.

**⑤ Ecosystem** — preset library, run comparison, STL export directly from
Blender.

Every step stays schema-compatible: new fields are added, old ones keep their
meaning.
