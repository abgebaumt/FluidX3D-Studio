/**
 * Right property panel.
 *
 * The panel is rebuilt whenever the *shape* of the form changes — another
 * selection, another sizing mode, another set of extensions. Plain value
 * changes never rebuild it: every control and every derived read-out registers
 * a refresher in `live` and is updated in place. That is what keeps a slider
 * usable while it is being dragged, and it is also what makes the numbers
 * follow the gizmo when an object is moved in the viewport.
 */
import { state, patch, read, selected, setStlIndex } from "./state.js";
import {
  derive, bytesPerCell, bandwidthPerCell,
  nf, ni, sci, bigCells, dur, parseNum
} from "./derive.js";
import {
  LABELS, BOUNDARY_FACES, BOUNDARY_TYPES, VELOCITY_SETS, PRECISIONS, EXTENSIONS,
  VIS_MODES, RUN_MODES, CAMERA_TYPES, SIZING_MODES, MOTION_TYPES, SEALING_MODES,
  SEALING_LIMITS, defaultSealing, longestEdge
} from "./schema.js";
import { removeObject } from "./tree.js";
import * as api from "./api.js";
import { toast } from "./runner.js";

/** Fired with `detail.id` when the user wants the camera on an object. */
export const EV_FOCUS_OBJECT = "studio:focus-object";

const SPEED_OF_SOUND = 343;

/** Refreshers of the currently mounted panel. */
let live = [];
/** Shape of the panel that is currently mounted; see `signature()`. */
let mounted = "";

/* ==================================================================== public */

/** Builds the panel from scratch. */
export function renderInspector() {
  const panel = document.getElementById("insp");
  if (!panel) return;
  live = [];
  mounted = signature();
  panel.textContent = "";

  const sel = selected();
  if (sel.kind === "object") buildObject(panel, sel.object);
  else buildSection(panel, sel.id);

  updateLive();
}

/**
 * Called on every config change. Rebuilds only when the form's shape changed,
 * otherwise refreshes the mounted controls in place.
 */
export function updateInspector() {
  if (signature() !== mounted) renderInspector();
  else updateLive();
}

function updateLive() {
  for (const fn of live) {
    try { fn(); } catch (err) { console.error("Inspector refresher failed:", err); }
  }
}

/**
 * Everything that decides which controls exist. Values that only travel
 * through a control's own value are deliberately absent.
 */
function signature() {
  const c = state.config;
  const sel = selected();
  const parts = [
    sel.id, sel.kind,
    (c.objects || []).length,
    c.reference ? c.reference.source : "",
    c.run ? c.run.mode : "",
    c.run && c.run.camera ? c.run.camera.type : "",
    c.solver ? c.solver.precision : "",
    c.solver ? c.solver.velocity_set : "",
    (c.solver && c.solver.extensions || []).join("+"),
    (c.visualization && c.visualization.modes || []).join("+"),
    BOUNDARY_FACES.map(f => (c.boundaries || {})[f]).join(""),
    state.stlIndex.length
  ];
  if (sel.object) {
    parts.push(sel.object.sizing.mode, sel.object.motion.type, sel.object.file);
  }
  return parts.join("|");
}

/* =================================================================== context */

const gpu = () => (state.health && state.health.gpu) || {};
const D = () => derive(state.config, gpu());

const objectIndex = id => (state.config.objects || []).findIndex(o => o.id === id);

/** The `/api/stl` entry an object's file came from, or null. */
function stlEntry(obj) {
  if (!obj || !obj.file) return null;
  return state.stlIndex.find(e => e && e.file === obj.file) || null;
}

/** Size of an object in metres along its longest bounding-box edge. */
function objectMetres(obj) {
  if (!obj) return 0;
  if (obj.sizing.mode === "longest_edge_m") return obj.sizing.value;
  const entry = stlEntry(obj);
  return longestEdge(entry && entry.bbox) * obj.sizing.value;
}

const hasExt = name => (state.config.solver.extensions || []).includes(name);

/* ================================================================== sections */

const HEADINGS = {
  domain: ["Domain", "Size of the simulation box in metres and the VRAM budget. The grid resolution follows from these — like resolution() in the setup code."],
  fluid: ["Fluid", "Inflow and material properties. The LBM velocity is the stability control: small enough for accuracy, large enough for progress."],
  boundaries: ["Boundaries", "Type per box face. Equilibrium boundaries impose the inflow and let it out again at the other end."],
  reference: ["Reference length", "The characteristic length of the Reynolds number — set by hand or taken from an object."],
  visualization: ["Visualization", "What the native window draws — switchable with keys 1–7 during the run."],
  solver: ["Solver", "Compile-time options. Changes here force a rebuild of the binary."],
  run: ["Run", "Interactive on screen, or as a render run that writes frames to disk."]
};

function buildSection(panel, id) {
  const [title, subtitle] = HEADINGS[id] || ["Selection", "No panel for this selection."];
  panel.appendChild(header(title, subtitle));

  if (id === "domain") return buildDomain(panel);
  if (id === "fluid") return buildFluid(panel);
  if (id === "boundaries") return buildBoundaries(panel);
  if (id === "reference") return buildReference(panel);
  if (id === "visualization") return buildVisualization(panel);
  if (id === "solver") return buildSolver(panel);
  if (id === "run") return buildRun(panel);
}

/* ---------------------------------------------------------------- domain --- */

function buildDomain(panel) {
  panel.appendChild(group("Dimensions", true, b => {
    b.append(
      slider("Width X", "domain.size_m.0", { min: 2, max: 200, step: 0.5, unit: "m" }),
      slider("Length Y", "domain.size_m.1", { min: 2, max: 400, step: 0.5, unit: "m" }),
      slider("Height Z", "domain.size_m.2", { min: 2, max: 200, step: 0.5, unit: "m" })
    );
    b.appendChild(hint(() =>
      "x spanwise, y in flow direction, z up. Cropping tighter around the model gains more resolution than more VRAM."));
  }));

  panel.appendChild(group("Resolution", true, b => {
    b.appendChild(slider("VRAM target", "domain.target_vram_mb", { min: 200, max: 48000, step: 100, unit: "MB" }));
    b.appendChild(readout(d => [
      ["Grid", `${d.Nx} × ${d.Ny} × ${d.Nz}`],
      ["Cells", bigCells(d.N)],
      ["Cell size", nf(d.cell * 100, 2) + " cm"],
      ["Reference length", ni(d.lbmSpan) + " cells"],
      ["GPU memory", ni(d.vramMB) + " MB"],
      ["CPU memory", ni(d.hostMB) + " MB"]
    ]));
    b.appendChild(hint(d => {
      if (d.vramMB > d.gpuVramMB * 0.94) {
        return ["The VRAM target exceeds what the GPU has — the run will abort while allocating.", "crit"];
      }
      if (d.lbmSpan < 120) {
        return ["Fewer than 120 cells across the reference length — the boundary layer is barely resolved.", true];
      }
      return "The cell size is box width ÷ Nx. The VRAM target scales the grid; the aspect ratio stays.";
    }));
  }));
}

/* ----------------------------------------------------------------- fluid --- */

const VISCOSITIES = [
  [1.48e-5, "Air, 15 °C"],
  [1.33e-5, "Air, −10 °C"],
  [1.79e-5, "Air, 40 °C"],
  [1.0e-6, "Water, 20 °C"]
];

function buildFluid(panel) {
  panel.appendChild(group("Inflow", true, b => {
    b.append(
      slider("Velocity", "fluid.velocity_ms", { min: 1, max: 200, step: 0.5, unit: "m/s" }),
      slider("Azimuth", "fluid.azimuth_deg", { min: -180, max: 180, step: 1, unit: "°" }),
      slider("Elevation", "fluid.elevation_deg", { min: -45, max: 45, step: 0.5, unit: "°" })
    );
    b.appendChild(readout(() => [
      ["equals", nf(state.config.fluid.velocity_ms * 3.6, 0) + " km/h"],
      ["Mach", nf(state.config.fluid.velocity_ms / SPEED_OF_SOUND, 3)]
    ]));
    b.appendChild(hint(() => "Azimuth 0° flows along +y; positive elevation tilts the inflow upwards."));
  }));

  panel.appendChild(group("Material", true, b => {
    b.appendChild(slider("Density ρ", "fluid.density_kgm3", { min: 0.05, max: 1400, step: 0.005, digits: 3, unit: "kg/m³" }));
    b.appendChild(dropdown("Viscosity ν", "fluid.viscosity_m2s", VISCOSITIES, { numeric: true, free: true }));
    b.appendChild(numberRow("ν manual", "fluid.viscosity_m2s", { min: 1e-9, max: 1, unit: "m²/s" }));
    b.appendChild(readout(() => [
      ["ν", sci(state.config.fluid.viscosity_m2s) + " m²/s"],
      ["ρ", nf(state.config.fluid.density_kgm3, 3) + " kg/m³"]
    ]));
    b.appendChild(hint(() => "Density only scales the reported forces; for the flow pattern only the viscosity matters."));
  }));

  panel.appendChild(group("Lattice scaling", true, b => {
    b.appendChild(slider("u (LBM)", "fluid.u_lbm", { min: 0.005, max: 0.25, step: 0.001, digits: 3 }));
    b.appendChild(readout(d => [
      ["Reynolds", sci(d.Re)],
      ["ν (LBM)", sci(d.nuLbm)],
      ["τ", nf(d.tau, 7)],
      ["τ − ½", sci(d.tau - 0.5)],
      ["Time step", sci(d.dt) + " s"]
    ]));
    b.appendChild(hint(d => {
      if (d.tau - 0.5 < 5e-4) {
        return hasExt("SUBGRID")
          ? ["τ is practically at 0.5 — unavoidable at this Reynolds number. SUBGRID keeps the run stable.", true]
          : ["τ is practically at 0.5 and SUBGRID is off — the run will very likely diverge.", "crit"];
      }
      return "τ > 0.5 is the stability condition. A smaller u (LBM) lowers τ and slows the run down.";
    }));
  }));
}

/* ------------------------------------------------------------ boundaries --- */

function buildBoundaries(panel) {
  panel.appendChild(group("Box faces", true, b => {
    const faces = el("div", "faces");
    for (const face of BOUNDARY_FACES) {
      const f = el("div", "face");
      f.appendChild(el("span", null, LABELS.face[face]));
      const s = document.createElement("select");
      s.setAttribute("aria-label", LABELS.face[face]);
      for (const type of BOUNDARY_TYPES) {
        const o = document.createElement("option");
        o.value = type;
        o.textContent = LABELS.boundary[type];
        if (state.config.boundaries[face] === type) o.selected = true;
        s.appendChild(o);
      }
      s.addEventListener("change", () => patch(`boundaries.${face}`, s.value));
      f.appendChild(s);
      faces.appendChild(f);
    }
    b.appendChild(faces);
    b.appendChild(btnRow([
      ["Wind tunnel", () => setFaces({ xmin: "equilibrium", xmax: "equilibrium", ymin: "equilibrium", ymax: "equilibrium", zmin: "equilibrium", zmax: "equilibrium" })],
      ["Ground effect", () => setFaces({ xmin: "equilibrium", xmax: "equilibrium", ymin: "equilibrium", ymax: "equilibrium", zmin: "solid", zmax: "equilibrium" })],
      ["Periodic", () => setFaces({ xmin: "periodic", xmax: "periodic", ymin: "equilibrium", ymax: "equilibrium", zmin: "periodic", zmax: "periodic" })]
    ]));
    b.appendChild(hint(() => {
      const values = BOUNDARY_FACES.map(f => state.config.boundaries[f]);
      if (values.includes("equilibrium") && !hasExt("EQUILIBRIUM_BOUNDARIES")) {
        return ["Equilibrium boundaries need the extension EQUILIBRIUM_BOUNDARIES — it is off in the solver panel.", "crit"];
      }
      return "Equilibrium boundaries impose velocity and density. Periodic boundaries are the FluidX3D default and cost nothing.";
    }));
  }));
}

function setFaces(map) {
  for (const [face, type] of Object.entries(map)) patch(`boundaries.${face}`, type);
}

/* ------------------------------------------------------------- reference --- */

function buildReference(panel) {
  const objects = state.config.objects || [];
  const fromObject = state.config.reference.source.startsWith("object:");

  panel.appendChild(group("Source", true, b => {
    const options = [["manual", "By hand"]];
    for (const o of objects) options.push(["object:" + o.id, o.name]);
    b.appendChild(dropdown("Source", "reference.source", options));
    b.appendChild(slider("Length", "reference.length_m", {
      min: 0.05, max: 200, step: 0.05, digits: 2, unit: "m", disabled: fromObject
    }));
    b.appendChild(readout(d => [
      ["Reference length", nf(d.refLength, 2) + " m"],
      ["Reynolds", sci(d.Re)],
      ["resolved by", ni(d.lbmSpan) + " cells"]
    ]));
    b.appendChild(hint(() => fromObject
      ? "The length comes from the object's sizing and follows it automatically."
      : "Re = u · L / ν. Choose the length you want to compare the Reynolds number against — span, chord or fuselage length."));
  }));
}

/* --------------------------------------------------------- visualization --- */

const VIS_DEFINES = {
  solid: "VIS_FLAG_SURFACE",
  flags: "VIS_FLAG_LATTICE",
  field: "VIS_FIELD",
  streamlines: "VIS_STREAMLINES",
  q_criterion: "VIS_Q_CRITERION"
};

function buildVisualization(panel) {
  panel.appendChild(group("Modes", true, b => {
    for (const mode of VIS_MODES) {
      b.appendChild(toggle(LABELS.visMode[mode], () => (state.config.visualization.modes || []).includes(mode),
        on => setList("visualization.modes", VIS_MODES, mode, on), { note: VIS_DEFINES[mode] }));
    }
    b.appendChild(hint(() => (state.config.visualization.modes || []).length === 0
      ? ["No mode selected — the window stays empty.", true]
      : "Several modes can be overlaid; in the running window you switch them with 1–7."));
  }));

  panel.appendChild(group("Thresholds", true, b => {
    b.append(
      slider("Q value", "visualization.q_criterion", { min: 0.00005, max: 0.005, step: 0.00005, digits: 5 }),
      slider("u max", "visualization.u_max", { min: 0.02, max: 0.5, step: 0.005, digits: 3 })
    );
    b.appendChild(hint(() => "Higher Q values show less vortex clutter. u max is the upper end of the colour scale in lattice units."));
  }));

  panel.appendChild(group("Background", false, b => {
    const row = el("div", "row");
    row.appendChild(el("label", null, "Colour"));
    const ctl = el("div", "ctl");
    const picker = document.createElement("input");
    picker.type = "color";
    picker.setAttribute("aria-label", "Background colour");
    picker.value = toHash(state.config.visualization.background);
    picker.addEventListener("input", () => patch("visualization.background", toHex(picker.value)));
    ctl.appendChild(picker);
    row.appendChild(ctl);
    b.appendChild(row);
    live.push(() => {
      if (document.activeElement !== picker) picker.value = toHash(state.config.visualization.background);
    });
    b.appendChild(readout(() => [["GRAPHICS_BACKGROUND_COLOR", state.config.visualization.background]]));
  }));
}

const toHash = v => "#" + String(v || "0x000000").replace(/^0x/i, "").padStart(6, "0").slice(0, 6);
const toHex = v => "0x" + String(v || "#000000").replace(/^#/, "").toUpperCase();

/* ---------------------------------------------------------------- solver --- */

const VSET_LABELS = {
  15: "D3Q15 — fast, less accurate",
  19: "D3Q19 — default",
  27: "D3Q27 — accurate, expensive"
};
const PRECISION_LABELS = {
  FP32: "FP32 — full",
  FP16S: "FP16S — 2× faster",
  FP16C: "FP16C — more accurate than FP16S"
};
const EXT_NOTES = {
  SUBGRID: "LES turbulence",
  EQUILIBRIUM_BOUNDARIES: "inlet and outlet",
  MOVING_BOUNDARIES: "rotating objects",
  VOLUME_FORCE: null,
  FORCE_FIELD: "+12 B/cell",
  SURFACE: "+12 B/cell",
  TEMPERATURE: "+18 B/cell",
  PARTICLES: null
};

function buildSolver(panel) {
  panel.appendChild(group("Discretization", true, b => {
    b.append(
      dropdown("Velocity set", "solver.velocity_set", VELOCITY_SETS.map(v => [v, VSET_LABELS[v]]), { numeric: true }),
      dropdown("Precision", "solver.precision", PRECISIONS.map(p => [p, PRECISION_LABELS[p]]))
    );
    b.appendChild(readout(d => [
      ["Bytes per cell", ni(bytesPerCell(state.config.solver))],
      ["Bandwidth per step", ni(bandwidthPerCell(state.config.solver)) + " B"],
      ["Throughput", ni(d.mlups) + " MLUPs"]
    ]));
    b.appendChild(hint(() => "FP16S halves the memory of the distributions and so nearly doubles the throughput; density stays FP32 internally."));
  }));

  panel.appendChild(group("Extensions", true, b => {
    const particlesOk = hasExt("VOLUME_FORCE") && hasExt("FORCE_FIELD");
    for (const ext of EXTENSIONS) {
      const blocked = ext === "PARTICLES" && !particlesOk;
      b.appendChild(toggle(ext, () => hasExt(ext), on => setList("solver.extensions", EXTENSIONS, ext, on), {
        note: blocked ? "needs VOLUME_FORCE + FORCE_FIELD" : EXT_NOTES[ext],
        rebuild: true,
        disabled: blocked,
        reason: "PARTICLES requires VOLUME_FORCE and FORCE_FIELD"
      }));
    }
    b.appendChild(hint(() => {
      const rotating = (state.config.objects || []).some(o => o.motion.type === "rotate");
      if (rotating && !hasExt("MOVING_BOUNDARIES")) {
        return ["An object rotates, but MOVING_BOUNDARIES is off — the rotation would have no effect.", "crit"];
      }
      const equilibrium = BOUNDARY_FACES.some(f => state.config.boundaries[f] === "equilibrium");
      if (equilibrium && !hasExt("EQUILIBRIUM_BOUNDARIES")) {
        return ["Equilibrium boundaries are set, but EQUILIBRIUM_BOUNDARIES is off.", "crit"];
      }
      return "These switches end up in defines.hpp. Every change forces a rebuild — the header shows whether the binary still matches.";
    }));
  }));
}

/* ------------------------------------------------------------------- run --- */

function buildRun(panel) {
  const render = state.config.run.mode === "render";

  panel.appendChild(group("Mode", true, b => {
    b.appendChild(dropdown("Mode", "run.mode", RUN_MODES.map(m => [m, LABELS.runMode[m]])));
    b.appendChild(hint(() => render
      ? "The render run has no window and stores the frames under bin/export/."
      : "The interactive run opens the FluidX3D window: P starts and pauses, H shows the help."));
  }));

  panel.appendChild(group("Duration", true, b => {
    b.append(
      slider("Simulated", "run.duration_s", { min: 0.1, max: 120, step: 0.1, digits: 1, unit: "s" }),
      slider("Frame rate", "run.fps", { min: 1, max: 120, step: 1, digits: 0, unit: "fps" })
    );
    b.appendChild(readout(d => [
      ["Time steps", bigCells(d.runSteps)],
      ["Frames", ni(d.frames)],
      ["Compute time", dur(d.runSeconds)]
    ]));
    b.appendChild(hint(() => render
      ? "Duration and frame rate apply to the render run only."
      : "In interactive mode the simulation runs until you close the window; these values are not used."));
  }));

  panel.appendChild(group("Camera", render, b => {
    b.appendChild(dropdown("Type", "run.camera.type", CAMERA_TYPES.map(t => [t, t === "orbit" ? "Orbiting" : "Fixed"])));
    if (state.config.run.camera.type === "orbit") {
      b.append(
        slider("Azimuth from", "run.camera.azimuth_from_deg", { min: -360, max: 360, step: 1, digits: 0, unit: "°" }),
        slider("Azimuth to", "run.camera.azimuth_to_deg", { min: -360, max: 360, step: 1, digits: 0, unit: "°" })
      );
    }
    b.append(
      slider("Elevation", "run.camera.elevation_deg", { min: -89, max: 89, step: 1, digits: 0, unit: "°" }),
      slider("Distance", "run.camera.distance", { min: 1, max: 500, step: 1, digits: 0, unit: "m" }),
      slider("Zoom", "run.camera.zoom", { min: 0.1, max: 6, step: 0.05, digits: 2 })
    );
    b.appendChild(hint(() => "The distance is measured in metres from the centre of the domain."));
  }));
}

/* =================================================================== object */

function buildObject(panel, obj) {
  const index = objectIndex(obj.id);
  if (index < 0) return;
  const p = `objects.${index}`;
  const entry = stlEntry(obj);

  const head = header(obj.name || obj.id, "Placement, sizing and motion in the simulation box.");
  panel.appendChild(head);
  live.push(() => {
    const current = read(`${p}.name`);
    const h2 = head.querySelector("h2");
    if (h2 && current) h2.textContent = current;
  });

  /* ------------------------------------------------------------- source --- */
  panel.appendChild(group("Source file", true, b => {
    b.appendChild(textRow("Name", `${p}.name`));

    const file = el("div", "file");
    file.appendChild(el("span", "name", obj.file ? obj.file.replace(/^uploads\//, "") : "no file"));
    file.title = obj.file || "no file";
    if (entry) file.appendChild(el("span", "meta", ni(entry.triangles) + " ▲"));
    b.appendChild(file);

    if (entry) {
      const bb = entry.bbox || { min: [0, 0, 0], max: [0, 0, 0] };
      const size = [0, 1, 2].map(i => Number(bb.max[i]) - Number(bb.min[i]));
      b.appendChild(readout(() => [
        ["Triangles", ni(entry.triangles)],
        // raw file coordinates — an STL carries no unit, so no "m" here
        ["Bounding box", size.map(v => nf(v, 2)).join(" × ") + " units"],
        ["Longest edge", nf(longestEdge(entry.bbox), 3) + " units"]
      ]));
    } else {
      b.appendChild(hint(() => ["This file is no longer in the upload folder. Without it the solver cannot voxelize the object.", "crit"]));
    }

    b.appendChild(toggle("Visible in editor", () => !!read(`${p}.visible`), on => patch(`${p}.visible`, on)));
    b.appendChild(toggle("Active in simulation", () => !!read(`${p}.enabled`), on => patch(`${p}.enabled`, on),
      { note: "gets voxelized" }));
  }));

  /* ------------------------------------------------------------ scaling --- */
  panel.appendChild(group("Sizing", true, b => {
    b.appendChild(dropdown("Mode", `${p}.sizing.mode`, SIZING_MODES.map(m => [m, LABELS.sizing[m]])));
    if (obj.sizing.mode === "longest_edge_m") {
      b.appendChild(slider("Length", `${p}.sizing.value`, { min: 0.05, max: 200, step: 0.05, digits: 2, unit: "m" }));
    } else {
      b.appendChild(slider("Factor", `${p}.sizing.value`, { min: 0.01, max: 50, step: 0.01, digits: 2, unit: "×" }));
    }
    b.appendChild(readout(d => [
      ["Longest edge", nf(objectMetres(current(index)), 3) + " m"],
      ["resolved by", ni(objectMetres(current(index)) / d.cell) + " cells"],
      ["Cell size", nf(d.cell * 100, 2) + " cm"]
    ]));
    const isReference = state.config.reference.source === "object:" + obj.id;
    b.appendChild(btnRow([
      [isReference ? "is reference length for Re" : "use as reference length for Re", () => {
        patch("reference.length_m", Math.max(1e-6, objectMetres(current(index))));
        patch("reference.source", "object:" + obj.id);
      }, isReference]
    ]));
    b.appendChild(hint(d => objectMetres(current(index)) / d.cell < 30
      ? ["Fewer than 30 cells across the longest edge — the voxelization will be very coarse.", true]
      : "An STL file carries no unit — on loading, its size is used to guess whether it is in metres, "
      + "centimetres or millimetres. \"Longest edge\" fixes the size for good; if the size is "
      + "wrong, correct it here."));
  }));

  /* ---------------------------------------------------------- placement --- */
  panel.appendChild(group("Position in the box", true, b => {
    b.append(
      slider("Position X", `${p}.position_frac.0`, { min: 0, max: 1, step: 0.005, digits: 3 }),
      slider("Position Y", `${p}.position_frac.1`, { min: 0, max: 1, step: 0.005, digits: 3 }),
      slider("Position Z", `${p}.position_frac.2`, { min: 0, max: 1, step: 0.005, digits: 3 })
    );
    b.appendChild(readout(() => {
      const size = state.config.domain.size_m;
      const frac = read(`${p}.position_frac`) || [0, 0, 0];
      return [
        ["x", nf(frac[0] * size[0], 2) + " m"],
        ["y", nf(frac[1] * size[1], 2) + " m"],
        ["z", nf(frac[2] * size[2], 2) + " m"]
      ];
    }));
    b.appendChild(btnRow([["Focus view", () =>
      document.dispatchEvent(new CustomEvent(EV_FOCUS_OBJECT, { detail: { id: obj.id } }))]]));
    b.appendChild(hint(() => "Fraction of the box edge, measured from the lower corner. 0.5 is the centre."));
  }));

  /* ------------------------------------------------------------- angles --- */
  panel.appendChild(group("Angles", true, b => {
    b.append(
      slider("Pitch", `${p}.rotation_deg.pitch`, { min: -90, max: 90, step: 0.5, digits: 1, unit: "°" }),
      slider("Yaw", `${p}.rotation_deg.yaw`, { min: -180, max: 180, step: 0.5, digits: 1, unit: "°" }),
      slider("Roll", `${p}.rotation_deg.roll`, { min: -180, max: 180, step: 0.5, digits: 1, unit: "°" })
    );
    b.appendChild(hint(() => "Order Rz(yaw) · Rx(pitch) · Ry(roll), applied about the object's own centre."));
  }));

  /* ------------------------------------------------------------- motion --- */
  panel.appendChild(group("Motion", obj.motion.type !== "none", b => {
    b.appendChild(dropdown("Type", `${p}.motion.type`, MOTION_TYPES.map(m => [m, LABELS.motion[m]])));
    if (obj.motion.type !== "rotate") {
      b.appendChild(hint(() => "Static objects are voxelized once and cost nothing afterwards."));
      return;
    }

    b.appendChild(vecRow("Rotation axis", `${p}.motion.axis`));
    b.append(
      slider("Speed", `${p}.motion.rpm`, { min: -6000, max: 6000, step: 5, digits: 0, unit: "rpm" }),
      slider("Interval", `${p}.motion.revoxelize_interval`, { min: 1, max: 64, step: 1, digits: 0, unit: "steps" })
    );
    b.appendChild(readout(d => {
      const o = current(index);
      const rpm = o.motion.rpm;
      const radius = objectMetres(o) / 2;
      const tip = Math.abs(rpm) / 60 * 2 * Math.PI * radius;
      return [
        ["ω", nf(rpm * Math.PI / 30, 2) + " rad/s"],
        ["Blade tip", nf(tip, 1) + " m/s"],
        ["Tip Mach", nf(tip / SPEED_OF_SOUND, 3)],
        ["Rotation per interval", nf(Math.abs(rpm) / 60 * 360 * d.dt * o.motion.revoxelize_interval, 3) + " °"]
      ];
    }));
    b.appendChild(hint(d => {
      const o = current(index);
      const tip = Math.abs(o.motion.rpm) / 60 * Math.PI * objectMetres(o);
      if (!hasExt("MOVING_BOUNDARIES")) {
        return ["Without the extension MOVING_BOUNDARIES the rotation has no effect — turn it on in the solver panel.", "crit"];
      }
      if (tip / SPEED_OF_SOUND > 0.75) {
        return ["Above Mach 0.75 at the blade tip you leave the valid range of the weakly compressible solver.", true];
      }
      const perInterval = Math.abs(o.motion.rpm) / 60 * 360 * d.dt * o.motion.revoxelize_interval;
      if (perInterval > 5) {
        return ["More than 5° per interval — the rotation becomes visibly stepped. Choose a smaller interval.", true];
      }
      return "Every interval the object is re-voxelized and rotated on. Larger intervals save compute time.";
    }));
  }));

  /* ------------------------------------------------------------ sealing --- */
  const seal0 = sealingOf(obj);
  panel.appendChild(group("Sealing", seal0.mode !== "off" || !!seal0.sealed_file,
    b => buildSealing(b, obj, index, p)));

  panel.appendChild(group("Object", false, b => {
    b.appendChild(btnRow([["Remove object", () => removeObject(obj.id), false, "danger"]]));
    b.appendChild(hint(() => "The STL file stays in the upload folder and can be added again."));
  }));
}

/* =================================================================== sealing */

/**
 * "Sealing" — CONTRACT.md section 8.
 *
 * The whole group is refresher driven: nothing here rebuilds the panel, the
 * controls only change their text, their disabled state and their visibility.
 * That keeps the two sliders usable while they are dragged and it keeps the
 * running request visible even when the panel is rebuilt underneath it.
 */

const sealingOf = obj => (obj && obj.sealing) || defaultSealing();

/** The upload an object was built from — the original, never the sealed copy. */
const sourceFileOf = obj => (obj && obj.source_file) || (obj && obj.file) || "";

function buildSealing(body, obj, index, p) {
  const objId = obj.id;
  const holes = SEALING_LIMITS.close_holes;
  const thick = SEALING_LIMITS.min_thickness;

  body.appendChild(dropdown("Method", `${p}.sealing.mode`,
    SEALING_MODES.map(m => [m, LABELS.sealing[m]])));

  const holesRow = slider("Close holes", `${p}.sealing.close_holes`,
    { min: holes.min, max: holes.max, step: 1, digits: 0, unit: "cells" });
  const thickRow = slider("Min. wall", `${p}.sealing.min_thickness`,
    { min: thick.min, max: thick.max, step: 1, digits: 0, unit: "cells" });
  // the label column is narrow, so the full wording lives in the tooltip
  holesRow.title = "Openings up to twice this width are closed";
  thickRow.title = "Minimum wall thickness in cells";
  body.append(holesRow, thickRow);

  const gridLine = el("p", "hint");
  const motionLine = el("p", "hint alert");
  body.append(gridLine, motionLine);

  body.appendChild(hint(() => {
    const s = sealingOf(current(index));
    if (s.mode === "shell") {
      return "Shell: walls are thickened to cell size, cavities stay hollow. Only useful when an interior is intended.";
    }
    if (s.mode === "fill") {
      return "Shell + fill: the body becomes solid inside. For bodies in external flow this is the safe choice — only the wetted surface counts. The minimum wall thickness then still acts on free-standing surfaces such as flaps or rudders.";
    }
    return "FluidX3D loses every wall thinner than one cell during voxelization — hit distances are rounded to whole cells, and a thin wall flips the inside state twice within the same step.";
  }));

  live.push(() => {
    const o = current(index);
    const s = sealingOf(o);
    const d = D();
    const off = s.mode === "off";

    setRowDisabled(holesRow, off);
    setRowDisabled(thickRow, off);

    /**
     * Nothing is precomputed. The solver seals while it builds the scene, on
     * the grid it is about to run — so changing the VRAM target changes the
     * sealing with it, and there is no stored result that could go stale.
     */
    gridLine.textContent = off
      ? "Off: the solver voxelizes as before — thin walls get lost."
      : `Computed at launch, on the grid of this run (${nf(d.cell * 100, 2)} cm cells). ` +
        `If you change the VRAM target, the sealing changes with it.`;

    const rotating = o.motion && o.motion.type === "rotate";
    show(motionLine, !!rotating);
    motionLine.textContent =
      "This object rotates. FluidX3D re-voxelizes moving bodies itself every few steps — " +
      "sealing on every step would be too expensive and is skipped here.";
  });
}

/** ISO timestamp as a short date, "—" when there is none. */
function dateText(iso) {
  if (typeof iso !== "string" || !iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  return t.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
}

/** Re-reads the object by index, so refreshers never work on a stale copy. */
const current = index => (state.config.objects || [])[index] || { sizing: { mode: "scale", value: 1 }, motion: { type: "none", rpm: 0, revoxelize_interval: 1 }, file: "" };

/* =================================================================== pieces */

function header(title, subtitle) {
  const head = el("div", "insp-head");
  head.append(el("h2", null, title), el("p", null, subtitle));
  return head;
}

function group(title, open, build) {
  const d = document.createElement("details");
  d.className = "group";
  d.open = !!open;
  d.appendChild(el("summary", null, title));
  const body = el("div", "group-body");
  build(body);
  d.appendChild(body);
  return d;
}

function labelledRow(label, ctl) {
  const row = el("div", "row");
  row.appendChild(el("label", null, label));
  row.appendChild(ctl);
  return row;
}

/**
 * Range plus number field on one config path.
 * Options: min, max, step, digits, unit, disabled.
 */
function slider(label, path, options = {}) {
  const { min = 0, max = 1, step = 0.01, unit, disabled = false } = options;
  const digits = options.digits !== undefined ? options.digits : decimalsOf(step);
  const fmt = v => Number(v).toFixed(digits);

  const ctl = el("div", "ctl");
  const range = document.createElement("input");
  range.type = "range";
  range.min = String(min); range.max = String(max); range.step = String(step);
  range.setAttribute("aria-label", label);
  range.disabled = disabled;

  const number = document.createElement("input");
  number.type = "number";
  number.min = String(min); number.max = String(max); number.step = String(step);
  number.setAttribute("aria-label", label + ", value");
  number.disabled = disabled;

  range.addEventListener("input", () => {
    const v = Number(range.value);
    number.value = fmt(v);
    patch(path, v);
  });
  number.addEventListener("change", () => {
    const v = clamp(parseNum(number.value, Number(read(path)) || min), min, max);
    number.value = fmt(v);
    range.value = String(v);
    patch(path, v);
  });

  live.push(() => {
    if (document.activeElement === range || document.activeElement === number) return;
    const v = Number(read(path));
    if (!Number.isFinite(v)) return;
    range.value = String(clamp(v, min, max));
    number.value = fmt(v);
  });

  ctl.append(range, number);
  if (unit) ctl.appendChild(el("span", "unit", unit));
  return labelledRow(label, ctl);
}

/**
 * A single number field, for values whose range spans decades and where a
 * slider would be useless — exponent notation like `1.48e-5` is accepted.
 */
function numberRow(label, path, options = {}) {
  const { min = -Infinity, max = Infinity, unit } = options;
  const ctl = el("div", "ctl");
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.style.width = "100%";
  input.setAttribute("aria-label", label);

  const show = () => {
    const v = Number(read(path));
    input.value = Number.isFinite(v) ? String(Number(v.toPrecision(6))) : "";
  };
  show();

  input.addEventListener("change", () => {
    const v = clamp(parseNum(input.value, Number(read(path)) || 0), min, max);
    patch(path, v);
    show();
  });
  live.push(() => { if (document.activeElement !== input) show(); });

  ctl.appendChild(input);
  if (unit) ctl.appendChild(el("span", "unit", unit));
  return labelledRow(label, ctl);
}

/** Free text on a config path; written on change, never on every keystroke. */
function textRow(label, path) {
  const ctl = el("div", "ctl");
  const input = document.createElement("input");
  input.type = "text";
  input.spellcheck = false;
  input.style.flex = "1 1 auto";
  input.setAttribute("aria-label", label);
  input.value = String(read(path) ?? "");
  input.addEventListener("change", () => {
    const v = input.value.trim();
    if (v) patch(path, v);
    else input.value = String(read(path) ?? "");
  });
  live.push(() => {
    if (document.activeElement !== input) input.value = String(read(path) ?? "");
  });
  ctl.appendChild(input);
  return labelledRow(label, ctl);
}

/** Three number fields on `path.0 … path.2`. */
function vecRow(label, path) {
  const ctl = el("div", "ctl");
  const vec = el("div", "vec");
  const inputs = [];
  for (let i = 0; i < 3; i++) {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "0.1";
    input.setAttribute("aria-label", `${label}, component ${i + 1}`);
    input.addEventListener("change", () => {
      patch(`${path}.${i}`, parseNum(input.value, Number(read(`${path}.${i}`)) || 0));
    });
    inputs.push(input);
    vec.appendChild(input);
  }
  live.push(() => {
    const v = read(path) || [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (document.activeElement === inputs[i]) continue;
      inputs[i].value = Number(v[i] || 0).toFixed(3);
    }
  });
  ctl.appendChild(vec);
  return labelledRow(label, ctl);
}

/**
 * Select on a config path.
 * `numeric` converts the value back to a number, `free` keeps a value that is
 * not in the list selectable by showing it as an extra entry.
 */
function dropdown(label, path, options, config = {}) {
  const ctl = el("div", "ctl");
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);

  const fill = () => {
    select.textContent = "";
    const value = read(path);
    let matched = false;
    for (const [v, text] of options) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = text;
      if (String(value) === String(v)) { o.selected = true; matched = true; }
      select.appendChild(o);
    }
    if (!matched) {
      const o = document.createElement("option");
      o.value = String(value);
      o.textContent = config.free ? `custom value (${sci(Number(value))})` : String(value);
      o.selected = true;
      select.appendChild(o);
    }
  };
  fill();

  select.addEventListener("change", () => {
    patch(path, config.numeric ? Number(select.value) : select.value);
  });
  live.push(() => {
    if (document.activeElement === select) return;
    if (String(read(path)) !== select.value) fill();
  });

  ctl.appendChild(select);
  return labelledRow(label, ctl);
}

/**
 * Checkbox with the prototype's decorations.
 * `get` reads the current state, `set` receives the new boolean.
 */
function toggle(label, get, set, options = {}) {
  const wrap = el("label", "check" + (options.disabled ? " disabled" : ""));
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = !!get();
  box.disabled = !!options.disabled;
  box.addEventListener("change", () => set(box.checked));

  wrap.append(box, el("span", null, label));
  if (options.note) wrap.appendChild(el("span", "note", options.note));
  if (options.disabled && options.reason) wrap.title = options.reason;
  if (options.rebuild) wrap.appendChild(el("span", "rebuild", "rebuild"));

  live.push(() => { box.checked = !!get(); });
  return wrap;
}

/** Buttons: `[label, onClick, disabled?, extraClass?]`. */
function btnRow(entries) {
  const row = el("div", "btn-row");
  for (const [label, onClick, disabled, cls] of entries) {
    const b = el("button", cls || null, label);
    b.disabled = !!disabled;
    b.addEventListener("click", onClick);
    row.appendChild(b);
  }
  return row;
}

/** `fn(derived)` returns `[[label, value], …]`; re-run on every live update. */
function readout(fn) {
  const box = el("div", "derived");
  const build = () => {
    box.textContent = "";
    let rows;
    try {
      rows = fn(D());
    } catch {
      rows = [["—", "—"]];
    }
    for (const [k, v] of rows) {
      const line = el("div");
      line.append(el("span", null, k), el("b", null, v));
      box.appendChild(line);
    }
  };
  build();
  live.push(build);
  return box;
}

/** `fn(derived)` returns text or `[text, true|"crit"]`. */
function hint(fn) {
  const p = el("p", "hint");
  const build = () => {
    let result;
    try {
      result = fn(D());
    } catch {
      result = "";
    }
    const [text, level] = Array.isArray(result) ? result : [result, false];
    p.textContent = text;
    p.classList.toggle("alert", level === true);
    p.classList.toggle("crit", level === "crit");
  };
  build();
  live.push(build);
  return p;
}

/* =================================================================== helpers */

/** Adds or removes a name from an array-valued path, keeping the canonical order. */
function setList(path, order, name, on) {
  const set = new Set(read(path) || []);
  if (on) set.add(name); else set.delete(name);
  patch(path, order.filter(v => set.has(v)));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

/**
 * Shows or hides an element without rebuilding anything. `display` is set
 * directly because the stylesheet gives `.derived` a display of its own, which
 * would win over the `hidden` attribute.
 */
function show(node, on) {
  node.style.display = on ? "" : "none";
}

/** Enables or disables every input of a row built by `slider()`. */
function setRowDisabled(row, off) {
  for (const input of row.querySelectorAll("input")) input.disabled = !!off;
}

/** Refills a `.derived` box in place with `[[label, value], …]`. */
function fillRows(box, rows) {
  box.textContent = "";
  for (const [k, v] of rows) {
    const line = el("div");
    line.append(el("span", null, k), el("b", null, v));
    box.appendChild(line);
  }
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function decimalsOf(step) {
  const s = String(step);
  if (s.includes("e-")) return Math.min(9, Number(s.split("e-")[1]) + 1);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}
