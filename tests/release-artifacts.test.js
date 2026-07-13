"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

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
