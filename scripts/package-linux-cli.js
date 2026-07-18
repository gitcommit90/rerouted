#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const { versioned: versionedName, latest: latestName } = linuxCliArtifactNames(pkg.version);

function linuxCliArtifactNames(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(version || ""))) {
    throw new Error("A semantic package version is required");
  }
  return {
    versioned: `ReRouted-${version}-linux-node.tgz`,
    latest: "ReRouted-linux-node.tgz",
  };
}

if (require.main !== module) {
  module.exports = { linuxCliArtifactNames };
  return;
}

fs.mkdirSync(DIST, { recursive: true });
for (const name of [versionedName, latestName]) {
  fs.rmSync(path.join(DIST, name), { force: true });
}

const output = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--json", "--pack-destination", DIST],
  { cwd: ROOT, encoding: "utf8" }
);
const result = JSON.parse(output)[0];
if (!result?.filename) throw new Error("npm pack did not return an artifact filename");

const packedPath = path.join(DIST, result.filename);
const versionedPath = path.join(DIST, versionedName);
const latestPath = path.join(DIST, latestName);
fs.renameSync(packedPath, versionedPath);
fs.copyFileSync(versionedPath, latestPath);

const listing = execFileSync("tar", ["-tzf", versionedPath], { encoding: "utf8" });
for (const required of [
  "package/package.json",
  "package/LICENSE",
  "package/src/cli/index.js",
  "package/src/lib/headless-runtime.js",
  "package/src/lib/gateway.js",
  "package/src/renderer/index.html",
  "package/src/renderer/web-api.js",
]) {
  if (!listing.split("\n").includes(required)) {
    throw new Error(`Linux CLI package is missing ${required}`);
  }
}
if (/(?:^|\/)AGENTS\.md$/m.test(listing)) {
  throw new Error("Linux CLI package must not contain AGENTS.md");
}

console.log(versionedPath);
console.log(latestPath);
