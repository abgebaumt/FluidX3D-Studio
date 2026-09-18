# Example: glider in a wind tunnel

A ready-to-run example for trying out FluidX3D Studio.

| File | Contents |
|---|---|
| `glider.stl` | A 15 m class glider as a single closed, watertight shell (binary STL, 60 000 triangles, about 2.9 MB) |
| `glider-wind-tunnel.json` | Setup `glider-wind-tunnel`: 30 × 40 × 14 m domain, 25 m/s air, glider centred at 3° angle of attack |

## The model

- Span 15.0 m, length 7.0 m, height 1.67 m. Units are **metres**, so the
  setup uses `sizing: { mode: "scale", value: 1 }`.
- Coordinates follow `CONTRACT.md`: `+x` spanwise, `+y` streamwise, `+z` up.
  The nose points towards `-y`, into the flow.
- Rounded fuselage with a canopy, a two-panel tapered wing with a slight sweep
  and 3° dihedral (NACA 0015 at the root, NACA 0013 at the tip), and a T-tail.

The geometry is generated procedurally by
[`scripts/make-example.js`](../scripts/make-example.js). No third-party model
was used. It combines signed distance functions, runs marching cubes, and then
applies quadric decimation. The output is deterministic, and the script checks
that the result is closed: every edge belongs to exactly two triangles with
opposite orientation, and the model forms a single shell with outward normals.
Both files are covered by the repository's license (AGPL-3.0, see
[`LICENSE`](../LICENSE)).

## Setup

- Domain 30 × 40 × 14 m, target 4000 MB of VRAM, which gives cells of about
  6 cm (D3Q19, FP16S).
- Inflow 25 m/s along `+y`, air at 15 °C (1.225 kg/m³, 1.48·10⁻⁵ m²/s).
- The reference length of 0.72 m is the wing's mean chord, which gives a Reynolds
  number of about 1.2·10⁶.
- Glider at `position_frac [0.5, 0.35, 0.5]`, slightly forward so the wake
  has room, with a pitch of −3°, which is 3° nose up.
- Sealing is set to `fill`. At 6 cm cells the wing tip and the tail are only
  one or two cells thick, and without sealing they would partly vanish in the
  voxelisation (see `CONTRACT.md` section 8).

## Usage

Copy both files into the data directory. This works with a custom `dataPath`
from `studio.config.json` as well:

```bash
node scripts/make-example.js --install
```

This places the model at `uploads/glider.stl` and the setup at
`setups/glider-wind-tunnel.json`, and registers the model in the STL index.
Then start the server, or restart it if it is already running, and pick
**glider-wind-tunnel** in the setup menu.

If a file with different content already exists at either location, the
script aborts. `--force` overwrites it.

To install by hand, copy `glider.stl` to `data/uploads/glider.stl` and
`glider-wind-tunnel.json` to `data/setups/`. The setup references the model
as `uploads/glider.stl`, relative to the data directory.

## Regenerating

```bash
node scripts/make-example.js           # rewrites both files in examples/ (a few seconds)
node scripts/make-example.js --check   # only checks examples/glider.stl
```

`test/example.test.js` validates the setup and checks that the model is closed.
