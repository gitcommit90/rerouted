"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createSessionAuth } = require("../src/lib/session-auth");
const {
  canInvoke,
  isAllowedExternalUrl,
  lockedError,
  redactLockedState,
} = require("../src/lib/ipc-security");

describe("main-process IPC lock enforcement", () => {
  const protectedConfig = {
    onboardingComplete: true,
    adminPasswordHash: "scrypt-hash",
  };

  it("allows only lock-screen actions until the session is authenticated", () => {
    const auth = createSessionAuth({ platform: "linux" });
    assert.equal(canInvoke("app:get-state", protectedConfig, auth), true);
    assert.equal(canInvoke("app:verify-admin-password", protectedConfig, auth), true);
    assert.equal(canInvoke("app:remove-provider", protectedConfig, auth), false);
    assert.equal(canInvoke("app:regenerate-key", protectedConfig, auth), false);

    auth.setManualUnlocked(true);
    assert.equal(canInvoke("app:remove-provider", protectedConfig, auth), true);
  });

  it("does not block onboarding or password-free configurations", () => {
    const auth = createSessionAuth({ platform: "linux" });
    assert.equal(
      canInvoke("app:oauth-start", { onboardingComplete: false }, auth),
      true
    );
    assert.equal(
      canInvoke("app:save-combo", { onboardingComplete: true }, auth),
      true
    );
  });

  it("removes gateway keys and account state before returning locked state", () => {
    const redacted = redactLockedState({
      onboardingComplete: true,
      onboardingStep: "done",
      appVersion: "0.4.2",
      update: { status: "idle" },
      port: 4949,
      serverEnabled: true,
      serverListening: true,
      unlocked: false,
      hasAdminPassword: true,
      apiKey: "rr-secret",
      apiKeys: [{ key: "rr-secret" }],
      providers: [{ email: "person@example.com" }],
      combos: [{ name: "coding" }],
      steps: ["done"],
    });

    assert.equal(redacted.apiKey, undefined);
    assert.equal(redacted.apiKeys, undefined);
    assert.equal(redacted.providers, undefined);
    assert.equal(redacted.combos, undefined);
    assert.equal(redacted.serverListening, true);
  });

  it("returns a stable machine-readable locked error", () => {
    assert.deepEqual(lockedError(), {
      ok: false,
      code: "rerouted_locked",
      error: "Unlock ReRouted to continue.",
    });
  });

  it("opens only the product's HTTPS destinations from the renderer", () => {
    assert.equal(isAllowedExternalUrl("https://rerouted.dev"), true);
    assert.equal(isAllowedExternalUrl("https://www.rerouted.dev/about"), true);
    assert.equal(isAllowedExternalUrl("http://rerouted.dev"), false);
    assert.equal(isAllowedExternalUrl("file:///tmp/secret"), false);
    assert.equal(isAllowedExternalUrl("https://example.com"), false);
  });
});
