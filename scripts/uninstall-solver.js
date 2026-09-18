/**
 * Removes everything install-solver.js put into the FluidX3D checkout
 * (CONTRACT.md section 5).
 *
 * Idempotent: it deletes the three solver files and every line block enclosed in
 * the "fluidx3d-studio" markers, and reports plainly when there was nothing
 * left to do. The backups under data/backup/ are kept.
 *
 *   node scripts/uninstall-solver.js [--restore-defines]
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT, BACKUP_DIR, ensureDirs, loadConfig, resolveFluidX3D } from "../server/paths.js";

// Marked blocks: opening marker, the inserted lines, closing marker.
const MARKS_CPP = { open: "// >>> fluidx3d-studio", close: "// <<< fluidx3d-studio" };
const MARKS_XML = { open: "<!-- >>> fluidx3d-studio -->", close: "<!-- <<< fluidx3d-studio -->" };

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SOLVER_FILES = ["setup_config.cpp", "mesh_seal.hpp", "json.hpp"];

const report = [];
const done = (text) => report.push(`  - ${text}`);
const unchanged = (text) => report.push(`  = ${text}`);
const note = (text) => report.push(`  · ${text}`);

function show(target) {
  const relative = path.relative(ROOT, target);
  return relative.startsWith("..") ? target : relative;
}

/**
 * Strips all marked blocks and restores the file byte for byte; returns null
 * when the file did not contain any markers.
 */
function stripBlocks(text, marks) {
  const open = escape(marks.open);
  const close = escape(marks.close);
  const ws = "[^\\S\\r\\n]*";
  // A block that ends the file was appended to a file without a final line
  // break: remove the line break in front of it too, not the one behind it.
  const atEnd = new RegExp(`\\r?\\n${ws}${open}(?:(?!${open})[\\s\\S])*?${close}${ws}$`);
  const block = new RegExp(`${ws}${open}[\\s\\S]*?${close}${ws}(\\r?\\n|$)`, "g");
  // Older installs nested one XML block inside another, which leaves a lone
  // closing marker behind once the inner block is gone.
  const lone = new RegExp(`^${ws}(?:${open}|${close})${ws}(\\r?\\n|$)`, "gm");
  const stripped = text.replace(atEnd, "").replace(block, "").replace(lone, "");
  return stripped === text ? null : stripped;
}

function main() {
  ensureDirs();
  const config = loadConfig();
  const fx = resolveFluidX3D(config);
  const restoreDefines = process.argv.slice(2).includes("--restore-defines");

  console.log("FluidX3D Studio — uninstall solver");
  console.log(`  FluidX3D: ${fx.root}`);

  if (!fx.found) {
    console.error(`\nError: "${fx.root}" is not a FluidX3D source tree (src/lbm.hpp is missing).`);
    console.error(`Fix "fluidx3dPath" in ${path.join(ROOT, "studio.config.json")}.`);
    process.exitCode = 1;
    return;
  }

  // 1. delete the copied solver files
  for (const name of SOLVER_FILES) {
    const target = path.join(fx.src, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target);
      done(`${show(target)} deleted`);
    } else {
      unchanged(`${show(target)} was not present`);
    }
  }

  // 2. remove the guard #ifndef from setup.cpp
  if (!fs.existsSync(fx.setup)) {
    note("setup.cpp not present, skipped");
  } else {
    const text = fs.readFileSync(fx.setup, "utf8");
    const stripped = stripBlocks(text, MARKS_CPP);
    if (stripped === null) {
      unchanged("setup.cpp contained no studio markers");
    } else {
      fs.writeFileSync(fx.setup, stripped);
      done("setup.cpp: removed #ifndef GUI_CONFIG_SETUP, its own main_setup() is active again");
    }
  }

  // 3. remove the entries from the Visual Studio project
  if (!fs.existsSync(fx.vcxproj)) {
    note("FluidX3D.vcxproj not present, skipped");
  } else {
    const text = fs.readFileSync(fx.vcxproj, "utf8");
    const stripped = stripBlocks(text, MARKS_XML);
    if (stripped === null) {
      unchanged("FluidX3D.vcxproj contained no studio markers");
    } else {
      fs.writeFileSync(fx.vcxproj, stripped);
      done("FluidX3D.vcxproj: removed setup_config.cpp, json.hpp and mesh_seal.hpp");
    }
  }

  // 4. optionally restore the original defines.hpp
  const definesBackup = path.join(BACKUP_DIR, "defines.hpp.orig");
  if (restoreDefines) {
    if (fs.existsSync(definesBackup)) {
      fs.copyFileSync(definesBackup, fx.defines);
      done("restored defines.hpp from data/backup/defines.hpp.orig");
    } else {
      note("no data/backup/defines.hpp.orig present; defines.hpp stays unchanged");
    }
  } else if (fs.existsSync(definesBackup)) {
    note("defines.hpp was overwritten by the server; restore it with --restore-defines");
  }

  console.log(report.join("\n"));
  console.log(`\nThe backups in ${show(BACKUP_DIR)} are kept.`);
}

try {
  main();
} catch (error) {
  console.error(`\nUninstall failed: ${error.message}`);
  process.exitCode = 1;
}
