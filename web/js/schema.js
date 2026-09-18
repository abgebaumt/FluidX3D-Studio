/**
 * Setup configuration schema, version 1 — browser side.
 *
 * Mirrors server/schema.js. CONTRACT.md section 1 is the source of truth for
 * every field; this module only knows how to produce a default, how to check
 * a config and how to turn an uploaded STL into an object entry.
 */

export const SCHEMA_VERSION = 1;

export const BOUNDARY_TYPES = ["equilibrium", "solid", "periodic", "open"];
export const BOUNDARY_FACES = ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"];
export const VELOCITY_SETS = [15, 19, 27];
export const PRECISIONS = ["FP32", "FP16S", "FP16C"];
export const EXTENSIONS = [
  "SUBGRID", "EQUILIBRIUM_BOUNDARIES", "MOVING_BOUNDARIES", "VOLUME_FORCE",
  "FORCE_FIELD", "SURFACE", "TEMPERATURE", "PARTICLES"
];
export const VIS_MODES = ["solid", "flags", "field", "streamlines", "q_criterion"];
export const RUN_MODES = ["interactive", "render"];
export const CAMERA_TYPES = ["orbit", "fixed"];
export const SIZING_MODES = ["longest_edge_m", "scale"];
export const MOTION_TYPES = ["none", "rotate"];
export const OBJECT_TYPES = ["stl"];
export const SEALING_MODES = ["off", "shell", "fill"];

/** Limits of the sealing controls, shared with the inspector. */
export const SEALING_LIMITS = {
  close_holes: { min: 0, max: 3 },
  min_thickness: { min: 1, max: 5 }
};

/** Display labels for the enums, so every panel spells them the same way. */
export const LABELS = {
  boundary: {
    equilibrium: "Equilibrium (in/out)",
    solid: "Solid wall",
    periodic: "Periodic",
    open: "Open"
  },
  face: {
    xmin: "−X left", xmax: "+X right",
    ymin: "−Y front", ymax: "+Y back",
    zmin: "−Z bottom", zmax: "+Z top"
  },
  visMode: {
    solid: "Solid surface",
    flags: "Flags",
    field: "Velocity field",
    streamlines: "Streamlines",
    q_criterion: "Q-criterion"
  },
  runMode: { interactive: "Interactive", render: "Render" },
  sizing: { longest_edge_m: "Longest edge in metres", scale: "Factor" },
  motion: { none: "Static", rotate: "Rotating" },
  sealing: { off: "Off (as before)", shell: "Shell", fill: "Shell + fill" }
};

/** A complete, runnable setup — the state the editor starts from. */
export function defaultConfig() {
  return {
    schema: SCHEMA_VERSION,
    name: "new_setup",

    domain: {
      size_m: [36.0, 60.0, 18.0],
      target_vram_mb: 10000
    },

    fluid: {
      velocity_ms: 30.0,
      azimuth_deg: 0.0,
      elevation_deg: 0.0,
      density_kgm3: 1.225,
      viscosity_m2s: 1.48e-5,
      u_lbm: 0.075
    },

    boundaries: {
      xmin: "equilibrium", xmax: "equilibrium",
      ymin: "equilibrium", ymax: "equilibrium",
      zmin: "equilibrium", zmax: "equilibrium"
    },

    reference: {
      length_m: 25.5,
      source: "manual"
    },

    objects: [],

    visualization: {
      modes: ["solid", "q_criterion"],
      q_criterion: 0.0008,
      u_max: 0.18,
      background: "0xCCE4FF"
    },

    solver: {
      velocity_set: 19,
      precision: "FP16S",
      extensions: ["SUBGRID", "EQUILIBRIUM_BOUNDARIES"]
    },

    run: {
      mode: "interactive",
      duration_s: 4.0,
      fps: 60,
      camera: {
        type: "orbit",
        azimuth_from_deg: -70.0, azimuth_to_deg: 70.0,
        elevation_deg: 20.0, distance: 60.0, zoom: 1.3
      }
    }
  };
}

/** A fresh object entry, as it would sit in `config.objects`. */
export function defaultObject() {
  return {
    id: "obj-1",
    name: "Object",
    type: "stl",
    file: "",
    enabled: true,
    visible: true,
    sizing: { mode: "longest_edge_m", value: 1.0 },
    position_frac: [0.5, 0.4, 0.5],
    rotation_deg: { pitch: 0.0, yaw: 0.0, roll: 0.0 },
    motion: { type: "none", axis: [0.0, 1.0, 0.0], rpm: 0.0, revoxelize_interval: 4 },
    sealing: defaultSealing()
  };
}

/**
 * The sealing block of an object, CONTRACT.md section 8 — parameters only,
 * nothing computed yet. `cell_m`, `sealed_file`, `computed_at` and `stats` are
 * filled by the server's answer and stay null until then.
 */
export function defaultSealing() {
  return {
    mode: "off",
    close_holes: 1,
    min_thickness: 1,
    cell_m: null,
    sealed_file: null,
    computed_at: null,
    stats: null
  };
}

/**
 * Builds an object entry from an `/api/stl` index entry.
 * `existing` is used only to pick an id that is still free.
 */
export function makeObject(stlEntry, existing = []) {
  const o = defaultObject();
  const e = stlEntry || {};
  o.id = nextObjectId(existing);
  o.name = prettyName(e.name || e.file || "Object");
  o.file = typeof e.file === "string" ? e.file : "";
  o.sizing = { mode: "longest_edge_m", value: round(guessSizeInMetres(e.bbox), 4) };
  return o;
}

/** Smallest free "obj-N" id for the given list of objects. */
export function nextObjectId(existing = []) {
  const used = new Set((existing || []).map(o => (o && o.id) || ""));
  for (let i = 1; i < 100000; i++) {
    const id = "obj-" + i;
    if (!used.has(id)) return id;
  }
  return "obj-" + Date.now().toString(36);
}

/** Longest edge of an `{min:[x,y,z], max:[x,y,z]}` box, 0 when unusable. */
/**
 * STL carries no unit. Blender and most CAD exports are in millimetres, and
 * taking those numbers for metres puts a 25 metre glider 25 kilometres wide —
 * it lands outside the domain and vanishes from the viewport.
 *
 * The guess: anything whose longest edge exceeds 300 is almost certainly
 * millimetres, above 30 centimetres. Nothing a person voxelises in a wind
 * tunnel is 300 metres long, and nothing useful is 0.3 mm. The user can
 * override the result in the sizing field, which is why a guess is acceptable
 * here — an invisible object is not.
 */
export function guessSizeInMetres(bbox) {
  const longest = longestEdge(bbox);
  if (!(longest > 0)) return 1.0;
  if (longest > 300) return longest / 1000;   // millimetres
  if (longest > 30) return longest / 100;     // centimetres
  return longest;                             // already metres
}

export function longestEdge(bbox) {
  if (!bbox || !Array.isArray(bbox.min) || !Array.isArray(bbox.max)) return 0;
  let best = 0;
  for (let i = 0; i < 3; i++) {
    const d = Number(bbox.max[i]) - Number(bbox.min[i]);
    if (Number.isFinite(d) && d > best) best = d;
  }
  return best;
}

/**
 * Checks a config and fills in everything that is missing.
 * Returns `{ ok, errors, config }` — `errors` are readable sentences, `config`
 * is a normalised deep copy that is safe to hand to the renderer even when
 * `ok` is false.
 */
export function validate(cfg) {
  const errors = [];
  const d = defaultConfig();     // untouched reference values
  const out = defaultConfig();   // the normalised result
  const src = isObject(cfg) ? cfg : {};
  if (!isObject(cfg)) errors.push("The configuration is not an object.");

  out.schema = SCHEMA_VERSION;
  if (src.schema !== undefined && Number(src.schema) !== SCHEMA_VERSION) {
    errors.push(`Unknown schema version ${src.schema}; expected ${SCHEMA_VERSION}.`);
  }

  out.name = cleanName(src.name, d.name);
  if (typeof src.name === "string" && src.name.trim() && out.name !== src.name.trim()) {
    errors.push("The setup name contained invalid characters and was cleaned up.");
  }

  // ------------------------------------------------------------------ domain
  const dom = isObject(src.domain) ? src.domain : {};
  out.domain.size_m = vec3(dom.size_m, d.domain.size_m, errors, "Domain size");
  for (let i = 0; i < 3; i++) {
    if (out.domain.size_m[i] <= 0) {
      errors.push("The domain size must be greater than zero on all three axes.");
      out.domain.size_m[i] = d.domain.size_m[i];
    }
  }
  out.domain.target_vram_mb = clampNum(
    dom.target_vram_mb, d.domain.target_vram_mb, 16, 1048576, errors, "VRAM target"
  );

  // ------------------------------------------------------------------- fluid
  const fl = isObject(src.fluid) ? src.fluid : {};
  out.fluid.velocity_ms = clampNum(fl.velocity_ms, d.fluid.velocity_ms, 1e-6, 1000, errors, "Inflow velocity");
  out.fluid.azimuth_deg = clampNum(fl.azimuth_deg, d.fluid.azimuth_deg, -180, 180, errors, "Azimuth");
  out.fluid.elevation_deg = clampNum(fl.elevation_deg, d.fluid.elevation_deg, -90, 90, errors, "Elevation");
  out.fluid.density_kgm3 = clampNum(fl.density_kgm3, d.fluid.density_kgm3, 1e-6, 100000, errors, "Density");
  out.fluid.viscosity_m2s = clampNum(fl.viscosity_m2s, d.fluid.viscosity_m2s, 1e-12, 1, errors, "Viscosity");
  out.fluid.u_lbm = clampNum(fl.u_lbm, d.fluid.u_lbm, 1e-4, 0.4, errors, "LBM velocity");

  // -------------------------------------------------------------- boundaries
  const bc = isObject(src.boundaries) ? src.boundaries : {};
  for (const f of BOUNDARY_FACES) {
    if (bc[f] === undefined) continue;
    if (BOUNDARY_TYPES.includes(bc[f])) out.boundaries[f] = bc[f];
    else errors.push(`Unknown boundary condition "${bc[f]}" on face ${f}.`);
  }

  // --------------------------------------------------------------- reference
  const ref = isObject(src.reference) ? src.reference : {};
  out.reference.length_m = clampNum(ref.length_m, d.reference.length_m, 1e-6, 100000, errors, "Reference length");
  if (typeof ref.source === "string" && ref.source) {
    if (ref.source === "manual" || ref.source.startsWith("object:")) out.reference.source = ref.source;
    else errors.push(`Unknown source of the reference length: "${ref.source}".`);
  }

  // ----------------------------------------------------------------- objects
  out.objects = [];
  const rawObjects = Array.isArray(src.objects) ? src.objects : [];
  if (src.objects !== undefined && !Array.isArray(src.objects)) {
    errors.push("The field \"objects\" must be a list.");
  }
  const seenIds = new Set();
  for (const raw of rawObjects) {
    if (!isObject(raw)) { errors.push("An entry in \"objects\" is not an object."); continue; }
    const o = validateObject(raw, out.objects, errors);
    if (seenIds.has(o.id)) {
      errors.push(`The object id "${o.id}" occurs more than once.`);
      o.id = nextObjectId(out.objects);
    }
    seenIds.add(o.id);
    out.objects.push(o);
  }

  if (out.reference.source.startsWith("object:")) {
    const id = out.reference.source.slice(7);
    if (!seenIds.has(id)) {
      errors.push(`The reference length points to the unknown object "${id}".`);
      out.reference.source = "manual";
    }
  }

  // ----------------------------------------------------------- visualization
  const vis = isObject(src.visualization) ? src.visualization : {};
  if (vis.modes !== undefined) {
    if (!Array.isArray(vis.modes)) {
      errors.push("The visualization modes must be a list.");
    } else {
      const modes = vis.modes.filter(m => {
        if (VIS_MODES.includes(m)) return true;
        errors.push(`Unknown visualization mode "${m}".`);
        return false;
      });
      out.visualization.modes = [...new Set(modes)];
    }
  }
  out.visualization.q_criterion = clampNum(vis.q_criterion, d.visualization.q_criterion, 1e-9, 1, errors, "Q-criterion");
  out.visualization.u_max = clampNum(vis.u_max, d.visualization.u_max, 1e-4, 10, errors, "u max");
  out.visualization.background = colour(vis.background, d.visualization.background, errors);

  // ------------------------------------------------------------------ solver
  const so = isObject(src.solver) ? src.solver : {};
  if (so.velocity_set !== undefined) {
    if (VELOCITY_SETS.includes(Number(so.velocity_set))) out.solver.velocity_set = Number(so.velocity_set);
    else errors.push(`Unknown velocity set "${so.velocity_set}"; allowed are 15, 19 and 27.`);
  }
  if (so.precision !== undefined) {
    if (PRECISIONS.includes(so.precision)) out.solver.precision = so.precision;
    else errors.push(`Unknown precision "${so.precision}".`);
  }
  if (so.extensions !== undefined) {
    if (!Array.isArray(so.extensions)) {
      errors.push("The extensions must be a list.");
    } else {
      const ext = so.extensions.filter(e => {
        if (EXTENSIONS.includes(e)) return true;
        errors.push(`Unknown extension "${e}".`);
        return false;
      });
      out.solver.extensions = [...new Set(ext)];
    }
  }
  if (out.solver.extensions.includes("PARTICLES")) {
    for (const need of ["VOLUME_FORCE", "FORCE_FIELD"]) {
      if (!out.solver.extensions.includes(need)) {
        errors.push(`PARTICLES requires ${need}.`);
      }
    }
  }
  if (out.objects.some(o => o.motion.type === "rotate") &&
      !out.solver.extensions.includes("MOVING_BOUNDARIES")) {
    errors.push("A rotating object needs the extension MOVING_BOUNDARIES.");
  }
  if (Object.values(out.boundaries).includes("equilibrium") &&
      !out.solver.extensions.includes("EQUILIBRIUM_BOUNDARIES")) {
    errors.push("Equilibrium boundaries need the extension EQUILIBRIUM_BOUNDARIES.");
  }

  // --------------------------------------------------------------------- run
  const run = isObject(src.run) ? src.run : {};
  if (run.mode !== undefined) {
    if (RUN_MODES.includes(run.mode)) out.run.mode = run.mode;
    else errors.push(`Unknown run mode "${run.mode}".`);
  }
  out.run.duration_s = clampNum(run.duration_s, d.run.duration_s, 1e-3, 100000, errors, "Duration");
  out.run.fps = Math.round(clampNum(run.fps, d.run.fps, 1, 240, errors, "Frame rate"));

  const cam = isObject(run.camera) ? run.camera : {};
  if (cam.type !== undefined) {
    if (CAMERA_TYPES.includes(cam.type)) out.run.camera.type = cam.type;
    else errors.push(`Unknown camera type "${cam.type}".`);
  }
  out.run.camera.azimuth_from_deg = clampNum(cam.azimuth_from_deg, d.run.camera.azimuth_from_deg, -3600, 3600, errors, "Camera azimuth");
  out.run.camera.azimuth_to_deg = clampNum(cam.azimuth_to_deg, d.run.camera.azimuth_to_deg, -3600, 3600, errors, "Camera azimuth");
  out.run.camera.elevation_deg = clampNum(cam.elevation_deg, d.run.camera.elevation_deg, -89, 89, errors, "Camera elevation");
  out.run.camera.distance = clampNum(cam.distance, d.run.camera.distance, 1e-3, 100000, errors, "Camera distance");
  out.run.camera.zoom = clampNum(cam.zoom, d.run.camera.zoom, 0.05, 100, errors, "Camera zoom");

  return { ok: errors.length === 0, errors, config: out };
}

/* ------------------------------------------------------------------ helpers */

function validateObject(raw, siblings, errors) {
  const o = defaultObject();
  o.id = typeof raw.id === "string" && /^[A-Za-z0-9_.:-]+$/.test(raw.id)
    ? raw.id
    : nextObjectId(siblings);
  if (typeof raw.id === "string" && raw.id !== o.id) {
    errors.push(`The object id "${raw.id}" is not allowed.`);
  }
  o.name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : o.id;

  if (raw.type !== undefined && !OBJECT_TYPES.includes(raw.type)) {
    errors.push(`Object "${o.name}": type "${raw.type}" is not supported by schema 1.`);
  }
  o.type = "stl";

  if (typeof raw.file === "string" && raw.file) o.file = raw.file.replace(/\\/g, "/");
  else errors.push(`Object "${o.name}" has no file.`);
  if (o.file.includes("..")) {
    errors.push(`Object "${o.name}": the file path must not lead outside data/.`);
    o.file = "";
  }

  o.enabled = raw.enabled === undefined ? true : !!raw.enabled;
  o.visible = raw.visible === undefined ? true : !!raw.visible;

  const sz = isObject(raw.sizing) ? raw.sizing : {};
  o.sizing.mode = SIZING_MODES.includes(sz.mode) ? sz.mode : "longest_edge_m";
  if (sz.mode !== undefined && !SIZING_MODES.includes(sz.mode)) {
    errors.push(`Object "${o.name}": unknown sizing mode "${sz.mode}".`);
  }
  o.sizing.value = clampNum(sz.value, 1, 1e-6, 100000, errors, `Sizing of "${o.name}"`);

  o.position_frac = vec3(raw.position_frac, [0.5, 0.4, 0.5], errors, `Position of "${o.name}"`);
  for (let i = 0; i < 3; i++) o.position_frac[i] = Math.min(1.5, Math.max(-0.5, o.position_frac[i]));

  const rot = isObject(raw.rotation_deg) ? raw.rotation_deg : {};
  for (const k of ["pitch", "yaw", "roll"]) {
    o.rotation_deg[k] = clampNum(rot[k], 0, -360, 360, errors, `Angle of "${o.name}"`);
  }

  const mo = isObject(raw.motion) ? raw.motion : {};
  o.motion.type = MOTION_TYPES.includes(mo.type) ? mo.type : "none";
  if (mo.type !== undefined && !MOTION_TYPES.includes(mo.type)) {
    errors.push(`Object "${o.name}": unknown motion type "${mo.type}".`);
  }
  o.motion.axis = vec3(mo.axis, [0, 1, 0], errors, `Rotation axis of "${o.name}"`);
  const len = Math.hypot(o.motion.axis[0], o.motion.axis[1], o.motion.axis[2]);
  if (len < 1e-9) {
    if (o.motion.type === "rotate") errors.push(`Object "${o.name}": the rotation axis is a zero vector.`);
    o.motion.axis = [0, 1, 0];
  } else {
    o.motion.axis = o.motion.axis.map(v => round(v / len, 6));
  }
  o.motion.rpm = clampNum(mo.rpm, 0, -100000, 100000, errors, `Speed (rpm) of "${o.name}"`);
  o.motion.revoxelize_interval = Math.round(
    clampNum(mo.revoxelize_interval, 4, 1, 1024, errors, `Revoxelization interval of "${o.name}"`)
  );

  o.sealing = validateSealing(isObject(raw.sealing) ? raw.sealing : {}, o.name, errors);

  /**
   * Legacy setups point `file` at a precomputed `-sealed.stl` and keep the
   * original in `source_file`. That geometry was baked at one cell size; the
   * solver now seals at runtime, so the original is what should be loaded and
   * shown. Restore it and drop the detour.
   */
  const source = dataPath(raw.source_file);
  if (source === "") {
    errors.push(`Object "${o.name}": the path of the original file is not allowed.`);
  } else if (source) {
    o.file = source;
  }
  return o;
}

/** Sealing block, CONTRACT.md section 8. Mirrors `validateSealing` on the server. */
function validateSealing(raw, name, errors) {
  const s = defaultSealing();

  if (raw.mode !== undefined && raw.mode !== null) {
    if (SEALING_MODES.includes(raw.mode)) s.mode = raw.mode;
    else errors.push(`Object "${name}": unknown sealing mode "${raw.mode}".`);
  }

  const holes = SEALING_LIMITS.close_holes;
  const thick = SEALING_LIMITS.min_thickness;
  s.close_holes = Math.round(clampNum(
    raw.close_holes, s.close_holes, holes.min, holes.max, errors, `Hole closing of "${name}"`));
  s.min_thickness = Math.round(clampNum(
    raw.min_thickness, s.min_thickness, thick.min, thick.max, errors, `Minimum wall thickness of "${name}"`));

  /**
   * `sealed_file` and everything around it comes from the earlier design, where
   * the server precomputed a second STL. That file was frozen at one cell size,
   * so raising the VRAM target gave the solver *coarser* geometry than the
   * original. Sealing now happens inside the solver on the grid of the actual
   * run, and these fields are deliberately dropped on load — an old setup keeps
   * its method and its two radii, but goes back to running from the source file.
   */
  s.sealed_file = null;
  s.cell_m = null;
  s.computed_at = null;
  s.stats = null;
  return s;
}

/** Counters of the sealing run; unknown keys are dropped, missing ones stay out. */
function sealingStats(raw) {
  const out = {};
  for (const key of ["trianglesIn", "trianglesOut", "cells", "solidCells",
                     "shellCells", "filledCells", "thinFaces",
                     "lostCells", "lostFraction", "raycastCells"]) {
    const n = num(raw[key]);
    if (n !== null && n >= 0) out[key] = Math.round(n);
  }
  if (Array.isArray(raw.grid) && raw.grid.length === 3) {
    const grid = raw.grid.map(v => num(v));
    if (grid.every(v => v !== null && v > 0)) out.grid = grid.map(v => Math.round(v));
  }
  if (raw.closed !== undefined) out.closed = !!raw.closed;
  const seconds = num(raw.seconds);
  if (seconds !== null && seconds >= 0) out.seconds = seconds;
  return out;
}

/**
 * A path below `data/`: normalised, or `null` when absent and `""` when it is
 * present but unusable — the caller decides what to report.
 */
function dataPath(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return "";
  const p = v.replace(/\\/g, "/").trim();
  if (!p || p.includes("..") || p.startsWith("/")) return "";
  return p;
}

const isObject = v => !!v && typeof v === "object" && !Array.isArray(v);

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clampNum(v, fallback, min, max, errors, label) {
  if (v === undefined || v === null) return fallback;
  const n = num(v);
  if (n === null) {
    errors.push(`${label}: "${v}" is not a number.`);
    return fallback;
  }
  if (n < min || n > max) {
    errors.push(`${label}: ${n} is outside ${min} … ${max}.`);
    return Math.min(max, Math.max(min, n));
  }
  return n;
}

function vec3(v, fallback, errors, label) {
  if (v === undefined || v === null) return fallback.slice();
  if (!Array.isArray(v) || v.length !== 3) {
    errors.push(`${label}: three numbers expected.`);
    return fallback.slice();
  }
  const out = [];
  for (let i = 0; i < 3; i++) {
    const n = num(v[i]);
    if (n === null) {
      errors.push(`${label}: component ${i + 1} is not a number.`);
      out.push(fallback[i]);
    } else out.push(n);
  }
  return out;
}

function colour(v, fallback, errors) {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim();
  if (/^0x[0-9A-Fa-f]{6}$/.test(s)) return "0x" + s.slice(2).toUpperCase();
  if (/^#[0-9A-Fa-f]{6}$/.test(s)) return "0x" + s.slice(1).toUpperCase();
  errors.push(`Invalid background colour "${v}"; expected 0xRRGGBB.`);
  return fallback;
}

/** File-system safe setup name; the server stores it as `<name>.json`. */
export function cleanName(v, fallback = "setup") {
  const s = typeof v === "string" ? v.trim() : "";
  const safe = s.replace(/[^A-Za-z0-9_.\- \u00E4\u00F6\u00FC\u00C4\u00D6\u00DC\u00DF]/g, "").replace(/\s+/g, "_").replace(/^\.+/, "");
  return safe || fallback;
}

function prettyName(file) {
  const base = String(file).split(/[\\/]/).pop() || "Object";
  return base.replace(/\.stl$/i, "") || "Object";
}

const round = (v, d) => {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
};
