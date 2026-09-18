/**
 * Server-side schema for setup configs (CONTRACT.md section 1, schema version 1).
 *
 * `validate()` never throws and never rejects a config outright: missing fields
 * are filled from the defaults, out-of-range numbers are clamped, and unknown
 * fields are carried through untouched so that configs written by a newer
 * frontend survive a round-trip. Everything that could not be repaired is
 * reported in `errors` (user-facing messages) and flips `ok` to false.
 */

export const SCHEMA_VERSION = 1;

/** Setup names double as file names below data/setups. */
export const SETUP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const VELOCITY_SETS = [15, 19, 27];
export const PRECISIONS = ["FP32", "FP16S", "FP16C"];
export const BOUNDARY_TYPES = ["equilibrium", "solid", "periodic", "open"];
export const BOUNDARY_FACES = ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax"];
export const VISUALIZATION_MODES = ["solid", "flags", "field", "streamlines", "q_criterion"];
export const OBJECT_TYPES = ["stl"];
export const SIZING_MODES = ["longest_edge_m", "scale"];
export const MOTION_TYPES = ["none", "rotate"];
export const SEALING_MODES = ["off", "shell", "fill"];
export const RUN_MODES = ["interactive", "render"];
export const CAMERA_TYPES = ["orbit", "fixed"];

/**
 * Canonical order of the solver extensions. Normalisation sorts by this list so
 * that the rebuild hash does not depend on the order the frontend sent.
 */
export const EXTENSIONS = [
  "VOLUME_FORCE",
  "FORCE_FIELD",
  "MOVING_BOUNDARIES",
  "EQUILIBRIUM_BOUNDARIES",
  "SUBGRID",
  "SURFACE",
  "TEMPERATURE",
  "PARTICLES",
  "TRT"
];

export const LIMITS = {
  domainSizeM: { min: 0.01, max: 100000 },
  vramMB: { min: 100, max: 64000 },
  velocityMs: { min: 0.001, max: 10000 },
  uLbm: { min: 0.001, max: 0.5 },
  fps: { min: 1, max: 240 },
  closeHoles: { min: 0, max: 3 },
  minThickness: { min: 1, max: 5 }
};

/** Replaces everything a setup file name may not contain. */
export function sanitizeName(name) {
  const raw = typeof name === "string" ? name.trim() : "";
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "new_setup";
}

/**
 * Sealing defaults for an object (CONTRACT.md section 8). Sealing is off until
 * the user asks for it; everything the server computes is filled in afterwards.
 */
export function defaultSealing() {
  return {
    mode: "off",
    close_holes: 1,
    min_thickness: 1
  };
}

/** A complete config with sensible starting values (wind tunnel sized for a 25 m sailplane). */
export function defaultConfig(name) {
  return {
    schema: SCHEMA_VERSION,
    name: sanitizeName(name),

    domain: {
      size_m: [36.0, 60.0, 18.0],
      target_vram_mb: 10000
    },

    fluid: {
      velocity_ms: 30.0,
      azimuth_deg: 0.0,
      elevation_deg: 0.0,
      density_kgm3: 1.225,
      viscosity_m2s: 1.48e-5, // air at 15 °C
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
      extensions: ["EQUILIBRIUM_BOUNDARIES", "SUBGRID"] // canonical EXTENSIONS order
    },

    run: {
      mode: "interactive",
      duration_s: 4.0,
      fps: 60,
      camera: {
        type: "orbit",
        azimuth_from_deg: -70.0,
        azimuth_to_deg: 70.0,
        elevation_deg: 20.0,
        distance: 60.0,
        zoom: 1.3
      }
    }
  };
}

/**
 * Validates and normalises a config.
 * @returns {{ ok: boolean, errors: string[], value: object }}
 */
export function validate(cfg) {
  const errors = [];
  const src = isObject(cfg) ? cfg : {};
  if (!isObject(cfg)) {
    errors.push("The configuration must be a JSON object.");
  }

  const name = sanitizeName(src.name);
  if (typeof src.name === "string" && src.name.trim() !== "" && !SETUP_NAME_RE.test(src.name.trim())) {
    errors.push(
      `name: "${src.name}" contains invalid characters. Allowed are letters, digits, ` +
      `underscore and hyphen (1 to 64 characters). Using "${name}" instead.`
    );
  }

  const def = defaultConfig(name);
  const value = { ...src }; // unknown top-level fields survive
  value.name = name;
  value.schema = SCHEMA_VERSION;

  if (src.schema !== undefined && Number(src.schema) !== SCHEMA_VERSION) {
    errors.push(`schema: version ${show(src.schema)} is not supported; expected ${SCHEMA_VERSION}.`);
  }

  value.domain = validateDomain(section(src, "domain"), def.domain, errors);
  value.fluid = validateFluid(section(src, "fluid"), def.fluid, errors);
  value.boundaries = validateBoundaries(section(src, "boundaries"), def.boundaries, errors);
  value.objects = validateObjects(src.objects, errors);
  value.reference = validateReference(section(src, "reference"), def.reference, value.objects, errors);
  value.visualization = validateVisualization(section(src, "visualization"), def.visualization, errors);
  value.solver = validateSolver(section(src, "solver"), def.solver, errors);
  value.run = validateRun(section(src, "run"), def.run, errors);

  checkExtensionConsistency(value, errors);

  return { ok: errors.length === 0, errors, value };
}

/* ------------------------------------------------------------------ */
/* sections                                                            */
/* ------------------------------------------------------------------ */

function validateDomain(raw, def, errors) {
  const out = { ...raw };
  out.size_m = vec3(errors, "domain.size_m", raw.size_m, def.size_m, {
    min: LIMITS.domainSizeM.min,
    max: LIMITS.domainSizeM.max
  });
  out.target_vram_mb = num(errors, "domain.target_vram_mb", raw.target_vram_mb, def.target_vram_mb, {
    min: LIMITS.vramMB.min,
    max: LIMITS.vramMB.max,
    integer: true
  });
  return out;
}

function validateFluid(raw, def, errors) {
  const out = { ...raw };
  out.velocity_ms = num(errors, "fluid.velocity_ms", raw.velocity_ms, def.velocity_ms, {
    min: LIMITS.velocityMs.min,
    max: LIMITS.velocityMs.max
  });
  out.azimuth_deg = num(errors, "fluid.azimuth_deg", raw.azimuth_deg, def.azimuth_deg, { min: -360, max: 360 });
  out.elevation_deg = num(errors, "fluid.elevation_deg", raw.elevation_deg, def.elevation_deg, { min: -90, max: 90 });
  out.density_kgm3 = num(errors, "fluid.density_kgm3", raw.density_kgm3, def.density_kgm3, { min: 1e-6, max: 100000 });
  out.viscosity_m2s = num(errors, "fluid.viscosity_m2s", raw.viscosity_m2s, def.viscosity_m2s, { min: 1e-12, max: 1 });
  out.u_lbm = num(errors, "fluid.u_lbm", raw.u_lbm, def.u_lbm, {
    min: LIMITS.uLbm.min,
    max: LIMITS.uLbm.max
  });
  return out;
}

function validateBoundaries(raw, def, errors) {
  const out = { ...raw };
  for (const face of BOUNDARY_FACES) {
    out[face] = enumValue(errors, `boundaries.${face}`, raw[face], BOUNDARY_TYPES, def[face], "the boundary type");
  }
  // A periodic face only works together with its opposite face.
  for (const [a, b] of [["xmin", "xmax"], ["ymin", "ymax"], ["zmin", "zmax"]]) {
    const periodicA = out[a] === "periodic";
    const periodicB = out[b] === "periodic";
    if (periodicA !== periodicB) {
      errors.push(
        `boundaries: "periodic" must always be set on both opposite faces; ` +
        `${a} is "${out[a]}", ${b} is "${out[b]}".`
      );
    }
  }
  return out;
}

function validateObjects(raw, errors) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`objects: must be a list (got ${show(raw)}).`);
    return [];
  }
  const seen = new Set();
  return raw.map((item, i) => validateObject(item, i, seen, errors));
}

function validateObject(raw, index, seen, errors) {
  const p = `objects[${index}]`;
  if (!isObject(raw)) {
    errors.push(`${p}: must be an object (got ${show(raw)}).`);
    raw = {};
  }
  const out = { ...raw };

  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (id === "") id = `obj-${index + 1}`;
  if (seen.has(id)) {
    errors.push(`${p}.id: the id "${id}" is used more than once. Every object id must be unique.`);
    id = `${id}-${index + 1}`;
  }
  seen.add(id);
  out.id = id;

  out.name = typeof raw.name === "string" && raw.name.trim() !== ""
    ? raw.name.trim().slice(0, 120)
    : `Object ${index + 1}`;

  out.type = enumValue(errors, `${p}.type`, raw.type, OBJECT_TYPES, "stl", "the object type");

  out.file = validateDataPath(errors, `${p}.file`, raw.file);
  out.enabled = bool(raw.enabled, true);
  out.visible = bool(raw.visible, true);

  const sizingRaw = isObject(raw.sizing) ? raw.sizing : {};
  const sizing = { ...sizingRaw };
  sizing.mode = enumValue(errors, `${p}.sizing.mode`, sizingRaw.mode, SIZING_MODES, "longest_edge_m", "the sizing mode");
  sizing.value = num(errors, `${p}.sizing.value`, sizingRaw.value, 1.0, { min: 1e-6, max: 100000 });
  out.sizing = sizing;

  out.position_frac = vec3(errors, `${p}.position_frac`, raw.position_frac, [0.5, 0.5, 0.5], {
    min: -10,
    max: 10
  });

  const rotRaw = isObject(raw.rotation_deg) ? raw.rotation_deg : {};
  const rotation = { ...rotRaw };
  for (const axis of ["pitch", "yaw", "roll"]) {
    rotation[axis] = num(errors, `${p}.rotation_deg.${axis}`, rotRaw[axis], 0, { min: -3600, max: 3600 });
  }
  out.rotation_deg = rotation;

  out.motion = validateMotion(isObject(raw.motion) ? raw.motion : {}, `${p}.motion`, errors);
  out.sealing = validateSealing(isObject(raw.sealing) ? raw.sealing : {}, `${p}.sealing`, errors);
  return out;
}

/**
 * Sealing block (CONTRACT.md section 8) — parameters only.
 *
 * The solver seals at startup on the grid of the run, so there is no stored
 * result. Setups written by the earlier design still carry `cell_m`,
 * `sealed_file`, `computed_at` and `stats`; those are dropped here rather than
 * validated, so an old file loads without complaint and simply runs the new way.
 */
function validateSealing(raw, p, errors) {
  const def = defaultSealing();
  const out = {};

  out.mode = enumValue(errors, `${p}.mode`, raw.mode, SEALING_MODES, def.mode, "the sealing mode");
  out.close_holes = num(errors, `${p}.close_holes`, raw.close_holes, def.close_holes, {
    min: LIMITS.closeHoles.min,
    max: LIMITS.closeHoles.max,
    integer: true
  });
  out.min_thickness = num(errors, `${p}.min_thickness`, raw.min_thickness, def.min_thickness, {
    min: LIMITS.minThickness.min,
    max: LIMITS.minThickness.max,
    integer: true
  });

  return out;
}

function validateMotion(raw, p, errors) {
  const out = { ...raw };
  out.type = enumValue(errors, `${p}.type`, raw.type, MOTION_TYPES, "none", "the motion type");

  const axis = vec3(errors, `${p}.axis`, raw.axis, [0, 1, 0], { min: -1e6, max: 1e6 });
  const len = Math.hypot(axis[0], axis[1], axis[2]);
  if (len < 1e-9) {
    if (out.type === "rotate") {
      errors.push(`${p}.axis: the rotation axis must not be the zero vector.`);
    }
    out.axis = [0, 1, 0];
  } else {
    // The solver expects a unit vector, so normalise here instead of there.
    out.axis = [axis[0] / len, axis[1] / len, axis[2] / len];
  }

  out.rpm = num(errors, `${p}.rpm`, raw.rpm, 0, { min: -1e6, max: 1e6 });
  out.revoxelize_interval = num(errors, `${p}.revoxelize_interval`, raw.revoxelize_interval, 4, {
    min: 1,
    max: 100000,
    integer: true
  });
  return out;
}

function validateReference(raw, def, objects, errors) {
  const out = { ...raw };
  out.length_m = num(errors, "reference.length_m", raw.length_m, def.length_m, { min: 1e-6, max: 100000 });

  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  if (source === "" || source === "manual") {
    out.source = "manual";
  } else if (source.startsWith("object:")) {
    const id = source.slice("object:".length);
    if (!objects.some((o) => o.id === id)) {
      errors.push(`reference.source: there is no object with the id "${id}". The reference length falls back to "manual".`);
      out.source = "manual";
    } else {
      out.source = source;
    }
  } else {
    errors.push(`reference.source: must be "manual" or "object:<id>" (got ${show(raw.source)}).`);
    out.source = "manual";
  }
  return out;
}

function validateVisualization(raw, def, errors) {
  const out = { ...raw };

  let modes = def.modes.slice();
  if (raw.modes !== undefined && raw.modes !== null) {
    if (!Array.isArray(raw.modes)) {
      errors.push(`visualization.modes: must be a list (got ${show(raw.modes)}).`);
    } else {
      const picked = [];
      for (const m of raw.modes) {
        const match = matchCaseInsensitive(m, VISUALIZATION_MODES);
        if (match === null) {
          errors.push(
            `visualization.modes: ${show(m)} is not a valid visualization mode. ` +
            `Allowed: ${VISUALIZATION_MODES.join(", ")}.`
          );
        } else if (!picked.includes(match)) {
          picked.push(match);
        }
      }
      modes = picked;
    }
  }
  out.modes = modes;

  out.q_criterion = num(errors, "visualization.q_criterion", raw.q_criterion, def.q_criterion, { min: 0, max: 1000 });
  out.u_max = num(errors, "visualization.u_max", raw.u_max, def.u_max, { min: 1e-6, max: 1000 });
  out.background = validateColor(errors, "visualization.background", raw.background, def.background);
  return out;
}

function validateSolver(raw, def, errors) {
  const out = { ...raw };

  const vs = num(errors, "solver.velocity_set", raw.velocity_set, def.velocity_set, { min: 15, max: 27, integer: true });
  if (!VELOCITY_SETS.includes(vs)) {
    errors.push(`solver.velocity_set: must be 15, 19 or 27 (got ${show(raw.velocity_set)}).`);
    out.velocity_set = def.velocity_set;
  } else {
    out.velocity_set = vs;
  }

  out.precision = enumValue(errors, "solver.precision", raw.precision, PRECISIONS, def.precision, "the precision");
  out.extensions = validateExtensions(raw.extensions, def.extensions, errors);
  return out;
}

function validateExtensions(raw, def, errors) {
  if (raw === undefined || raw === null) return def.slice();
  if (!Array.isArray(raw)) {
    errors.push(`solver.extensions: must be a list (got ${show(raw)}).`);
    return def.slice();
  }
  const picked = new Set();
  for (const e of raw) {
    const match = matchCaseInsensitive(e, EXTENSIONS);
    if (match === null) {
      errors.push(
        `solver.extensions: ${show(e)} is not a known extension. Allowed: ${EXTENSIONS.join(", ")}.`
      );
    } else {
      picked.add(match);
    }
  }
  // Canonical order keeps the rebuild hash independent of the input order.
  return EXTENSIONS.filter((e) => picked.has(e));
}

function validateRun(raw, def, errors) {
  const out = { ...raw };
  out.mode = enumValue(errors, "run.mode", raw.mode, RUN_MODES, def.mode, "the run mode");
  out.duration_s = num(errors, "run.duration_s", raw.duration_s, def.duration_s, { min: 1e-4, max: 100000 });
  out.fps = num(errors, "run.fps", raw.fps, def.fps, { min: LIMITS.fps.min, max: LIMITS.fps.max, integer: true });

  const camRaw = isObject(raw.camera) ? raw.camera : {};
  const cam = { ...camRaw };
  cam.type = enumValue(errors, "run.camera.type", camRaw.type, CAMERA_TYPES, def.camera.type, "the camera type");
  cam.azimuth_from_deg = num(errors, "run.camera.azimuth_from_deg", camRaw.azimuth_from_deg, def.camera.azimuth_from_deg, { min: -3600, max: 3600 });
  cam.azimuth_to_deg = num(errors, "run.camera.azimuth_to_deg", camRaw.azimuth_to_deg, def.camera.azimuth_to_deg, { min: -3600, max: 3600 });
  cam.elevation_deg = num(errors, "run.camera.elevation_deg", camRaw.elevation_deg, def.camera.elevation_deg, { min: -89.9, max: 89.9 });
  cam.distance = num(errors, "run.camera.distance", camRaw.distance, def.camera.distance, { min: 1e-3, max: 1e6 });
  cam.zoom = num(errors, "run.camera.zoom", camRaw.zoom, def.camera.zoom, { min: 1e-3, max: 1000 });
  out.camera = cam;
  return out;
}

/** Cross-checks between objects and the enabled solver extensions. */
function checkExtensionConsistency(value, errors) {
  const ext = value.solver.extensions;
  const rotating = value.objects.filter((o) => o.enabled && o.motion && o.motion.type === "rotate");

  if (rotating.length > 0 && !ext.includes("MOVING_BOUNDARIES")) {
    const names = rotating.map((o) => `"${o.name}"`).join(", ");
    errors.push(
      `solver.extensions: ${names} ${rotating.length === 1 ? "rotates" : "rotate"} ` +
      `(motion.type = "rotate"). FluidX3D only simulates rotating bodies with the ` +
      `MOVING_BOUNDARIES extension; enable MOVING_BOUNDARIES or set the motion to "none".`
    );
  }

  if (ext.includes("PARTICLES")) {
    const missing = ["VOLUME_FORCE", "FORCE_FIELD"].filter((e) => !ext.includes(e));
    if (missing.length > 0) {
      errors.push(
        `solver.extensions: PARTICLES also requires VOLUME_FORCE and FORCE_FIELD ` +
        `(missing: ${missing.join(", ")}). Enable the missing extensions or deselect PARTICLES.`
      );
    }
  }

  if (ext.includes("FORCE_FIELD") && !ext.includes("VOLUME_FORCE")) {
    errors.push("solver.extensions: FORCE_FIELD only works together with VOLUME_FORCE.");
  }
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Shallow copy of a config section, so unknown keys inside it are preserved. */
function section(src, key) {
  return isObject(src[key]) ? { ...src[key] } : {};
}

function bool(raw, fallback) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  return fallback;
}

function toNumber(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw.trim());
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Reads a number, filling in the default when absent and clamping when out of
 * range. Anything that is neither absent nor a finite number is an error.
 */
function num(errors, path, raw, fallback, opts = {}) {
  const { min = -Infinity, max = Infinity, integer = false } = opts;
  if (raw === undefined || raw === null || raw === "") return fallback;

  const parsed = toNumber(raw);
  if (Number.isNaN(parsed)) {
    errors.push(`${path}: must be a finite number (got ${show(raw)}).`);
    return fallback;
  }

  let v = integer ? Math.round(parsed) : parsed;
  if (v < min || v > max) {
    errors.push(`${path}: ${rangeText(min, max, integer)} (got ${formatNumber(parsed)}).`);
    v = Math.min(max, Math.max(min, v));
  }
  return v;
}

function vec3(errors, path, raw, fallback, opts = {}) {
  if (raw === undefined || raw === null) return fallback.slice();
  if (!Array.isArray(raw) || raw.length !== 3) {
    errors.push(`${path}: must be a list of exactly 3 numbers (got ${show(raw)}).`);
    return fallback.slice();
  }
  return [0, 1, 2].map((i) => num(errors, `${path}[${i}]`, raw[i], fallback[i], opts));
}

function matchCaseInsensitive(raw, allowed) {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  if (key === "") return null;
  const hit = allowed.find((a) => a.toLowerCase() === key);
  return hit === undefined ? null : hit;
}

function enumValue(errors, path, raw, allowed, fallback, label) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const match = matchCaseInsensitive(raw, allowed);
  if (match === null) {
    errors.push(`${path}: ${show(raw)} is not a valid value for ${label}. Allowed: ${allowed.join(", ")}.`);
    return fallback;
  }
  return match;
}

/** Accepts "0xRRGGBB" and "#RRGGBB" and always returns the "0x" form. */
function validateColor(errors, path, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const clamped = Math.min(0xffffff, Math.max(0, Math.round(raw)));
    return "0x" + clamped.toString(16).toUpperCase().padStart(6, "0");
  }
  if (typeof raw === "string") {
    const m = raw.trim().match(/^(?:0x|#)?([0-9A-Fa-f]{6})$/);
    if (m) return "0x" + m[1].toUpperCase();
  }
  errors.push(`${path}: must be a color in the format 0xRRGGBB (got ${show(raw)}).`);
  return fallback;
}

/** File references are relative to data/ and must not escape it. */
function validateDataPath(errors, path, raw) {
  if (raw === undefined || raw === null || raw === "") {
    errors.push(`${path}: no file is given.`);
    return "";
  }
  if (typeof raw !== "string") {
    errors.push(`${path}: must be a file path relative to data/ (got ${show(raw)}).`);
    return "";
  }
  const rel = raw.trim().replace(/\\/g, "/");
  const unsafe =
    rel.startsWith("/") ||
    /^[A-Za-z]:/.test(rel) ||
    rel.split("/").some((part) => part === "..");
  if (unsafe) {
    errors.push(`${path}: "${raw}" points outside the data folder. Only relative paths such as "uploads/model.stl" are allowed.`);
    return "";
  }
  return rel;
}

function rangeText(min, max, integer) {
  const kind = integer ? "an integer" : "a number";
  if (min > -Infinity && max < Infinity) {
    return `must be ${kind} between ${formatNumber(min)} and ${formatNumber(max)}`;
  }
  if (min > -Infinity) return `must be ${kind} >= ${formatNumber(min)}`;
  return `must be ${kind} <= ${formatNumber(max)}`;
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n !== 0 && (Math.abs(n) < 1e-4 || Math.abs(n) >= 1e6)) return n.toExponential(2);
  return String(Math.round(n * 1e6) / 1e6);
}

function show(v) {
  if (typeof v === "string") return `"${v.length > 60 ? v.slice(0, 60) + "…" : v}"`;
  if (v === null) return "null";
  if (v === undefined) return "nothing";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "an object";
  return String(v);
}
