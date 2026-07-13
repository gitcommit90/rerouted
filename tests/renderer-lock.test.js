"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  createLatestRequestGate,
  guardSensitiveRender,
  requiresLockScreen,
} = require("../src/renderer/lock-state");

describe("renderer lock state", () => {
  it("blocks sensitive page rendering only for a locked configured app", () => {
    const locked = {
      onboardingComplete: true,
      hasAdminPassword: true,
      unlocked: false,
    };
    let lockRenders = 0;

    assert.equal(requiresLockScreen(locked), true);
    assert.equal(guardSensitiveRender(locked, () => lockRenders++), true);
    assert.equal(lockRenders, 1);
    assert.equal(guardSensitiveRender({ ...locked, unlocked: true }, () => lockRenders++), false);
    assert.equal(guardSensitiveRender({ ...locked, onboardingComplete: false }, () => lockRenders++), false);
    assert.equal(lockRenders, 1);
  });

  it("rejects an older state response after a lock refresh starts", () => {
    const gate = createLatestRequestGate();
    const acceptPreLockResponse = gate.begin();
    const acceptLockResponse = gate.begin();

    assert.equal(acceptPreLockResponse(), false);
    assert.equal(acceptLockResponse(), true);
  });
});
