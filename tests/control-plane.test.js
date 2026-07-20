"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createHeadlessRuntime } = require("../src/lib/headless-runtime");

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-control-"));
  const runtime = createHeadlessRuntime({ userData: root, version: "9.8.7" });
  cleanups.push(async () => {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return runtime;
}

describe("shared control plane", () => {
  it("covers every production renderer invoke channel", () => {
    const runtime = tempRuntime();
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
    const invokeBlock = source.slice(
      source.indexOf("const INVOKE_CHANNELS"),
      source.indexOf("const EVENT_CHANNELS")
    );
    const preloadChannels = [...invokeBlock.matchAll(/"(app:[^"]+)"/g)].map((match) => match[1]);
    const available = new Set(runtime.controlPlane.channels());
    const missing = [...new Set(preloadChannels)].filter((channel) => !available.has(channel));
    assert.deepEqual(missing, []);
  });

  it("returns headless runtime state and protects sensitive actions per session", async () => {
    const runtime = tempRuntime();
    const session = runtime.sessionAuth;
    const invoke = (channel, ...args) =>
      runtime.controlPlane.invoke(channel, args, { sessionAuth: session });

    const initial = await invoke("app:get-state");
    assert.equal(initial.runtime, "headless");
    assert.equal(initial.platform, process.platform);
    assert.equal(initial.appVersion, "9.8.7");
    assert.equal(initial.update.status, "unsupported");
    assert.match(initial.update.error, /package manager/i);
    assert.equal(initial.steps.includes("auto-detect"), false);

    assert.deepEqual(await invoke("app:set-onboarding-step", "oauth-providers"), {
      ok: true,
    });
    assert.equal((await invoke("app:get-state")).onboardingComplete, false);
    assert.deepEqual(await invoke("app:set-onboarding-step", "done"), {
      ok: false,
      error: "Unknown onboarding step",
    });
    assert.equal((await invoke("app:get-state")).onboardingComplete, false);

    assert.deepEqual(await invoke("app:set-admin-password", "correct horse"), { ok: true });
    assert.deepEqual(await invoke("app:complete-onboarding"), { ok: true });

    const otherSession = require("../src/lib/session-auth").createSessionAuth({ platform: "linux" });
    const blocked = await runtime.controlPlane.invoke("app:create-api-key", ["blocked"], {
      sessionAuth: otherSession,
    });
    assert.equal(blocked.code, "rerouted_locked");

    const locked = await runtime.controlPlane.invoke("app:get-state", [], {
      sessionAuth: otherSession,
    });
    assert.equal(locked.unlocked, false);
    assert.equal(locked.apiKeys, undefined);

    assert.deepEqual(
      await runtime.controlPlane.invoke("app:verify-admin-password", ["wrong"], {
        sessionAuth: otherSession,
      }),
      { ok: false }
    );
    assert.deepEqual(
      await runtime.controlPlane.invoke("app:verify-admin-password", ["correct horse"], {
        sessionAuth: otherSession,
      }),
      { ok: true }
    );
    const unlocked = await runtime.controlPlane.invoke("app:get-state", [], {
      sessionAuth: otherSession,
    });
    assert.equal(unlocked.unlocked, true);
    assert.equal(unlocked.apiKeys.length, 1);
  });

  it("returns a stable error for actions outside the shared contract", async () => {
    const runtime = tempRuntime();
    assert.deepEqual(await runtime.controlPlane.invoke("app:not-real"), {
      ok: false,
      code: "unsupported_action",
      error: "Unsupported ReRouted action.",
    });
  });

  it("toggles every model on an account in one update", async () => {
    const runtime = tempRuntime();
    runtime.store.update((cfg) => {
      cfg.providers.push({
        id: "prov_bulk",
        type: "openrouter",
        name: "OpenRouter",
        models: [
          { id: "model-a", name: "Model A", enabled: true },
          "model-b",
        ],
      });
    });
    const invoke = (channel, ...args) =>
      runtime.controlPlane.invoke(channel, args, { harness: true });

    assert.deepEqual(await invoke("app:set-all-models-enabled", {
      providerId: "prov_bulk",
      enabled: false,
    }), { ok: true, updated: 2, enabled: false });
    assert.deepEqual(
      runtime.store.load().providers[0].models.map((model) => model.enabled),
      [false, false]
    );
    assert.deepEqual(await invoke("app:set-all-models-enabled", {
      providerId: "missing",
      enabled: true,
    }), { ok: false, updated: 0, enabled: true });
  });
});
