/**
 * Installs the FluidX3D Studio solver files into the configured FluidX3D
 * checkout (CONTRACT.md section 5).
 *
 * Idempotent: running it twice changes nothing the second time. Every file it
 * touches is copied to data/backup/<name>.orig once, and an existing backup is
 * never overwritten. All edits it makes to foreign files are enclosed in
 * marker comments so uninstall-solver.js can remove exactly those lines again.
 *
 *   node scripts/install-solver.js
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT, SOLVER_DIR, BACKUP_DIR, GENERATED_DIR, ensureDirs, loadConfig, resolveFluidX3D } from "../server/paths.js";

/**
 * The server decides whether to rebuild from a hash over the defines.hpp
 * options alone — it has no way of knowing that the solver sources underneath
 * just changed. Installing new sources therefore has to invalidate that record,
 * or the next run happily starts the stale binary.
 */
function invalidateBuildRecord() {
  const record = path.join(GENERATED_DIR, "built.json");
  if (!fs.existsSync(record)) return null;
  fs.rmSync(record);
  return record;
}

const MARK_OPEN_CPP = "// >>> fluidx3d-studio";
const MARK_CLOSE_CPP = "// <<< fluidx3d-studio";
const MARK_OPEN_XML = "<!-- >>> fluidx3d-studio -->";
const MARK_CLOSE_XML = "<!-- <<< fluidx3d-studio -->";

const SOLVER_FILES = ["json.hpp", "mesh_seal.hpp", "setup_config.cpp"];

const report = [];
const done = (text) => report.push(`  + ${text}`);
const unchanged = (text) => report.push(`  = ${text}`);
const note = (text) => report.push(`  · ${text}`);

/** Short, readable path for the console output. */
function show(target) {
  const relative = path.relative(ROOT, target);
  return relative.startsWith("..") ? target : relative;
}

/** Copies a file to data/backup/ exactly once; an existing backup is sacred. */
function backupOnce(source, backupName) {
  const target = path.join(BACKUP_DIR, backupName);
  if (fs.existsSync(target) || !fs.existsSync(source)) return false;
  fs.copyFileSync(source, target);
  return true;
}

function lineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Splits into lines and remembers whether the file ended with a newline. */
function toLines(text) {
  const lines = text.split(/\r?\n/);
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === "";
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function fromLines(lines, trailingNewline, eol) {
  return lines.join(eol) + (trailingNewline ? eol : "");
}

function isUpToDate(source, target) {
  return fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(source));
}

/**
 * Wraps the whole of setup.cpp in #ifndef GUI_CONFIG_SETUP, starting after the
 * leading #include block so that defines.hpp is read before the guard is
 * evaluated. Returns null when the guard is already in place.
 */
function guardSetupCpp(text) {
  if (text.includes(MARK_OPEN_CPP)) return null;
  const eol = lineEnding(text);
  const { lines, trailingNewline } = toLines(text);

  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#\s*include\b/.test(line)) insertAt = i + 1;
    else if (line.trim() !== "" && !/^\s*(\/\/|\/\*|\*)/.test(line)) break;
  }

  const head = [
    MARK_OPEN_CPP,
    "#ifndef GUI_CONFIG_SETUP // while the studio controls the build, setup_config.cpp provides main_setup()",
    MARK_CLOSE_CPP
  ];
  const tail = [MARK_OPEN_CPP, "#endif // GUI_CONFIG_SETUP", MARK_CLOSE_CPP];
  const patched = [...lines.slice(0, insertAt), ...head, ...lines.slice(insertAt), ...tail];
  return fromLines(patched, trailingNewline, eol);
}

/** Inserts `block` after the last line matching `pattern`, keeping its indent. */
function insertAfterLast(lines, pattern, block) {
  let index = -1;
  for (let i = 0; i < lines.length; i++) if (pattern.test(lines[i])) index = i;
  if (index < 0) return null;
  const indent = (lines[index].match(/^\s*/) || [""])[0];
  return [...lines.slice(0, index + 1), ...block.map((line) => indent + line), ...lines.slice(index + 1)];
}

/**
 * Adds the three solver files to the Visual Studio project. Returns null when
 * all entries are already there or the anchors cannot be found.
 */
function registerInVcxproj(text) {
  const eol = lineEnding(text);
  let { lines, trailingNewline } = toLines(text);
  let changed = false;

  if (!text.includes("src\\setup_config.cpp")) {
    const patched = insertAfterLast(lines, /<ClCompile\s+Include=/, [
      MARK_OPEN_XML,
      '<ClCompile Include="src\\setup_config.cpp" />',
      MARK_CLOSE_XML
    ]);
    if (patched === null) return { error: "No <ClCompile Include=…> entry found." };
    lines = patched;
    changed = true;
  }
  // One block for all headers: inserting them one by one would put the second
  // block inside the first (after its <ClInclude> line) and nest the markers.
  const headers = ["json.hpp", "mesh_seal.hpp"].filter((header) => !text.includes(`src\\${header}`));
  if (headers.length > 0) {
    const patched = insertAfterLast(lines, /<ClInclude\s+Include=/, [
      MARK_OPEN_XML,
      ...headers.map((header) => `<ClInclude Include="src\\${header}" />`),
      MARK_CLOSE_XML
    ]);
    if (patched === null) return { error: "No <ClInclude Include=…> entry found." };
    lines = patched;
    changed = true;
  }
  return changed ? { text: fromLines(lines, trailingNewline, eol) } : {};
}

function main() {
  ensureDirs();
  const config = loadConfig();
  const fx = resolveFluidX3D(config);

  console.log("FluidX3D Studio — install solver");
  console.log(`  FluidX3D: ${fx.root}`);

  if (!fx.found) {
    console.error(`\nError: "${fx.root}" is not a FluidX3D source tree (src/lbm.hpp is missing).`);
    console.error(`Fix "fluidx3dPath" in ${path.join(ROOT, "studio.config.json")}.`);
    process.exitCode = 1;
    return;
  }

  // 1. copy the solver files into src/
  for (const name of SOLVER_FILES) {
    const source = path.join(SOLVER_DIR, name);
    const target = path.join(fx.src, name);
    if (!fs.existsSync(source)) {
      console.error(`\nError: "${source}" is missing from the studio repository.`);
      process.exitCode = 1;
      return;
    }
    if (isUpToDate(source, target)) {
      unchanged(`${show(target)} was already up to date`);
      continue;
    }
    // back up only when a foreign or older version is about to be overwritten
    if (backupOnce(target, `${name}.orig`)) note(`backed up existing ${name} to data/backup/${name}.orig`);
    fs.writeFileSync(target, fs.readFileSync(source));
    done(`${show(target)} written`);
  }

  // 2. disable the hand-written main_setup() in setup.cpp
  if (!fs.existsSync(fx.setup)) {
    console.error(`\nError: "${fx.setup}" was not found.`);
    process.exitCode = 1;
    return;
  }
  backupOnce(fx.setup, "setup.cpp.orig");
  const setupText = fs.readFileSync(fx.setup, "utf8");
  const guarded = guardSetupCpp(setupText);
  if (guarded === null) {
    unchanged("setup.cpp was already wrapped in #ifndef GUI_CONFIG_SETUP");
  } else {
    fs.writeFileSync(fx.setup, guarded);
    done("wrapped setup.cpp in #ifndef GUI_CONFIG_SETUP");
  }

  // 3. extend the Visual Studio project (elsewhere make.sh builds via wildcard)
  if (!fs.existsSync(fx.vcxproj)) {
    note("FluidX3D.vcxproj not present, skipped (make.sh needs no entry)");
  } else {
    backupOnce(fx.vcxproj, "FluidX3D.vcxproj.orig");
    const projectText = fs.readFileSync(fx.vcxproj, "utf8");
    const result = registerInVcxproj(projectText);
    if (result.error) {
      note(`FluidX3D.vcxproj could not be extended: ${result.error}`);
      note("Add the solver files to the project by hand.");
    } else if (result.text) {
      fs.writeFileSync(fx.vcxproj, result.text);
      done("added setup_config.cpp, json.hpp and mesh_seal.hpp to FluidX3D.vcxproj");
    } else {
      unchanged("FluidX3D.vcxproj already contained the entries");
    }
  }

  if (invalidateBuildRecord()) {
    report.push("· build record deleted; the next run recompiles");
  }

  console.log(report.join("\n"));
  console.log(`\nBackups are in ${show(BACKUP_DIR)}.`);
  console.log("The solver only becomes active once defines.hpp defines GUI_CONFIG_SETUP;");
  console.log("the server takes care of that when building. To undo: npm run uninstall-solver");
}

try {
  main();
} catch (error) {
  console.error(`\nInstallation failed: ${error.message}`);
  process.exitCode = 1;
}
