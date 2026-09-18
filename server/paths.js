/**
 * Central resolution of every path and setting the server uses.
 * Nothing else in the codebase may construct paths from __dirname.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, "..");

const CONFIG_FILE = path.join(ROOT, "studio.config.json");
const EXAMPLE_FILE = path.join(ROOT, "studio.config.example.json");

/**
 * Optional "dataPath" in studio.config.json moves setups, uploads and their
 * index out of the studio, e.g. into the project repository that uses it.
 * The FluidX3D backups stay machine-local in <studio>/data/backup.
 */
function configuredDataDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (typeof cfg.dataPath === "string" && cfg.dataPath.length > 0) return path.resolve(ROOT, cfg.dataPath);
  } catch {
    // no or unreadable config: default location
  }
  return path.join(ROOT, "data");
}

export const WEB_DIR = path.join(ROOT, "web");
export const DATA_DIR = configuredDataDir();
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const SETUP_DIR = path.join(DATA_DIR, "setups");
export const GENERATED_DIR = path.join(DATA_DIR, "generated");
export const BACKUP_DIR = path.join(ROOT, "data", "backup");
export const SOLVER_DIR = path.join(ROOT, "solver");
export const NODE_MODULES = path.join(ROOT, "node_modules");

export function ensureDirs() {
  for (const d of [DATA_DIR, UPLOAD_DIR, SETUP_DIR, GENERATED_DIR, BACKUP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** Reads studio.config.json, creating it from the example on first run. */
export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  cfg.port = Number(process.env.PORT) || cfg.port || 8787;
  cfg.gpu = cfg.gpu || { name: "unknown", vramMB: 8192, bandwidthGBs: 400 };
  return cfg;
}

/** Absolute location of the FluidX3D checkout, or null if it is not there. */
export function resolveFluidX3D(cfg) {
  const p = path.resolve(ROOT, cfg.fluidx3dPath || "./fluidx3d");
  const ok = fs.existsSync(path.join(p, "src", "lbm.hpp"));
  return {
    root: p,
    found: ok,
    src: path.join(p, "src"),
    bin: path.join(p, "bin"),
    defines: path.join(p, "src", "defines.hpp"),
    setup: path.join(p, "src", "setup.cpp"),
    vcxproj: path.join(p, "FluidX3D.vcxproj"),
    sln: path.join(p, "FluidX3D.sln"),
    exe: path.join(p, "bin", process.platform === "win32" ? "FluidX3D.exe" : "FluidX3D")
  };
}

/**
 * Joins a user-supplied relative path onto a base directory and refuses
 * anything that would escape it. Returns null when the path is unsafe.
 */
export function safeJoin(base, relative) {
  if (typeof relative !== "string" || relative.length === 0) return null;
  const resolved = path.resolve(base, relative);
  const normalisedBase = path.resolve(base) + path.sep;
  if (resolved !== path.resolve(base) && !resolved.startsWith(normalisedBase)) return null;
  return resolved;
}
