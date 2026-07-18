#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { createHeadlessRuntime } = require("../src/lib/headless-runtime");
const { hashPassword } = require("../src/lib/password");
const { OAUTH } = require("../src/lib/constants");

const outputArg = process.argv.find((value) => /\.png$/i.test(value));
const output = path.resolve(outputArg || path.join(process.cwd(), "dashboard-capture.png"));
const captureWidth = Number(process.env.DASHBOARD_CAPTURE_WIDTH) || 1200;
const captureHeight = Number(process.env.DASHBOARD_CAPTURE_HEIGHT) || 900;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-dashboard-capture-"));
app.commandLine.appendSwitch("disable-gpu");
if (process.getuid?.() === 0) app.commandLine.appendSwitch("no-sandbox");

app.whenReady().then(async () => {
  const runtime = createHeadlessRuntime({ userData, version: "capture" });
  runtime.store.seed({
    onboardingComplete: true,
    onboardingStep: "done",
    adminPasswordHash: await hashPassword("capture-password"),
    providers: [
      {
        id: "prov_chatgpt_capture",
        type: "chatgpt",
        name: "ChatGPT",
        accountAlias: "oauth1",
        profileName: "Primary account",
        accessToken: "capture-token",
        enabled: true,
        models: OAUTH.chatgpt.models,
        createdAt: Date.now() - 10_000,
      },
      {
        id: "prov_claude_capture",
        type: "claude",
        name: "Claude",
        accountAlias: "oauth1",
        profileName: "Fallback account",
        accessToken: "capture-token",
        enabled: true,
        models: OAUTH.claude.models,
        createdAt: Date.now() - 5_000,
      },
    ],
    combos: [
      {
        id: "combo_capture",
        name: "coding",
        strategy: "fallback",
        members: [
          { providerId: "prov_chatgpt_capture", model: OAUTH.chatgpt.models[0].id },
          { providerId: "prov_claude_capture", model: OAUTH.claude.models[0].id },
        ],
        createdAt: Date.now(),
      },
    ],
  });
  const address = await runtime.start({ port: 0, host: "127.0.0.1" });
  const win = new BrowserWindow({
    width: captureWidth,
    height: captureHeight,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
    },
  });
  await win.loadURL(address.dashboard);
  await win.webContents.executeJavaScript(`
    (async () => {
      const waitFor = async (selector) => {
        const deadline = Date.now() + 5000;
        while (!document.querySelector(selector) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!document.querySelector(selector)) throw new Error("Missing " + selector);
      };
      await waitFor("#lock-pw");
      document.querySelector("#lock-pw").value = "capture-password";
      document.querySelector("#btn-unlock").click();
      await waitFor("[data-home-root]");
      await Promise.all([...document.images].map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              image.addEventListener("load", resolve, { once: true });
              image.addEventListener("error", resolve, { once: true });
            })
      ));
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()
  `);
  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, image.toPNG());
  console.log(output);
  win.destroy();
  await runtime.close();
  fs.rmSync(userData, { recursive: true, force: true });
  app.quit();
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
