/**
 * install-solver.js and uninstall-solver.js end to end, in a sandbox: a
 * temporary studio root with its own studio.config.json that points at a fake
 * FluidX3D tree. After install + uninstall every touched FluidX3D file has to
 * be byte for byte what it was before.
 *
 * When the fluidx3d submodule is checked out, the same round trip also runs
 * against copies of its real setup.cpp and FluidX3D.vcxproj.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPSTREAM = path.join(STUDIO, "fluidx3d");

const SETUP_CPP = [
  "#include \"setup.hpp\"",
  "",
  "void main_setup() { // benchmark",
  "\tLBM lbm(128u, 128u, 128u, 1u, 0.02f);",
  "\tlbm.run();",
  "} /**/"
].join("\r\n"); // upstream: CRLF and no line break at the end

const VCXPROJ = [
  "<Project>",
  "  <ItemGroup>",
  "    <ClCompile Include=\"src\\lbm.cpp\" />",
  "    <ClCompile Include=\"src\\setup.cpp\" />",
  "  </ItemGroup>",
  "  <ItemGroup>",
  "    <ClInclude Include=\"src\\lbm.hpp\" />",
  "    <ClInclude Include=\"src\\utilities.hpp\" />",
  "  </ItemGroup>",
  "</Project>"
].join("\r\n");

let root;
let fx;

function makeSandbox(setupCpp, vcxproj) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fx3d-install-"));
  for (const dir of ["server", "scripts", "solver"]) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync(path.join(STUDIO, "server", "paths.js"), path.join(root, "server", "paths.js"));
  for (const name of ["install-solver.js", "uninstall-solver.js"]) {
    fs.copyFileSync(path.join(STUDIO, "scripts", name), path.join(root, "scripts", name));
  }
  for (const name of ["json.hpp", "mesh_seal.hpp", "setup_config.cpp"]) {
    fs.copyFileSync(path.join(STUDIO, "solver", name), path.join(root, "solver", name));
  }
  fs.copyFileSync(path.join(STUDIO, "studio.config.example.json"), path.join(root, "studio.config.example.json"));
  fs.writeFileSync(path.join(root, "studio.config.json"), JSON.stringify({ fluidx3dPath: "./fx", port: 1 }));
  fx = path.join(root, "fx");
  fs.mkdirSync(path.join(fx, "src"), { recursive: true });
  fs.writeFileSync(path.join(fx, "src", "lbm.hpp"), "#pragma once\n");
  fs.writeFileSync(path.join(fx, "src", "setup.cpp"), setupCpp);
  fs.writeFileSync(path.join(fx, "FluidX3D.vcxproj"), vcxproj);
}

const run = (script, ...args) => execFileSync(process.execPath, [path.join(root, "scripts", script), ...args], { cwd: root, encoding: "utf8" });
const read = (rel) => fs.readFileSync(path.join(fx, rel));
const text = (rel) => fs.readFileSync(path.join(fx, rel), "utf8");

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("install-solver and uninstall-solver", () => {
  beforeEach(() => makeSandbox(SETUP_CPP, VCXPROJ));

  it("install registers every solver file in one marked block per item group", () => {
    run("install-solver.js");
    const project = text("FluidX3D.vcxproj");
    for (const name of ["setup_config.cpp", "json.hpp", "mesh_seal.hpp"]) {
      assert.ok(project.includes(`src\\${name}`), `${name} missing from the project`);
      assert.ok(fs.existsSync(path.join(fx, "src", name)), `${name} was not copied`);
    }
    assert.equal(project.match(/<!-- >>> fluidx3d-studio -->/g).length, 2);
    assert.equal(project.match(/<!-- <<< fluidx3d-studio -->/g).length, 2);
    assert.match(text("src/setup.cpp"), /#ifndef GUI_CONFIG_SETUP[\s\S]*main_setup[\s\S]*#endif \/\/ GUI_CONFIG_SETUP/);
  });

  it("install is idempotent", () => {
    run("install-solver.js");
    const setup = read("src/setup.cpp");
    const project = read("FluidX3D.vcxproj");
    run("install-solver.js");
    assert.ok(read("src/setup.cpp").equals(setup));
    assert.ok(read("FluidX3D.vcxproj").equals(project));
  });

  it("uninstall restores setup.cpp and the project byte for byte", () => {
    run("install-solver.js");
    run("uninstall-solver.js");
    assert.equal(text("src/setup.cpp"), SETUP_CPP);
    assert.equal(text("FluidX3D.vcxproj"), VCXPROJ);
    for (const name of ["setup_config.cpp", "json.hpp", "mesh_seal.hpp"]) {
      assert.ok(!fs.existsSync(path.join(fx, "src", name)), `${name} was left behind`);
    }
  });

  it("uninstall also cleans up the nested blocks older versions wrote", () => {
    const nested = VCXPROJ.replace(
      "    <ClInclude Include=\"src\\utilities.hpp\" />",
      [
        "    <ClInclude Include=\"src\\utilities.hpp\" />",
        "    <!-- >>> fluidx3d-studio -->",
        "    <ClInclude Include=\"src\\json.hpp\" />",
        "    <!-- >>> fluidx3d-studio -->",
        "    <ClInclude Include=\"src\\mesh_seal.hpp\" />",
        "    <!-- <<< fluidx3d-studio -->",
        "    <!-- <<< fluidx3d-studio -->"
      ].join("\r\n")
    );
    fs.writeFileSync(path.join(fx, "FluidX3D.vcxproj"), nested);
    run("uninstall-solver.js");
    assert.equal(text("FluidX3D.vcxproj"), VCXPROJ);
  });

  it("files ending with a line break keep it", () => {
    fs.writeFileSync(path.join(fx, "src", "setup.cpp"), SETUP_CPP + "\r\n");
    fs.writeFileSync(path.join(fx, "FluidX3D.vcxproj"), VCXPROJ + "\r\n");
    run("install-solver.js");
    run("uninstall-solver.js");
    assert.equal(text("src/setup.cpp"), SETUP_CPP + "\r\n");
    assert.equal(text("FluidX3D.vcxproj"), VCXPROJ + "\r\n");
  });
});

const hasUpstream = fs.existsSync(path.join(UPSTREAM, "src", "setup.cpp")) && fs.existsSync(path.join(UPSTREAM, "FluidX3D.vcxproj"));

describe("round trip on the real FluidX3D files", { skip: hasUpstream ? false : "fluidx3d submodule not checked out" }, () => {
  it("restores the submodule's setup.cpp and FluidX3D.vcxproj byte for byte", () => {
    const setup = fs.readFileSync(path.join(UPSTREAM, "src", "setup.cpp"));
    const project = fs.readFileSync(path.join(UPSTREAM, "FluidX3D.vcxproj"));
    makeSandbox(setup, project);
    // the submodule may itself carry an install; start from a clean copy then
    if (setup.includes("fluidx3d-studio") || project.includes("fluidx3d-studio")) run("uninstall-solver.js");
    const cleanSetup = read("src/setup.cpp");
    const cleanProject = read("FluidX3D.vcxproj");
    run("install-solver.js");
    run("uninstall-solver.js");
    assert.ok(read("src/setup.cpp").equals(cleanSetup), "setup.cpp differs after the round trip");
    assert.ok(read("FluidX3D.vcxproj").equals(cleanProject), "FluidX3D.vcxproj differs after the round trip");
  });
});
