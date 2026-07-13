"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const { ConfigLoadError, createStore } = require("../src/lib/store");

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-store-recovery-"));
  return path.join(dir, "config.json");
}

describe("config load recovery", () => {
  it("initializes a missing config file", () => {
    const filePath = tempConfig();
    const config = createStore(filePath).load();

    assert.equal(fs.existsSync(filePath), true);
    assert.match(config.apiKey, /^rr-/);
    assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).apiKey, config.apiKey);
  });

  it("preserves invalid JSON and creates an exact recovery copy", () => {
    const filePath = tempConfig();
    const original = '{"apiKey":"rr-do-not-destroy"';
    fs.writeFileSync(filePath, original, { mode: 0o600 });

    assert.throws(
      () => createStore(filePath).load(),
      (error) => {
        assert.ok(error instanceof ConfigLoadError);
        assert.equal(error.code, "CONFIG_LOAD_FAILED");
        assert.equal(error.filePath, filePath);
        assert.ok(error.recoveryPath);
        assert.match(error.message, /not valid JSON/);
        assert.equal(fs.readFileSync(error.recoveryPath, "utf8"), original);
        assert.equal(fs.statSync(error.recoveryPath).mode & 0o777, 0o600);
        return true;
      }
    );
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
  });

  it("does not replace a structurally invalid JSON root", () => {
    const filePath = tempConfig();
    const original = "[]";
    fs.writeFileSync(filePath, original, { mode: 0o600 });

    assert.throws(() => createStore(filePath).load(), /JSON root must be an object/);
    assert.equal(fs.readFileSync(filePath, "utf8"), original);
    const recoveryFiles = fs
      .readdirSync(path.dirname(filePath))
      .filter((name) => name.startsWith("config.json.recovery-"));
    assert.equal(recoveryFiles.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(filePath), recoveryFiles[0]), "utf8"), original);
  });

  it("surfaces non-missing read failures without replacing the existing path", () => {
    const filePath = tempConfig();
    fs.mkdirSync(filePath);

    assert.throws(
      () => createStore(filePath).load(),
      (error) => {
        assert.ok(error instanceof ConfigLoadError);
        assert.equal(error.code, "CONFIG_LOAD_FAILED");
        assert.equal(error.recoveryPath, null);
        assert.match(error.message, /left untouched/);
        return true;
      }
    );
    assert.equal(fs.statSync(filePath).isDirectory(), true);
  });
});
