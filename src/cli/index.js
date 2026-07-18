#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHeadlessRuntime, createProcessLock, defaultUserData } = require("../lib/headless-runtime");
const { createPrompts } = require("./prompts");
const { runFirstSetup } = require("./setup");
const packageJson = require("../../package.json");

const HELP = `ReRouted ${packageJson.version}

Usage:
  rerouted [start] [options]    Run the gateway and dashboard
  rerouted paths               Show local data paths
  rerouted help                Show this help

Options:
  --host <address>             Override the configured bind address
  --port <number>              Override the configured port
  --data-dir <path>            Store config, usage, and logs in this directory
  --no-interactive             Skip the terminal setup wizard
  --version                    Print the installed version
  --help                       Show this help

Running "rerouted" for the first time opens an interactive setup in your
terminal. The same setup and full control plane are served at /dashboard/.
`;

function parseArgs(argv) {
  const result = {
    command: "start",
    host: null,
    port: null,
    dataDir: null,
    interactive: true,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) result.command = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") result.command = "help";
    else if (arg === "--version" || arg === "-v") result.command = "version";
    else if (arg === "--no-interactive") result.interactive = false;
    else if (arg === "--host") result.host = args[++index];
    else if (arg === "--port") result.port = Number(args[++index]);
    else if (arg === "--data-dir") result.dataDir = args[++index];
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.includes("--host") && !result.host) throw new Error("--host requires an address");
  if (args.includes("--port") && !Number.isFinite(result.port)) throw new Error("--port requires a number");
  if (args.includes("--data-dir") && !result.dataDir) throw new Error("--data-dir requires a path");
  if (result.host === "localhost") result.host = "127.0.0.1";
  if (result.host && !["127.0.0.1", "0.0.0.0"].includes(result.host)) {
    throw new Error("--host must be 127.0.0.1, localhost, or 0.0.0.0");
  }
  if (result.port != null && (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535)) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  if (result.dataDir) result.dataDir = path.resolve(result.dataDir);
  return result;
}

function pathsFor(userData) {
  return {
    data: userData,
    config: path.join(userData, "config.json"),
    usage: path.join(userData, "usage.sqlite"),
    logs: path.join(userData, "rerouted.log"),
  };
}

async function run(argv = process.argv.slice(2), io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const errorOutput = io.error || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    errorOutput.write(`${error.message}\nRun "rerouted help" for usage.\n`);
    return 2;
  }

  if (options.command === "help") {
    output.write(HELP);
    return 0;
  }
  if (options.command === "version") {
    output.write(`${packageJson.version}\n`);
    return 0;
  }

  const userData = options.dataDir || defaultUserData();
  if (options.command === "paths") {
    const paths = pathsFor(userData);
    for (const [label, value] of Object.entries(paths)) output.write(`${label.padEnd(7)} ${value}\n`);
    return 0;
  }
  if (options.command !== "start") {
    errorOutput.write(`Unknown command: ${options.command}\nRun "rerouted help" for usage.\n`);
    return 2;
  }

  let processLock;
  try {
    processLock = createProcessLock(userData);
  } catch (error) {
    errorOutput.write(`${error.message}\n`);
    return error.code === "ALREADY_RUNNING" ? 3 : 1;
  }

  let stopping = false;
  let runtime;
  let prompts;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    prompts?.close();
    try {
      await runtime?.close();
    } finally {
      processLock.release();
    }
  };

  runtime = createHeadlessRuntime({
    userData,
    version: packageJson.version,
    onQuit: stop,
  });

  try {
    const address = await runtime.start({ port: options.port, host: options.host });
    output.write(`\nReRouted ${packageJson.version}\n`);
    output.write(`Gateway   ${address.endpoint}\n`);
    output.write(`Dashboard ${address.dashboard}\n`);
    output.write(`Data      ${userData}\n`);

    const firstRun = !runtime.store.load().onboardingComplete;
    const interactive = options.interactive && input.isTTY === true && output.isTTY === true;
    if (firstRun && interactive) {
      prompts = createPrompts({ input, output });
      await runFirstSetup({
        prompts,
        controlPlane: runtime.controlPlane,
        dashboardUrl: address.dashboard,
        output,
      });
      prompts.close();
      prompts = null;
    } else if (firstRun) {
      output.write(
        `\nFirst-time setup is waiting at ${address.dashboard}\n` +
          "Open it from this machine, or restart ReRouted in an interactive terminal.\n"
      );
    } else {
      output.write("\nReRouted is ready. Press Ctrl+C to stop.\n");
    }

    if (io.waitForSignal === false) {
      await stop();
      return 0;
    }

    await new Promise((resolve) => {
      const finish = () => resolve();
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      process.once("SIGHUP", finish);
    });
    output.write("\nStopping ReRouted…\n");
    await stop();
    return 0;
  } catch (error) {
    errorOutput.write(`ReRouted could not start: ${error.message}\n`);
    await stop();
    return 1;
  }
}

if (require.main === module) {
  run().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { HELP, parseArgs, pathsFor, run };
