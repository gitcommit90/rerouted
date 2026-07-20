"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const { parseArgs, pathsFor, run } = require("../src/cli");
const {
  createHeadlessRuntime,
  createProcessLock,
  defaultUserData,
} = require("../src/lib/headless-runtime");
const { runFirstSetup } = require("../src/cli/setup");
const { verifyPassword } = require("../src/lib/password");

function memoryOutput() {
  let value = "";
  return {
    isTTY: false,
    write(chunk) {
      value += chunk;
      return true;
    },
    value: () => value,
  };
}

describe("ReRouted CLI", () => {
  it("parses start options and validates network boundaries", () => {
    assert.deepEqual(parseArgs(["--host", "localhost", "--port", "5050", "--no-interactive"]), {
      command: "start",
      host: "127.0.0.1",
      port: 5050,
      dataDir: null,
      interactive: false,
    });
    assert.throws(() => parseArgs(["--host", "192.168.1.5"]), /--host must be/);
    assert.throws(() => parseArgs(["--port", "70000"]), /--port must be/);
    assert.throws(() => parseArgs(["--port"]), /requires a number/);
    assert.throws(() => parseArgs(["--data-dir"]), /requires a path/);
    assert.throws(() => parseArgs(["--wat"]), /Unknown option/);
  });

  it("uses the XDG config directory on Linux and exposes stable data paths", () => {
    const data = defaultUserData({
      platform: "linux",
      env: { XDG_CONFIG_HOME: "/tmp/xdg" },
      homedir: "/home/dev",
    });
    assert.equal(data, "/tmp/xdg/rerouted");
    assert.deepEqual(pathsFor(data), {
      data,
      config: "/tmp/xdg/rerouted/config.json",
      usage: "/tmp/xdg/rerouted/usage.sqlite",
      logs: "/tmp/xdg/rerouted/rerouted.log",
    });
  });

  it("runs the real gateway and dashboard in non-interactive mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-cli-"));
    const output = memoryOutput();
    const error = memoryOutput();
    try {
      const code = await run(
        ["--data-dir", root, "--host", "127.0.0.1", "--port", "0", "--no-interactive"],
        {
          input: { isTTY: false },
          output,
          error,
          waitForSignal: false,
        }
      );
      assert.equal(code, 0, error.value());
      assert.match(output.value(), /Gateway\s+http:\/\/127\.0\.0\.1:\d+\/v1/);
      assert.match(output.value(), /Dashboard http:\/\/127\.0\.0\.1:\d+\/dashboard\//);
      assert.match(output.value(), /First-time setup is waiting/);
      assert.equal(fs.existsSync(path.join(root, "config.json")), true);
      assert.equal(fs.existsSync(path.join(root, "rerouted.pid")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("completes first-run terminal setup without requiring a provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-setup-"));
    const runtime = createHeadlessRuntime({ userData: root, version: "test" });
    const output = memoryOutput();
    const secrets = ["terminal-password", "terminal-password"];
    const confirmations = [false, false];
    const prompts = {
      secret: async () => secrets.shift(),
      confirm: async () => confirmations.shift(),
      text: async () => "",
      select: async () => 0,
      multiSelect: async () => [],
    };
    try {
      const completed = await runFirstSetup({
        prompts,
        controlPlane: runtime.controlPlane,
        dashboardUrl: "http://127.0.0.1:4949/dashboard/",
        output,
      });
      assert.equal(completed, true);
      const cfg = runtime.store.load();
      assert.equal(cfg.onboardingComplete, true);
      assert.equal(cfg.onboardingStep, "done");
      assert.equal(await verifyPassword("terminal-password", cfg.adminPasswordHash), true);
      assert.match(output.value(), /Setup complete/);
      assert.match(output.value(), /No provider models are available yet/);
    } finally {
      await runtime.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("headless process lock", () => {
  it("rejects a live duplicate and cleans up the owning lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-lock-"));
    try {
      const first = createProcessLock(root);
      assert.throws(() => createProcessLock(root), (error) => error.code === "ALREADY_RUNNING");
      first.release();
      const second = createProcessLock(root);
      second.release();
      assert.equal(fs.existsSync(path.join(root, "rerouted.pid")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("replaces a stale PID lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-lock-"));
    try {
      fs.writeFileSync(path.join(root, "rerouted.pid"), "999999999\n", { mode: 0o600 });
      const lock = createProcessLock(root);
      assert.equal(Number(fs.readFileSync(lock.path, "utf8").trim()), process.pid);
      lock.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
