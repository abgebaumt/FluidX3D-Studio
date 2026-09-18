/**
 * Toolset selection for MSBuild: FluidX3D.vcxproj pins one platform toolset,
 * and a machine with only a newer Visual Studio has to build with that one.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chooseToolset, installedToolsets } from "../server/build.js";

describe("chooseToolset", () => {
  it("keeps the project's toolset when it is installed", () => {
    assert.equal(chooseToolset("v142", ["v145", "v143", "v142"]), null);
  });

  it("falls back to the newest installed toolset when the project's is missing", () => {
    assert.equal(chooseToolset("v142", ["v145", "v143"]), "v145");
  });

  it("changes nothing when nothing is known", () => {
    assert.equal(chooseToolset(null, ["v145"]), null);
    assert.equal(chooseToolset("v142", []), null);
    assert.equal(chooseToolset("v142", undefined), null);
  });
});

describe("installedToolsets", () => {
  let root;
  let msbuild;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fx3d-toolsets-"));
    const vs = path.join(root, "Microsoft Visual Studio", "18", "Community", "MSBuild");
    for (const [version, toolsets] of [["v170", ["v143", "v142"]], ["v180", ["v145"]]]) {
      for (const toolset of toolsets) {
        fs.mkdirSync(path.join(vs, "Microsoft", "VC", version, "Platforms", "x64", "PlatformToolsets", toolset), { recursive: true });
      }
    }
    fs.mkdirSync(path.join(vs, "Microsoft", "VC", "v180", "Platforms", "x64", "PlatformToolsets", "not-a-toolset"), { recursive: true });
    msbuild = path.join(vs, "Current", "Bin", "amd64", "MSBuild.exe");
    fs.mkdirSync(path.dirname(msbuild), { recursive: true });
    fs.writeFileSync(msbuild, "");
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists every toolset next to MSBuild, newest first", () => {
    assert.deepEqual(installedToolsets(msbuild), ["v145", "v143", "v142"]);
  });

  it("returns an empty list for paths outside a Visual Studio layout", () => {
    assert.deepEqual(installedToolsets(path.join(root, "bin", "msbuild.exe")), []);
    assert.deepEqual(installedToolsets(null), []);
  });
});
