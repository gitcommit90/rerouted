"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { updateZipName, isRecognizedMacUpdateZip } = require("../scripts/release-artifacts");

test("names updater ZIPs for the macOS Apple Silicon release feed", () => {
  const name = updateZipName("ReRouted", "0.3.1", "arm64");
  assert.equal(name, "ReRouted-0.3.1-mac-arm64.zip");
  assert.equal(isRecognizedMacUpdateZip(name), true);
});

test("rejects ZIP names the public update service cannot classify", () => {
  assert.equal(isRecognizedMacUpdateZip("ReRouted-0.3.1-arm64.zip"), false);
  assert.equal(isRecognizedMacUpdateZip("ReRouted-0.3.1-mac-x64.zip"), false);
  assert.equal(isRecognizedMacUpdateZip("ReRouted-0.3.1-mac-arm64.dmg"), false);
});

test("declares MIT and includes its notice in packaged release copies", () => {
  const root = path.resolve(__dirname, "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  const packager = fs.readFileSync(path.join(root, "scripts", "package-mac-dmg.js"), "utf8");

  assert.equal(pkg.license, "MIT");
  assert.match(license, /^MIT License\n/);
  assert.match(packager, /path\.join\(ROOT, "LICENSE"\)/);
  assert.match(packager, /path\.join\(stage, "LICENSE\.txt"\)/);
});
