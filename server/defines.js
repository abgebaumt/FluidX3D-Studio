/**
 * Generation of <fluidx3d>/src/defines.hpp from a setup config.
 *
 * The template next to this file is a verbatim copy of FluidX3D's own
 * defines.hpp; only the lines the editor controls are replaced by
 * {{PLACEHOLDER}} markers. Everything else is passed through untouched so an
 * upstream update can be adopted by copying the file and re-marking it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_FILE = path.join(here, "defines.template.hpp");
const BUILT_FILE = "built.json";

/** Velocity sets in the order and wording of the original file. */
const VELOCITY_SETS = [
  [9, "D2Q9", "choose D2Q9 velocity set for 2D; allocates 53 (FP32) or 35 (FP16) Bytes/cell"],
  [15, "D3Q15", "choose D3Q15 velocity set for 3D; allocates 77 (FP32) or 47 (FP16) Bytes/cell"],
  [19, "D3Q19", "choose D3Q19 velocity set for 3D; allocates 93 (FP32) or 55 (FP16) Bytes/cell; (default)"],
  [27, "D3Q27", "choose D3Q27 velocity set for 3D; allocates 125 (FP32) or 71 (FP16) Bytes/cell"]
];

const PRECISIONS = [
  ["FP16S", "optional for 2x speedup and 2x VRAM footprint reduction: compress LBM DDFs to range-shifted IEEE-754 FP16; number conversion is done in hardware; all arithmetic is still done in FP32"],
  ["FP16C", "optional for 2x speedup and 2x VRAM footprint reduction: compress LBM DDFs to more accurate custom FP16C format; number conversion is emulated in software; all arithmetic is still done in FP32"]
];

/**
 * The collision operator. FluidX3D spells SRT and TRT like extensions, but
 * they are mutually exclusive, so they get their own block: only "TRT" may be
 * listed in solver.extensions, and SRT stays on whenever it is absent.
 */
const COLLISION_OPERATORS = [
  ["SRT", "choose single-relaxation-time LBM collision operator; (default)"],
  ["TRT", "choose two-relaxation-time LBM collision operator"]
];
const TRT = "TRT";

/** Every extension the editor may switch, in the original file's order. */
export const EXTENSIONS = [
  ["VOLUME_FORCE", "enables global force per volume in one direction (equivalent to a pressure gradient); specified in the LBM class constructor; the force can be changed on-the-fly between time steps at no performance cost"],
  ["FORCE_FIELD", "enables computing the forces on solid boundaries with lbm.update_force_field(); and enables setting the force for each lattice point independently (enable VOLUME_FORCE too); allocates an extra 12 Bytes/cell"],
  ["EQUILIBRIUM_BOUNDARIES", "enables fixing the velocity/density by marking cells with TYPE_E; can be used for inflow/outflow; does not reflect shock waves"],
  ["MOVING_BOUNDARIES", "enables moving solids: set solid cells to TYPE_S and set their velocity u unequal to zero"],
  ["SURFACE", "enables free surface LBM: mark fluid cells with TYPE_F; at initialization the TYPE_I interface and TYPE_G gas domains will automatically be completed; allocates an extra 12 Bytes/cell"],
  ["TEMPERATURE", "enables temperature extension; set fixed-temperature cells with TYPE_T (similar to EQUILIBRIUM_BOUNDARIES); allocates an extra 32 (FP32) or 18 (FP16) Bytes/cell"],
  ["SUBGRID", "enables Smagorinsky-Lilly subgrid turbulence LES model to keep simulations with very large Reynolds number stable"],
  ["PARTICLES", "enables particles with immersed-boundary method (for 2-way coupling also activate VOLUME_FORCE and FORCE_FIELD; only supported in single-GPU)"]
];

const GRAPHICS_MODES = [
  ["INTERACTIVE_GRAPHICS", "enable interactive graphics; start/pause the simulation by pressing P; either Windows or Linux X11 desktop must be available; on Linux: change to \"compile on Linux with X11\" command in make.sh"],
  ["INTERACTIVE_GRAPHICS_ASCII", "enable interactive graphics in ASCII mode the console; start/pause the simulation by pressing P"],
  ["GRAPHICS", "run FluidX3D in the console, but still enable graphics functionality for writing rendered frames to the hard drive"]
];

/** Labels for the run modes, used in rebuild explanations. */
const MODE_LABELS = { interactive: "interactive", render: "render" };

let templateCache = null;

function template() {
  if (templateCache === null) {
    templateCache = fs.readFileSync(TEMPLATE_FILE, "utf8");
  }
  return templateCache;
}

function line(active, name, comment, value = "") {
  const body = `#define ${name}${value ? " " + value : ""} // ${comment}`;
  return active ? body : "//" + body;
}

/**
 * Normalises the extension list to unique, upper-case, known names.
 * The collision operator travels in the same list, so that selecting TRT
 * reaches defines.hpp and shows up in the rebuild hash like everything else.
 */
function extensionsOf(cfg) {
  const known = new Set([...EXTENSIONS.map(([name]) => name), TRT]);
  const raw = Array.isArray(cfg?.solver?.extensions) ? cfg.solver.extensions : [];
  const out = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim().toUpperCase();
    if (known.has(name)) out.add(name);
  }
  return [...out].sort();
}

function velocitySetOf(cfg) {
  const n = Number(cfg?.solver?.velocity_set);
  return VELOCITY_SETS.some(([value]) => value === n) ? n : 19;
}

function precisionOf(cfg) {
  const p = String(cfg?.solver?.precision || "FP16S").toUpperCase();
  return p === "FP32" || p === "FP16C" ? p : "FP16S";
}

function modeOf(cfg) {
  return cfg?.run?.mode === "render" ? "render" : "interactive";
}

/** Accepts "0xCCE4FF", "#CCE4FF", "CCE4FF" or a number and returns "0xRRGGBB". */
function colorOf(value, fallback = 0xcce4ff) {
  let n = fallback;
  if (typeof value === "number" && Number.isFinite(value)) {
    n = Math.trunc(value);
  } else if (typeof value === "string") {
    const parsed = parseInt(value.trim().replace(/^#/, "").replace(/^0x/i, ""), 16);
    if (Number.isFinite(parsed)) n = parsed;
  }
  n = Math.min(0xffffff, Math.max(0, n));
  return "0x" + n.toString(16).toUpperCase().padStart(6, "0");
}

/** Formats a number as an OpenCL/C++ float literal, always with a decimal point. */
function floatLiteral(value, fallback) {
  const n = Number.isFinite(Number(value)) ? Number(value) : fallback;
  let text = String(n);
  if (/e/i.test(text)) text = n.toFixed(12).replace(/0+$/, "");
  if (!text.includes(".")) text += ".0";
  return text + "f";
}

/** Renders the complete defines.hpp text for a config. Never throws on gaps. */
export function renderDefines(cfg) {
  const set = velocitySetOf(cfg);
  const precision = precisionOf(cfg);
  const mode = modeOf(cfg);
  const active = new Set(extensionsOf(cfg));
  const vis = cfg?.visualization || {};

  const replacements = {
    VELOCITY_SET: VELOCITY_SETS.map(([value, name, comment]) => line(value === set, name, comment)).join("\n"),
    PRECISION: PRECISIONS.map(([name, comment]) => line(name === precision, name, comment)).join("\n"),
    COLLISION: COLLISION_OPERATORS.map(([name, comment]) =>
      line(name === (active.has(TRT) ? TRT : "SRT"), name, comment)
    ).join("\n"),
    EXTENSIONS: EXTENSIONS.map(([name, comment]) => line(active.has(name), name, comment)).join("\n"),
    GRAPHICS_MODE: GRAPHICS_MODES.map(([name, comment]) =>
      line(name === (mode === "render" ? "GRAPHICS" : "INTERACTIVE_GRAPHICS"), name, comment)
    ).join("\n"),
    GRAPHICS_BACKGROUND_COLOR: line(
      true,
      "GRAPHICS_BACKGROUND_COLOR",
      "set background color; black background (default) = 0x000000, white background = 0xFFFFFF",
      colorOf(vis.background)
    ),
    GRAPHICS_U_MAX: line(
      true,
      "GRAPHICS_U_MAX",
      "maximum velocity for velocity coloring in units of LBM lattice speed of sound (c=1/sqrt(3)) (default: 0.18f)",
      floatLiteral(vis.u_max, 0.18)
    ),
    GRAPHICS_Q_CRITERION: line(
      true,
      "GRAPHICS_Q_CRITERION",
      "Q-criterion value for Q-criterion isosurface visualization",
      floatLiteral(vis.q_criterion, 0.0008)
    )
  };

  let text = template();
  for (const [key, value] of Object.entries(replacements)) {
    text = text.split(`{{${key}}}`).join(value);
  }
  return text;
}

/** The subset of the config that decides whether the binary must be rebuilt. */
function buildKey(cfg) {
  return {
    velocity_set: velocitySetOf(cfg),
    precision: precisionOf(cfg),
    extensions: extensionsOf(cfg),
    mode: modeOf(cfg)
  };
}

/** sha1 over velocity set, precision, sorted extensions and run mode. */
export function buildHash(cfg) {
  return crypto.createHash("sha1").update(JSON.stringify(buildKey(cfg))).digest("hex");
}

/** Reads data/generated/built.json; returns null when absent or damaged. */
export function readBuiltState(generatedDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(generatedDir, BUILT_FILE), "utf8"));
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

/** Records the configuration the current binary was built from. */
export function writeBuiltState(cfg, generatedDir, extra = {}) {
  const state = { ...buildKey(cfg), hash: buildHash(cfg), builtAt: new Date().toISOString(), ...extra };
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.writeFileSync(path.join(generatedDir, BUILT_FILE), JSON.stringify(state, null, 2), "utf8");
  return state;
}

/** Drops the recorded build state, e.g. after a failed build. */
export function clearBuiltState(generatedDir) {
  try {
    fs.rmSync(path.join(generatedDir, BUILT_FILE), { force: true });
  } catch {
    /* nothing to clear */
  }
}

function setName(value) {
  const entry = VELOCITY_SETS.find(([n]) => n === Number(value));
  return entry ? entry[1] : String(value);
}

function describeChanges(previous, next) {
  const reasons = [];
  if (previous.velocity_set !== next.velocity_set) {
    reasons.push(`velocity set ${setName(previous.velocity_set)} → ${setName(next.velocity_set)}`);
  }
  if (previous.precision !== next.precision) {
    reasons.push(`precision ${previous.precision} → ${next.precision}`);
  }
  const before = new Set(previous.extensions || []);
  const after = new Set(next.extensions);
  for (const name of next.extensions) {
    if (!before.has(name)) reasons.push(`${name} added`);
  }
  for (const name of previous.extensions || []) {
    if (!after.has(name)) reasons.push(`${name} removed`);
  }
  if (previous.mode !== next.mode) {
    const from = MODE_LABELS[previous.mode] || previous.mode;
    const to = MODE_LABELS[next.mode] || next.mode;
    reasons.push(`run mode ${from} → ${to}`);
  }
  return reasons;
}

/**
 * Compares the config against data/generated/built.json.
 * `reason` names exactly what changed.
 */
export function needsRebuild(cfg, generatedDir) {
  const next = buildKey(cfg);
  const targetHash = buildHash(cfg);
  const state = readBuiltState(generatedDir);

  if (!state || typeof state.hash !== "string") {
    return {
      needed: true,
      currentHash: null,
      targetHash,
      reason: "No build yet: FluidX3D has to be compiled once."
    };
  }
  if (state.hash === targetHash) {
    return {
      needed: false,
      currentHash: state.hash,
      targetHash,
      reason: "The existing build matches the configuration."
    };
  }

  const changes = describeChanges(state, next);
  return {
    needed: true,
    currentHash: state.hash,
    targetHash,
    reason: changes.length
      ? "Rebuild needed: " + changes.join(", ")
      : "Rebuild needed: the compile options have changed."
  };
}
