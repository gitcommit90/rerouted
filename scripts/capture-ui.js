#!/usr/bin/env node
/**
 * Offscreen UI capture harness for ReRouted.
 *   npx electron scripts/capture-ui.js [outDir]
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain } = require("electron");

const { createStore } = require("../src/lib/store");
const { generateApiKey } = require("../src/lib/password");
const { KEYED_PRESETS, ONBOARDING_STEPS, DEFAULT_PORT, OAUTH } = require("../src/lib/constants");
const { defaultModelsForType } = require("../src/lib/providers");
const { publicCombo } = require("../src/lib/combos");
const packageInfo = require("../package.json");

const cliArgs = process.argv
  .slice(1)
  .filter((arg) => !arg.startsWith("-") && path.resolve(arg) !== __filename);
const outDir = cliArgs[0] || path.join(process.cwd(), "capture-out");
const userData =
  process.env.REROUTED_USER_DATA || path.join(app.getPath("temp"), "rerouted-capture");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const store = createStore(path.join(userData, "config.json"));
const demoStartedAt = Date.now();

function demoStats() {
  const now = demoStartedAt;
  return {
    totalRequests: 1284,
    sessionRequests: 12,
    recent: [
      {
        at: now - 42_000,
        model: "coding",
        providerName: "ChatGPT Plus",
        status: 200,
        stream: true,
        prompt_tokens: 1240,
        completion_tokens: 386,
      },
      {
        at: now - 8 * 60_000,
        model: "claude/claude-sonnet-4-5",
        providerName: "Claude Pro",
        status: 200,
        stream: false,
        prompt_tokens: 812,
        completion_tokens: 221,
      },
    ],
  };
}

function demoUsage(period = "24h") {
  const now = Date.now();
  return {
    period,
    requests: 148,
    ok: 143,
    errors: 5,
    prompt_tokens: 1_486_000_000,
    completion_tokens: 661_000_000,
    cached_tokens: 483_648,
    total_tokens: 2_147_483_648,
    byModel: [
      { model: "coding", requests: 92, prompt_tokens: 121_000, completion_tokens: 42_300 },
      { model: "chatgpt/gpt-5", requests: 38, prompt_tokens: 45_800, completion_tokens: 13_100 },
      { model: "claude/claude-sonnet-4-5", requests: 18, prompt_tokens: 17_400, completion_tokens: 6_080 },
    ],
    byProvider: [
      { provider: "ChatGPT Plus", requests: 116, prompt_tokens: 151_000, completion_tokens: 50_200 },
      { provider: "Claude Pro", requests: 32, prompt_tokens: 33_200, completion_tokens: 11_280 },
    ],
    recent: [
      {
        at: now - 42_000,
        model: "coding",
        providerName: "ChatGPT Plus",
        status: 200,
        prompt_tokens: 1240,
        completion_tokens: 386,
      },
      {
        at: now - 8 * 60_000,
        model: "claude/claude-sonnet-4-5",
        providerName: "Claude Pro",
        status: 200,
        prompt_tokens: 812,
        completion_tokens: 221,
      },
      {
        at: now - 21 * 60_000,
        model: "coding",
        providerName: "Claude Pro",
        status: 429,
        prompt_tokens: 530,
        completion_tokens: 0,
      },
    ],
  };
}

let demoLogEntries = [
  { at: Date.now() - 35_000, level: "info", msg: "Gateway request completed", meta: { route: "coding", status: 200 } },
  { at: Date.now() - 7 * 60_000, level: "info", msg: "OAuth token refreshed", meta: { provider: "ChatGPT Plus" } },
  { at: Date.now() - 19 * 60_000, level: "warn", msg: "Account capacity exhausted; trying next route member", meta: { route: "coding" } },
  { at: Date.now() - 47 * 60_000, level: "info", msg: "Local gateway listening", meta: { host: "127.0.0.1", port: DEFAULT_PORT } },
];
let keyedProviderAdds = [];
let oauthCancels = [];
let oauthStartsInFlight = 0;
let oauthCancelRaces = 0;
let updateState = {
  status: "current",
  currentVersion: packageInfo.version,
  version: null,
  checkedAt: Date.now(),
  error: null,
};

function seedOnboarded() {
  const now = Date.now();
  const chatgptModel = OAUTH.chatgpt.models[0];
  const claudeModel = OAUTH.claude.models[0];
  store.seed({
    onboardingComplete: true,
    onboardingStep: "done",
    adminPasswordHash: null,
    openAtLogin: true,
    port: DEFAULT_PORT,
    apiKey: "rr-capturedemokey0000000000000000",
    serverEnabled: true,
    providers: [
      {
        id: "prov_chatgpt_demo",
        type: "chatgpt",
        name: "ChatGPT Plus",
        email: "fantasticfox@gmail.com",
        enabled: true,
        models: OAUTH.chatgpt.models,
        accessToken: "x",
        createdAt: now - 86_400_000,
      },
      {
        id: "prov_claude_demo",
        type: "claude",
        name: "Claude Pro",
        profileName: "Route Fox",
        enabled: true,
        models: OAUTH.claude.models,
        accessToken: "x",
        createdAt: now - 43_200_000,
      },
      {
        id: "prov_antigravity_demo",
        type: "antigravity",
        name: "Antigravity (gravitypilot@example.com)",
        email: "gravitypilot@example.com",
        enabled: true,
        models: OAUTH.antigravity.models,
        accessToken: "x",
        createdAt: now - 21_600_000,
      },
      {
        id: "prov_xai_demo",
        type: "xai",
        name: "xAI (Grok)",
        enabled: true,
        models: OAUTH.xai.models,
        accessToken: "x",
        createdAt: now - 10_800_000,
      },
    ],
    combos: [
      {
        id: "combo_demo",
        name: "coding",
        strategy: "fallback",
        members: [
          { providerId: "prov_chatgpt_demo", model: chatgptModel.id },
          { providerId: "prov_claude_demo", model: claudeModel.id },
        ],
        createdAt: now,
      },
    ],
  });
}

function registerIpc() {
  ipcMain.handle("app:get-state", async () => {
    const cfg = store.load();
    const publicProviders = (cfg.providers || []).map((p) => ({
      id: p.id,
      type: p.type,
      name: p.name,
      accountAlias: p.accountAlias || null,
      email: p.email,
      profileName: p.profileName,
      enabled: p.enabled !== false,
      hasToken: !!(p.accessToken || p.apiKey),
      models: p.models || defaultModelsForType(p.type),
      baseUrl: p.baseUrl,
    }));
    return {
      onboardingComplete: !!cfg.onboardingComplete,
      appVersion: packageInfo.version,
      update: updateState,
      onboardingStep: cfg.onboardingStep || "permissions",
      openAtLogin: !!cfg.openAtLogin,
      port: cfg.port || DEFAULT_PORT,
      apiKey: cfg.apiKey,
      apiKeys: cfg.apiKeys || [],
      bindHost: cfg.bindHost || "127.0.0.1",
      endpoint: `http://127.0.0.1:${cfg.port || DEFAULT_PORT}/v1`,
      listenHint: "Listening on localhost only. Switch bind to All interfaces in Settings for Tailscale.",
      serverEnabled: cfg.serverEnabled !== false,
      serverListening: true,
      providers: publicProviders,
      combos: (cfg.combos || []).map(publicCombo),
      stats: demoStats(),
      usage: demoUsage(),
      unlocked: true,
      hasAdminPassword: false,
      oauthProviders: Object.keys(OAUTH).map((k) => ({ id: k, name: OAUTH[k].name })),
      keyedPresets: Object.values(KEYED_PRESETS),
      steps: ONBOARDING_STEPS,
    };
  });
  ipcMain.handle("app:set-onboarding-step", async (_e, step) => {
    store.update((c) => {
      c.onboardingStep = step;
      c.onboardingComplete = step === "done";
    });
    return { ok: true };
  });
  ipcMain.handle("app:complete-onboarding", async () => {
    store.update((c) => {
      c.onboardingComplete = true;
      c.onboardingStep = "done";
    });
    return { ok: true };
  });
  ipcMain.handle("app:set-open-at-login", async () => ({ ok: true }));
  ipcMain.handle("app:set-admin-password", async () => ({ ok: true }));
  ipcMain.handle("app:verify-admin-password", async () => ({ ok: true }));
  ipcMain.handle("app:change-admin-password", async () => ({ ok: true }));
  ipcMain.handle("app:detect-providers", async () => ({
    ok: true,
    found: [
      {
        id: "det1",
        type: "chatgpt",
        name: "ChatGPT",
        source: "codex-cli",
        hasAccess: true,
        hasRefresh: true,
      },
      {
        id: "det2",
        type: "antigravity",
        name: "Antigravity (user@example.com)",
        source: "antigravity-file",
        email: "user@example.com",
        hasAccess: true,
        hasRefresh: true,
      },
    ],
  }));
  ipcMain.handle("app:import-detected", async () => ({ ok: true }));
  ipcMain.handle("app:oauth-start", async () => {
    oauthStartsInFlight += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    oauthStartsInFlight -= 1;
    return { ok: true, authUrl: "https://example.com" };
  });
  ipcMain.handle("app:oauth-cancel", async (_event, type) => {
    if (oauthStartsInFlight) oauthCancelRaces += 1;
    oauthCancels.push(type);
    return { ok: true };
  });
  ipcMain.handle("app:oauth-status", async () => ({ active: false }));
  ipcMain.handle("app:oauth-complete", async () => ({
    ok: true,
    account: { id: "x", type: "claude", name: "Claude" },
  }));
  ipcMain.handle("app:add-keyed-provider", async (_event, payload) => {
    keyedProviderAdds.push(payload);
    return { ok: true };
  });
  ipcMain.handle("harness:keyed-provider-adds", async () => keyedProviderAdds);
  ipcMain.handle("harness:oauth-cancels", async () => oauthCancels);
  ipcMain.handle("harness:oauth-cancel-races", async () => oauthCancelRaces);
  ipcMain.handle("app:test-keyed-provider", async () => ({
    ok: true,
    models: [{ id: "test-model", name: "Test" }],
  }));
  ipcMain.handle("app:quota-get", async () => ({
    ok: true,
    quota: {
      refreshedAt: Date.now(),
      refreshing: false,
      accounts: [
        {
          providerId: "demo",
          type: "chatgpt",
          name: "ChatGPT (fantasticfox@gmail.com)",
          accountAlias: "oauth1",
          email: "fantasticfox@gmail.com",
          status: "ok",
          source: "ChatGPT quota API",
          plan: "plus",
          refreshedAt: Date.now(),
          windows: [
            { id: "session", label: "Session", usedPercent: 63, resetsAt: Date.now() + 2 * 3600_000 },
            { id: "weekly", label: "Weekly", usedPercent: 28, resetsAt: Date.now() + 4 * 86400_000 },
          ],
          credits: { balance: 42, unlimited: false, hasCredits: true },
        },
      ],
    },
  }));
  ipcMain.handle("app:quota-refresh", async () => ({
    ok: true,
    quota: {
      refreshedAt: Date.now(),
      refreshing: false,
      accounts: [],
    },
  }));
  ipcMain.handle("app:usage", async (_e, period) => ({
    ok: true,
    usage: demoUsage(period || "24h"),
    stats: demoStats(),
  }));
  ipcMain.handle("app:logs-get", async (_e, limit = 250) => ({
    ok: true,
    file: "~/Library/Logs/ReRouted/rerouted.log",
    entries: demoLogEntries.slice(0, Number(limit) || 250),
  }));
  ipcMain.handle("app:logs-clear", async () => {
    demoLogEntries = [];
    return { ok: true };
  });
  ipcMain.handle("app:logs-reveal", async () => ({ ok: true }));
  ipcMain.handle("app:remove-provider", async () => ({ ok: true }));
  ipcMain.handle("app:set-provider-enabled", async () => ({ ok: true }));
  ipcMain.handle("app:save-combo", async () => ({
    ok: true,
    combos: store.load().combos.map(publicCombo),
  }));
  ipcMain.handle("app:delete-combo", async () => ({ ok: true }));
  ipcMain.handle("app:set-server-enabled", async () => ({ ok: true }));
  ipcMain.handle("app:open-external", async () => ({ ok: true }));
  ipcMain.handle("app:update-check", async () => {
    updateState = { ...updateState, status: "checking", error: null };
    return { ok: true, update: updateState };
  });
  ipcMain.handle("app:update-install", async () => ({ ok: true, update: updateState }));
  ipcMain.handle("harness:set-update-state", async (_event, next) => {
    updateState = { ...updateState, ...next };
    return { ok: true, update: updateState };
  });
  ipcMain.handle("app:hide-panel", async () => ({ ok: true }));
  ipcMain.handle("app:quit", async () => {});
  ipcMain.handle("app:regenerate-key", async () => ({ ok: true, apiKey: generateApiKey() }));
  ipcMain.handle("harness:goto", async (_e, step) => {
    if (step === "app" || step === "home") {
      seedOnboarded();
      return { ok: true, page: "home" };
    }
    store.update((c) => {
      c.onboardingComplete = false;
      c.onboardingStep = step;
      if (step !== "permissions" && step !== "admin-password") {
        c.adminPasswordHash = c.adminPasswordHash || "harness";
      }
    });
    return { ok: true, step };
  });
}

const ONBOARD_STEPS = [
  "permissions",
  "admin-password",
  "welcome",
  "auto-detect",
  "oauth-providers",
  "api-keys",
  "endpoint-ready",
  "tutorial",
  "first-combo",
];
const APP_PAGES = ["home", "providers", "combos", "quota", "stats", "logs", "settings"];

app.whenReady().then(async () => {
  registerIpc();
  seedOnboarded();

  const win = new BrowserWindow({
    width: 420,
    height: 700,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "..", "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,
    },
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log("renderer", level, `${sourceId}:${line}`, message);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("renderer process gone", details);
  });
  win.webContents.setFrameRate(15);
  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1000);

  async function settle(selector = "#view > *", scrollSelector = null) {
    const result = await win.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 5000;
        while (!window.__rr_boot && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!window.__rr_boot) throw new Error("Renderer boot hook did not become ready");
        while (!document.querySelector(${JSON.stringify(selector)}) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!document.querySelector(${JSON.stringify(selector)})) {
          throw new Error("Capture selector not found: " + ${JSON.stringify(selector)});
        }
        if (document.fonts?.ready) await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const root = document.getElementById("view");
        root.scrollTop = 0;
        const text = (root.textContent || "").trim();
        if (!text) throw new Error("Capture view rendered empty");
        return { textLength: text.length, htmlLength: root.innerHTML.length };
      })()
    `);
    if (scrollSelector) {
      await win.webContents.executeJavaScript(`
        (() => {
          const root = document.getElementById("view");
          const target = document.querySelector(${JSON.stringify(scrollSelector)});
          if (root && target) {
            target.scrollIntoView({ block: "start" });
            root.scrollTop = Math.max(0, root.scrollTop - 12);
          }
          return true;
        })()
      `);
    }
    win.webContents.invalidate();
    await sleep(150);
    return result;
  }

  async function capture(name, selector, scrollSelector = null) {
    const ready = await settle(selector, scrollSelector);
    const img = await win.webContents.capturePage();
    const file = path.join(outDir, name);
    fs.writeFileSync(file, img.toPNG());
    console.log("captured", path.basename(file), ready);
  }

  const steps = (process.env.CAPTURE_STEPS || ONBOARD_STEPS.join(",")).split(",").filter(Boolean);
  const pages = (process.env.CAPTURE_PAGES || APP_PAGES.join(",")).split(",").filter(Boolean);

  for (const step of steps) {
    await win.webContents.executeJavaScript(`
      (async () => {
        await window.rerouted.invoke("harness:goto", ${JSON.stringify(step)});
        if (!window.__rr_boot) throw new Error("Renderer boot hook unavailable");
        await window.__rr_boot();
        return true;
      })()
    `);
    await sleep(500);
    // For auto-detect, click scan to show results state
    if (step === "auto-detect") {
      await win.webContents.executeJavaScript(`
        (async () => {
          const b = document.getElementById("btn-scan");
          if (b) { b.click(); await new Promise(r => setTimeout(r, 400)); }
          const results = document.getElementById("detect-results");
          if (!results?.textContent.includes("use*@example.com")) {
            throw new Error("Detected account email was not privacy masked");
          }
          if (results.outerHTML.includes("user@example.com")) {
            throw new Error("Raw detected account email leaked into onboarding markup");
          }
          return true;
        })()
      `);
      await sleep(400);
    }
    await capture(`onboard-${step}.png`, "#view > *");
  }

  seedOnboarded();
  await win.webContents.executeJavaScript(`
    (async () => {
      await window.rerouted.invoke("harness:goto", "home");
      if (!window.__rr_boot) throw new Error("Renderer boot hook unavailable");
      await window.__rr_boot();
      return true;
    })()
  `);
  await sleep(500);

  for (const p of pages) {
    await win.webContents.executeJavaScript(`
      (() => {
        if (window.__rr_goto_page) window.__rr_goto_page(${JSON.stringify(p)});
        else {
          const btn = [...document.querySelectorAll(".nav-btn")].find(b => b.dataset.page === ${JSON.stringify(p)});
          if (btn) btn.click();
        }
        return true;
      })()
    `);
    const selector = {
      home: ".hero-surface",
      providers: "[data-prov-card]",
      combos: ".route-card",
      quota: ".quota-card",
      stats: "#u-period",
      logs: "#log-box",
      settings: ".settings-group",
    }[p] || "#view > *";
    await capture(`app-${p}.png`, selector);
    if (p === "home") {
      await win.webContents.executeJavaScript(`
        (() => {
          const value = document.querySelector("[data-home-tokens]")?.textContent.trim();
          if (value !== "2.1B") throw new Error("Unexpected billion token format: " + value);
          return true;
        })()
      `);
    }
    if (p === "stats") {
      await win.webContents.executeJavaScript(`
        (() => {
          const metrics = [...document.querySelectorAll(".metric")];
          const tokens = metrics.find((metric) => metric.querySelector(".metric-label")?.textContent.trim() === "Tokens");
          const value = tokens?.querySelector(".metric-value")?.textContent.trim();
          if (value !== "2.1B") throw new Error("Unexpected activity token format: " + value);
          return true;
        })()
      `);
    }
    if (p === "providers") {
      await win.webContents.executeJavaScript(`
        (() => {
          const chatgpt = document.querySelector('[data-prov-card="prov_chatgpt_demo"]');
          const claude = document.querySelector('[data-prov-card="prov_claude_demo"]');
          const antigravity = document.querySelector('[data-prov-card="prov_antigravity_demo"]');
          const xai = document.querySelector('[data-prov-card="prov_xai_demo"]');
          if (!chatgpt || !claude || !antigravity || !xai) {
            throw new Error("Identity fixtures did not render");
          }
          if (!chatgpt.querySelector(".row-sub")?.textContent.includes("fant********@gmail.com")) {
            throw new Error("Account email was not privacy masked");
          }
          if (antigravity.querySelector(".row-title")?.textContent.trim() !== "Antigravity") {
            throw new Error("Email suffix was not removed from Antigravity account name");
          }
          if (!antigravity.querySelector(".row-sub")?.textContent.includes("grav********@example.com")) {
            throw new Error("Antigravity account email was not privacy masked");
          }
          if (!claude.querySelector(".row-sub")?.textContent.includes("Route Fox")) {
            throw new Error("Profile name was not used when account email was unavailable");
          }
          const markup = chatgpt.outerHTML + antigravity.outerHTML;
          if (markup.includes("fantasticfox@gmail.com") || markup.includes("gravitypilot@example.com")) {
            throw new Error("Raw account email leaked into provider markup");
          }
          if (!chatgpt.querySelector(".alias-badge")?.textContent.includes("Account 1")) {
            throw new Error("OAuth account alias was not preserved");
          }
          if (!xai.querySelector(".row-sub")?.textContent.includes("Account 1")) {
            throw new Error("OAuth alias was not used when account identity was unavailable");
          }
          if (xai.querySelector(".account-copy")?.textContent.includes("prov_")) {
            throw new Error("Internal provider id leaked into account copy");
          }
          return true;
        })()
      `);
    }
    if (p === "quota") {
      await win.webContents.executeJavaScript(`
        (() => {
          const card = document.querySelector(".quota-card");
          if (!card?.textContent.includes("fant********@gmail.com")) {
            throw new Error("Quota account email was not privacy masked");
          }
          if (card.querySelector(".row-title")?.textContent.trim() !== "ChatGPT") {
            throw new Error("Email suffix was not removed from quota account name");
          }
          if (card.outerHTML.includes("fantasticfox@gmail.com")) {
            throw new Error("Raw account email leaked into quota markup");
          }
          if (!card.querySelector(".alias-badge")?.textContent.includes("Account 1")) {
            throw new Error("Quota OAuth account alias was not preserved");
          }
          return true;
        })()
      `);
    }
  }

  await win.webContents.executeJavaScript(`
    (() => {
      window.__rr_goto_page("home");
      return true;
    })()
  `);
  await sleep(1300);
  await win.webContents.executeJavaScript(`
    (() => {
      const details = document.querySelector("[data-home-credentials]");
      const routeMap = document.querySelector("[data-home-route-map]");
      const track = routeMap?.querySelector(".route-track");
      const copyButton = document.getElementById("copy-url");
      if (!details || !routeMap || !track || !copyButton) {
        throw new Error("Status persistence controls did not render");
      }
      details.open = true;
      copyButton.focus();
      window.__rr_home_poll_test = { routeMap, track, copyButton, animationStarts: 0 };
      routeMap.addEventListener("animationstart", () => {
        window.__rr_home_poll_test.animationStarts += 1;
      });
      return true;
    })()
  `);
  await sleep(2300);
  await win.webContents.executeJavaScript(`
    (() => {
      const test = window.__rr_home_poll_test;
      const details = document.querySelector("[data-home-credentials]");
      if (document.querySelector("[data-home-route-map] .route-track") !== test.track) {
        throw new Error("Status polling replaced the route animation DOM");
      }
      if (!details?.open) throw new Error("Status polling collapsed Credentials and network");
      if (document.activeElement !== test.copyButton) {
        throw new Error("Status polling moved focus away from the endpoint controls");
      }
      if (test.animationStarts !== 0) {
        throw new Error("Status polling restarted the route animation without new traffic");
      }
      return true;
    })()
  `);

  await win.webContents.executeJavaScript(`
    (() => {
      window.__rr_goto_page("providers");
      document.querySelector("[data-expand]")?.click();
      return true;
    })()
  `);
  await capture("app-providers-expanded.png", ".provider-detail");

  await win.webContents.executeJavaScript(`
    (async () => {
      const reconnect = document.querySelector("[data-reauth]");
      reconnect?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const panel = document.querySelector("#add-panel .action-panel");
      const viewport = document.getElementById("view").getBoundingClientRect();
      const rect = panel?.getBoundingClientRect();
      if (!panel || !rect || rect.top < viewport.top || rect.top >= viewport.bottom) {
        throw new Error("Reconnect panel was not brought into view");
      }
      if (document.activeElement !== panel.querySelector("[data-panel-heading]")) {
        throw new Error("Reconnect panel did not receive accessible focus");
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (document.querySelector("#add-panel .action-panel")) {
        throw new Error("Escape did not dismiss reconnect panel");
      }
      if (document.activeElement !== reconnect) {
        throw new Error("Reconnect dismissal did not restore focus");
      }
      const cancels = await window.rerouted.invoke("harness:oauth-cancels");
      if (cancels.length !== 1 || cancels[0] !== "chatgpt") {
        throw new Error("Reconnect dismissal did not cancel the pending OAuth flow");
      }
      return true;
    })()
  `);

  await win.webContents.executeJavaScript(`
    (async () => {
      window.__rr_goto_page("providers");
      if (document.querySelector(".provider-detail")) {
        document.querySelector("[data-expand]")?.click();
      }
      document.getElementById("btn-connect")?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const panel = document.querySelector("#add-panel .action-panel");
      const viewport = document.getElementById("view").getBoundingClientRect();
      const rect = panel?.getBoundingClientRect();
      if (!panel || !rect || rect.top < viewport.top || rect.bottom > viewport.bottom + 1) {
        throw new Error("Connect options were not brought into view");
      }
      if (document.activeElement !== panel.querySelector("[data-panel-heading]")) {
        throw new Error("Connect panel did not receive accessible focus");
      }
      return true;
    })()
  `);
  await capture("app-providers-connect.png", "#add-panel .action-panel", "#add-panel .action-panel");

  await win.webContents.executeJavaScript(`
    (async () => {
      const opener = document.getElementById("btn-connect");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (document.querySelector("#add-panel .action-panel")) {
        throw new Error("Escape did not dismiss Connect panel");
      }
      if (document.activeElement !== opener) {
        throw new Error("Connect dismissal did not restore focus");
      }
      opener.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      document.querySelector("#add-panel .tile")?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const oauth = document.querySelector("#add-panel .action-panel");
      const cancel = oauth?.querySelector("[data-panel-cancel]");
      if (!oauth || !cancel) {
        throw new Error("OAuth panel was not dismissible while connection startup was pending");
      }
      cancel.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (document.querySelector("#add-panel .action-panel") || document.activeElement !== opener) {
        throw new Error("OAuth Cancel did not dismiss and restore focus");
      }
      const deadline = Date.now() + 1000;
      let cancels = await window.rerouted.invoke("harness:oauth-cancels");
      while (cancels.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        cancels = await window.rerouted.invoke("harness:oauth-cancels");
      }
      if (cancels.length !== 2 || cancels[1] !== "chatgpt") {
        throw new Error("OAuth dismissal did not cancel the pending flow");
      }
      const cancelRaces = await window.rerouted.invoke("harness:oauth-cancel-races");
      if (cancelRaces !== 0) {
        throw new Error("OAuth dismissal raced callback-session creation");
      }
      opener.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    })()
  `);

  await win.webContents.executeJavaScript(`
    (async () => {
      document.getElementById("btn-key")?.click();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const labels = [...document.querySelectorAll("[data-keyed-preset]")].map((button) =>
        (button.textContent || "").trim()
      );
      const expected = ["OpenRouter", "NVIDIA NIM", "Cloudflare", "GLM Coding", "Custom"];
      if (JSON.stringify(labels) !== JSON.stringify(expected)) {
        throw new Error("Post-onboarding keyed presets did not render: " + labels.join(", "));
      }
      const panel = document.querySelector("#add-panel .action-panel");
      if (!panel?.querySelector("[data-panel-cancel]")) {
        throw new Error("API key panel did not render a Cancel action");
      }
      if (document.activeElement !== panel.querySelector("[data-panel-heading]")) {
        throw new Error("API key panel did not receive accessible focus");
      }
      return labels;
    })()
  `);
  await capture(
    "app-providers-api-key.png",
    "#add-panel [data-keyed-preset-grid]",
    "#add-panel .action-panel"
  );
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('[data-keyed-preset="cloudflare"]')?.click();
      if (!document.querySelector('[data-keyed-field="account"]')) {
        throw new Error("Cloudflare preset did not request an account ID");
      }
      document.querySelector('[data-keyed-preset="custom"]')?.click();
      if (
        !document.querySelector('[data-keyed-field="name"]') ||
        !document.querySelector('[data-keyed-field="base"]') ||
        !document.querySelector('[data-keyed-field="model"]')
      ) {
        throw new Error("Custom provider fields did not render");
      }
      return true;
    })()
  `);
  await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('[data-keyed-preset="openrouter"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const selected = document.querySelector('[data-keyed-preset="openrouter"]');
      const form = document.querySelector('[data-keyed-form] .card');
      const viewport = document.getElementById("view").getBoundingClientRect();
      const formRect = form?.getBoundingClientRect();
      if (!selected?.classList.contains("selected")) {
        throw new Error("Selected API preset was not highlighted");
      }
      if (!formRect || formRect.top < viewport.top || formRect.bottom > viewport.bottom + 1) {
        throw new Error("Selected API preset form was not brought into view");
      }
      return true;
    })()
  `);
  await capture(
    "app-providers-api-key-form.png",
    "#add-panel [data-keyed-form] .card",
    "#add-panel .action-panel"
  );
  await win.webContents.executeJavaScript(`
    (async () => {
      const key = document.querySelector('[data-keyed-field="key"]');
      const test = document.querySelector('[data-keyed-action="test"]');
      const add = document.querySelector('[data-keyed-action="add"]');
      key.value = "first-key";
      key.dispatchEvent(new Event("input", { bubbles: true }));
      test.click();
      let deadline = Date.now() + 2000;
      while (test.disabled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (test.disabled) throw new Error("Preset test did not finish");
      if (add.disabled) throw new Error("Successful preset test did not enable Add");

      key.value = "second-key";
      key.dispatchEvent(new Event("input", { bubbles: true }));
      if (!add.disabled) throw new Error("Editing a tested API key did not invalidate Add");
      test.click();
      deadline = Date.now() + 2000;
      while (test.disabled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (test.disabled) throw new Error("Retest did not finish");
      add.click();
      add.click();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const adds = await window.rerouted.invoke("harness:keyed-provider-adds");
      if (adds.length !== 1) throw new Error("Preset Add was not single-flight");
      if (
        adds[0].preset !== "openrouter" ||
        adds[0].baseUrl !== "https://openrouter.ai/api/v1" ||
        adds[0].apiKey !== "second-key"
      ) {
        throw new Error("OpenRouter preset payload was incorrect: " + JSON.stringify(adds[0]));
      }
      return true;
    })()
  `);

  await win.webContents.executeJavaScript(`
    (() => {
      window.__rr_goto_page("combos");
      document.querySelector("button[data-edit]")?.click();
      return true;
    })()
  `);
  await capture("app-combos-editor.png", ".route-editor", ".route-editor");

  await win.webContents.executeJavaScript(`
    (() => {
      window.__rr_goto_page("settings");
      return true;
    })()
  `);
  await capture("app-settings-about.png", ".publisher-note", ".publisher-note");

  await win.webContents.executeJavaScript(`
    (async () => {
      const cases = [
        ["checking", "Checking…", true],
        ["downloading", "Downloading…", true],
        ["ready", "Restart & install", false],
        ["error", "Try again", false]
      ];
      for (const [status, label, disabled] of cases) {
        await window.rerouted.invoke("harness:set-update-state", {
          status,
          version: status === "ready" ? "0.3.2" : null,
          error: status === "error" ? "The update service could not be reached." : null
        });
        await window.__rr_boot();
        window.__rr_goto_page("settings");
        const button = document.getElementById("btn-update");
        if ((button?.textContent || "").trim() !== label || button.disabled !== disabled) {
          throw new Error("Update UI state did not render correctly: " + status);
        }
      }
      await window.rerouted.invoke("harness:set-update-state", {
        status: "ready",
        version: "0.3.2",
        error: null
      });
      await window.__rr_boot();
      window.__rr_goto_page("settings");
      return true;
    })()
  `);
  await capture("app-settings-update-ready.png", ".update-row", ".update-row");

  console.log("done", outDir);
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
