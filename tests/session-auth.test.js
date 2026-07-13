"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createSessionAuth, isMacSessionActive } = require("../src/lib/session-auth");

describe("macOS session authentication", () => {
  it("uses an active Mac login session as the unlock", () => {
    const auth = createSessionAuth({ platform: "darwin", initialMacUnlocked: true });
    assert.equal(auth.isUnlocked(true), true);

    auth.setMacSessionUnlocked(false);
    assert.equal(auth.isUnlocked(true), false);

    auth.setMacSessionUnlocked(true);
    assert.equal(auth.isUnlocked(true), true);
  });

  it("clears a manual unlock when the Mac locks", () => {
    const auth = createSessionAuth({ platform: "darwin", initialMacUnlocked: false });
    auth.setManualUnlocked(true);
    assert.equal(auth.isUnlocked(true), true);
    auth.setMacSessionUnlocked(false);
    assert.equal(auth.isUnlocked(true), false);
  });

  it("retains password behavior on non-macOS platforms", () => {
    const auth = createSessionAuth({ platform: "linux", initialMacUnlocked: true });
    assert.equal(auth.isUnlocked(true), false);
    auth.setManualUnlocked(true);
    assert.equal(auth.isUnlocked(true), true);
  });

  it("fails closed when Electron cannot determine the Mac lock state", () => {
    assert.equal(isMacSessionActive("active"), true);
    assert.equal(isMacSessionActive("idle"), true);
    assert.equal(isMacSessionActive("locked"), false);
    assert.equal(isMacSessionActive("unknown"), false);
    assert.equal(isMacSessionActive(undefined), false);
  });
});
