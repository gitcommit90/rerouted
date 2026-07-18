"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { createHeadlessRuntime } = require("../src/lib/headless-runtime");
const { isLoopback, requestOriginMatches, SESSION_COOKIE } = require("../src/lib/dashboard");

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function runningRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-dashboard-"));
  const runtime = createHeadlessRuntime({ userData: root, version: "9.8.7" });
  const address = await runtime.start({ port: 0, host: "127.0.0.1" });
  cleanups.push(async () => {
    await runtime.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { runtime, address, base: `http://127.0.0.1:${address.port}` };
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function browser(base) {
  const loaded = await fetch(`${base}/dashboard/`);
  return {
    loaded,
    cookie: cookieFrom(loaded),
    invoke(channel, args = [], { origin = base } = {}) {
      return fetch(`${base}/dashboard/api/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.cookie,
          Origin: origin,
        },
        body: JSON.stringify({ channel, args }),
      });
    },
  };
}

describe("headless dashboard", () => {
  it("serves the real renderer and keeps the gateway health path unchanged", async () => {
    const { base } = await runningRuntime();
    const redirect = await fetch(`${base}/dashboard`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/dashboard/");

    const client = await browser(base);
    assert.equal(client.loaded.status, 200);
    assert.match(client.cookie, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(client.loaded.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await client.loaded.text();
    assert.match(html, /web-api\.js/);
    assert.match(html, /app\.js/);
    assert.ok(html.indexOf("web-api.js") < html.indexOf("app.js"));

    const css = await fetch(`${base}/dashboard/styles.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /dashboard-runtime/);

    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.port, Number(new URL(base).port));
  });

  it("uses isolated browser sessions and redacts state until password sign-in", async () => {
    const { runtime, base } = await runningRuntime();
    await runtime.controlPlane.invoke("app:set-admin-password", ["dashboard-pass"], { harness: true });
    await runtime.controlPlane.invoke("app:complete-onboarding", [], { harness: true });

    const first = await browser(base);
    const second = await browser(base);
    assert.notEqual(first.cookie, second.cookie);

    let response = await first.invoke("app:get-state");
    assert.equal(response.status, 200);
    let state = await response.json();
    assert.equal(state.unlocked, false);
    assert.equal(state.apiKeys, undefined);

    response = await first.invoke("app:verify-admin-password", ["dashboard-pass"]);
    assert.deepEqual(await response.json(), { ok: true });
    state = await (await first.invoke("app:get-state")).json();
    assert.equal(state.unlocked, true);
    assert.equal(state.apiKeys.length, 1);

    state = await (await second.invoke("app:get-state")).json();
    assert.equal(state.unlocked, false);
    assert.equal(state.apiKeys, undefined);
  });

  it("rejects cross-origin mutations and throttles repeated password attempts", async () => {
    const { runtime, base } = await runningRuntime();
    await runtime.controlPlane.invoke("app:set-admin-password", ["dashboard-pass"], { harness: true });
    await runtime.controlPlane.invoke("app:complete-onboarding", [], { harness: true });
    const client = await browser(base);

    const crossOrigin = await client.invoke("app:get-state", [], { origin: "https://attacker.invalid" });
    assert.equal(crossOrigin.status, 403);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await client.invoke("app:verify-admin-password", ["wrong"]);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: false });
    }
    const limited = await client.invoke("app:verify-admin-password", ["dashboard-pass"]);
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /too many/i);
  });

  it("serves only allowlisted dashboard assets", async () => {
    const { base } = await runningRuntime();
    const missing = await fetch(`${base}/dashboard/package.json`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("set-cookie"), null);
    const asset = await fetch(`${base}/dashboard/assets/providers/chatgpt.svg`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("set-cookie"), null);
  });

  it("invalidates other browser sessions when the admin password changes", async () => {
    const { runtime, base } = await runningRuntime();
    await runtime.controlPlane.invoke("app:set-admin-password", ["first-password"], { harness: true });
    await runtime.controlPlane.invoke("app:complete-onboarding", [], { harness: true });
    const first = await browser(base);
    const second = await browser(base);
    assert.deepEqual(await (await first.invoke("app:verify-admin-password", ["first-password"])).json(), { ok: true });
    assert.deepEqual(await (await second.invoke("app:verify-admin-password", ["first-password"])).json(), { ok: true });

    const changed = await first.invoke("app:change-admin-password", [
      { current: "first-password", next: "second-password" },
    ]);
    assert.deepEqual(await changed.json(), { ok: true });
    const firstState = await (await first.invoke("app:get-state")).json();
    assert.equal(firstState.unlocked, true);
    const secondState = await (await second.invoke("app:get-state")).json();
    assert.equal(secondState.unlocked, false);
    assert.equal(secondState.apiKeys, undefined);
  });

  it("requires a dashboard password when an imported config claims onboarding is complete", async () => {
    const { runtime, base } = await runningRuntime();
    runtime.store.update((cfg) => {
      cfg.onboardingComplete = true;
      cfg.onboardingStep = "done";
      cfg.adminPasswordHash = null;
    });
    const client = await browser(base);
    const recoveryState = await (await client.invoke("app:get-state")).json();
    assert.equal(recoveryState.onboardingComplete, false);
    assert.equal(recoveryState.onboardingStep, "admin-password");
    assert.equal(recoveryState.apiKeys, undefined);
    const blocked = await client.invoke("app:create-api-key", ["unsafe"]);
    assert.equal(blocked.status, 403);
    assert.match((await blocked.json()).error, /admin password/i);
    const password = await client.invoke("app:set-admin-password", ["new-dashboard-password"]);
    assert.deepEqual(await password.json(), { ok: true });
  });
});

describe("dashboard request boundaries", () => {
  it("recognizes loopback addresses only", () => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopback({ socket: { remoteAddress } }), true);
    }
    assert.equal(isLoopback({ socket: { remoteAddress: "192.168.1.20" } }), false);
  });

  it("requires exact same-origin host and port", () => {
    assert.equal(
      requestOriginMatches({ headers: { origin: "http://127.0.0.1:4949", host: "127.0.0.1:4949" } }),
      true
    );
    assert.equal(
      requestOriginMatches({ headers: { origin: "http://127.0.0.1:4950", host: "127.0.0.1:4949" } }),
      false
    );
    assert.equal(requestOriginMatches({ headers: { host: "127.0.0.1:4949" } }), false);
  });
});
