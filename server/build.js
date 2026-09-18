/**
 * Locating the build tool, writing defines.hpp and compiling FluidX3D.
 *
 * The only file the running server ever writes inside the FluidX3D checkout is
 * src/defines.hpp, and only after a backup exists in data/backup/.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BACKUP_DIR } from "./paths.js";

const IS_WINDOWS = process.platform === "win32";
const DEFINES_BACKUP = path.join(BACKUP_DIR, "defines.hpp.orig");

/** Cached tool lookup: undefined = not looked up yet, null = not available. */
let toolCache;

function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* unreadable candidate, try the next one */
    }
  }
  return null;
}

/** Resolves an executable through PATH without ever throwing. */
function onPath(exe) {
  try {
    const probe = IS_WINDOWS
      ? spawnSync("where", [exe], { encoding: "utf8", windowsHide: true })
      : spawnSync("which", [exe], { encoding: "utf8" });
    if (probe.status !== 0 || !probe.stdout) return null;
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/** Asks vswhere for the MSBuild of the newest Visual Studio installation. */
function viaVswhere() {
  const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles].filter(Boolean);
  const vswhere = firstExisting(
    roots.map((r) => path.join(r, "Microsoft Visual Studio", "Installer", "vswhere.exe"))
  );
  if (!vswhere) return null;
  try {
    const probe = spawnSync(
      vswhere,
      ["-latest", "-prerelease", "-products", "*", "-requires", "Microsoft.Component.MSBuild",
        "-find", "MSBuild\\**\\Bin\\MSBuild.exe"],
      { encoding: "utf8", windowsHide: true }
    );
    if (probe.status !== 0 || !probe.stdout) return null;
    const hits = probe.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Prefer the 64-bit amd64 build when vswhere lists several.
    return firstExisting(hits.filter((h) => /amd64/i.test(h))) || firstExisting(hits);
  } catch {
    return null;
  }
}

function viaWellKnownPaths() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const years = ["18", "2022", "2019"]; // Visual Studio 2026 installs into "18"
  const editions = ["Enterprise", "Professional", "Community", "BuildTools", "Preview"];
  const versions = ["Current", "17.0", "16.0"];
  const candidates = [];
  for (const root of roots) {
    for (const year of years) {
      for (const edition of editions) {
        for (const version of versions) {
          candidates.push(path.join(root, "Microsoft Visual Studio", year, edition, "MSBuild", version, "Bin", "MSBuild.exe"));
        }
      }
    }
  }
  return firstExisting(candidates);
}

/**
 * Path of the build tool, or null. On Windows that is MSBuild, elsewhere the
 * shell that runs make.sh. The result is cached because /api/health asks often.
 */
export function findBuildTool(refresh = false) {
  if (!refresh && toolCache !== undefined) return toolCache;
  toolCache = IS_WINDOWS
    ? onPath("msbuild.exe") || viaVswhere() || viaWellKnownPaths()
    : onPath("make") || onPath("bash");
  return toolCache;
}

/**
 * Platform toolsets (v142, v143, v145, ...) installed with the Visual Studio
 * that an MSBuild.exe belongs to, newest first. Empty when the layout is not
 * the usual <VS>\MSBuild\...\MSBuild.exe one.
 */
export function installedToolsets(msbuild) {
  if (typeof msbuild !== "string") return [];
  const parts = path.resolve(msbuild).split(path.sep);
  const at = parts.slice(0, -1).map((p) => p.toLowerCase()).lastIndexOf("msbuild");
  if (at < 0) return [];
  const vcRoot = path.join(parts.slice(0, at + 1).join(path.sep), "Microsoft", "VC");
  const found = new Set();
  let versions = [];
  try {
    versions = fs.readdirSync(vcRoot);
  } catch {
    return [];
  }
  for (const version of versions) {
    try {
      for (const name of fs.readdirSync(path.join(vcRoot, version, "Platforms", "x64", "PlatformToolsets"))) {
        if (/^v\d+$/.test(name)) found.add(name);
      }
    } catch {
      /* not a toolset folder */
    }
  }
  return [...found].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
}

/**
 * The toolset to force on the command line, or null to keep the project's.
 * FluidX3D.vcxproj names one fixed toolset (v142 = Visual Studio 2019); with
 * only a newer Visual Studio installed, MSBuild would refuse to build at all.
 */
export function chooseToolset(projectToolset, installed) {
  if (!projectToolset || !Array.isArray(installed) || installed.length === 0) return null;
  return installed.includes(projectToolset) ? null : installed[0];
}

function projectToolset(fx) {
  try {
    const match = /<PlatformToolset>\s*([^<\s]+)\s*<\/PlatformToolset>/.exec(fs.readFileSync(fx.vcxproj, "utf8"));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** True when FluidX3D can be compiled on this machine. Synchronous and cached. */
export function hasMsbuild(refresh = false) {
  return findBuildTool(refresh) !== null;
}

/** Explanation of what has to be installed, used for stage: error. */
export function missingToolMessage() {
  return IS_WINDOWS
    ? "MSBuild was not found. Install the \"Visual Studio Build Tools\" (2022 or newer) with the " +
      "\"Desktop development with C++\" workload (https://visualstudio.microsoft.com/downloads/) " +
      "or add MSBuild.exe to the PATH, then restart the server."
    : "Neither \"make\" nor \"bash\" was found. Install build tools and g++ " +
      "(e.g. sudo apt install build-essential), then restart the server.";
}

/**
 * Writes the generated defines.hpp into the FluidX3D checkout.
 * The original is saved to data/backup/defines.hpp.orig exactly once; an
 * existing backup is never overwritten.
 */
export function writeDefines(fx, text) {
  if (!fx || !fx.found) {
    throw new Error("FluidX3D was not found, so defines.hpp cannot be written.");
  }
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("The generated defines.hpp content is empty; aborting.");
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (!fs.existsSync(DEFINES_BACKUP) && fs.existsSync(fx.defines)) {
    fs.copyFileSync(fx.defines, DEFINES_BACKUP);
  }
  // Skip identical writes: a fresh mtime alone would make MSBuild recompile.
  try {
    if (fs.readFileSync(fx.defines, "utf8") === text) return;
  } catch {
    /* file missing or unreadable, write it */
  }
  fs.writeFileSync(fx.defines, text, "utf8");
}

/** Reports whether a backup of the original defines.hpp exists. */
export function definesBackupPath() {
  return fs.existsSync(DEFINES_BACKUP) ? DEFINES_BACKUP : null;
}

function splitter(onLine, stream) {
  let rest = "";
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split(/\r\n|\n|\r/);
      rest = parts.pop();
      for (const part of parts) onLine(part, stream);
    },
    flush() {
      if (rest.length) onLine(rest, stream);
      rest = "";
    }
  };
}

/**
 * Compiles FluidX3D. Every output line is reported through
 * onLine(text, "stdout" | "stderr"), and onSpawn receives the child process so
 * a caller can abort it. Resolves with the exit code even when the compiler
 * failed; rejects only when the build could not be started at all.
 */
export function buildSolver(fx, onLine = () => {}, onSpawn = () => {}) {
  return new Promise((resolve, reject) => {
    if (!fx || !fx.found) {
      reject(new Error("FluidX3D was not found, so it cannot be built."));
      return;
    }
    const tool = findBuildTool(true);
    if (!tool) {
      reject(new Error(missingToolMessage()));
      return;
    }

    let command;
    let args;
    if (IS_WINDOWS) {
      command = tool;
      args = ["FluidX3D.sln", "/p:Configuration=Release", "/p:Platform=x64", "/m"];
      const wanted = projectToolset(fx);
      const toolset = chooseToolset(wanted, installedToolsets(tool));
      if (toolset) {
        args.push(`/p:PlatformToolset=${toolset}`);
        onLine(`FluidX3D.vcxproj asks for toolset ${wanted}, which is not installed; building with ${toolset}.`, "stdout");
      }
    } else if (/(^|[\\/])make$/.test(tool)) {
      // make.sh would launch the freshly built binary; the makefile it uses
      // does not, which is what a build step needs.
      const target = process.platform === "darwin" ? "macOS" : process.env.DISPLAY ? "Linux-X11" : "Linux";
      command = tool;
      args = [target, `-j${Math.max(1, os.cpus().length)}`];
    } else {
      command = tool;
      args = ["make.sh"];
    }

    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, { cwd: fx.root, windowsHide: true, env: process.env });
    } catch (err) {
      reject(new Error(`The build could not be started: ${err.message}`));
      return;
    }

    try {
      onSpawn(child);
    } catch {
      /* the caller's bookkeeping must not break the build */
    }

    const out = splitter(onLine, "stdout");
    const err = splitter(onLine, "stderr");
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));

    let settled = false;
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      reject(new Error(`The build tool could not be run: ${e.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      out.flush();
      err.flush();
      resolve({ code: code === null ? -1 : code, seconds: (Date.now() - started) / 1000 });
    });
  });
}
