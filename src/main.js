"use strict";

const path = require("node:path");
const fs = require("node:fs");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  autoUpdater,
  dialog,
  screen,
  powerMonitor,
} = require("electron");

const { createStore } = require("./lib/store");
const { createRouter } = require("./lib/router");
const { createGateway } = require("./lib/gateway");
const { createUsageStore } = require("./lib/usage");
const logger = require("./lib/logger");
const { hashPassword, verifyPassword, generateId, generateApiKey } = require("./lib/password");
const { detectAll, summarizeDetected } = require("./lib/detect");
const { startOAuth, completeOAuth, oauthStatus } = require("./lib/oauth");
const { createQuotaService } = require("./lib/quota");
const { createSessionAuth, isMacSessionActive } = require("./lib/session-auth");
const { runProviderModelTest } = require("./lib/model-test");
const { createUpdateService } = require("./lib/updater");
const { KEYED_PRESETS, ONBOARDING_STEPS, DEFAULT_PORT, OAUTH } = require("./lib/constants");
const openaiCompat = require("./lib/providers/openai-compat");
const { defaultModelsForType, listProviderModels, getAdapter } = require("./lib/providers");
const {
  publicCombo,
  comboMatchesId,
  publicRouteId,
  providerRouteIds,
  comboStorageIdConflict,
  comboNameConflict,
} = require("./lib/combos");

// ─── Paths / single instance ───────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const userData = process.env.REROUTED_USER_DATA || app.getPath("userData");
const configPath = path.join(userData, "config.json");
const usagePath = path.join(userData, "usage.json");
const logPath = path.join(userData, "rerouted.log");
logger.configure(logPath);
logger.info("ReRouted starting", { userData, logPath });

const store = createStore(configPath);
const usage = createUsageStore(usagePath);
const router = createRouter({ store, usage });
const gateway = createGateway({ store, router });
const sessionAuth = createSessionAuth();
const quota = createQuotaService({ store, refreshProvider: refreshProviderForQuota });

let tray = null;
let panel = null;
let lastBlurHide = 0;
let detectedCache = [];
let updateService = null;
let updatePromptShown = false;

function publishUpdateState(update) {
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send("app:update-state", update);
  }
  if (
    update.status !== "ready" ||
    updatePromptShown ||
    process.env.REROUTED_HEADLESS === "1"
  ) {
    return;
  }
  updatePromptShown = true;
  setTimeout(async () => {
    try {
      const version = update.version ? ` ${update.version}` : "";
      const result = await dialog.showMessageBox({
        type: "info",
        title: "ReRouted update ready",
        message: `ReRouted${version} is ready to install.`,
        detail: "Restart now to finish the update, or keep working and install it the next time ReRouted starts.",
        buttons: ["Restart and Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        await gateway.stop();
        updateService?.install();
      }
    } catch (error) {
      logger.error(`Could not show update prompt: ${error.message}`);
    }
  }, 0);
}

async function refreshProviderForQuota(provider) {
  const adapter = getAdapter(provider?.type);
  if (!adapter || !provider?.refreshToken || typeof adapter.refreshToken !== "function") {
    return provider;
  }
  const tokens = await adapter.refreshToken(provider);
  store.update((cfg) => {
    const saved = (cfg.providers || []).find((p) => p.id === provider.id);
    if (saved) Object.assign(saved, tokens);
  });
  return { ...provider, ...tokens };
}

function setMacSessionUnlocked(value) {
  sessionAuth.setMacSessionUnlocked(value);
  if (panel && !panel.isDestroyed()) {
    const cfg = store.load();
    const hasPassword = !!cfg.adminPasswordHash && cfg.adminPasswordHash !== "harness";
    panel.webContents.send("app:session-lock-changed", {
      unlocked: sessionAuth.isUnlocked(hasPassword),
    });
  }
}

// Dev / harness state jump
function applyStateEnv() {
  const st = process.env.REROUTED_STATE;
  if (!st) return;
  if (st === "fresh") {
    store.reset();
    sessionAuth.setManualUnlocked(true); // harness
    return;
  }
  if (st === "onboarded") {
    store.seed({
      onboardingComplete: true,
      onboardingStep: "done",
      adminPasswordHash: null, // harness skips lock
      openAtLogin: false,
      port: DEFAULT_PORT,
      apiKey: store.load().apiKey || generateApiKey(),
      serverEnabled: true,
      combos: [
        {
          id: "combo_demo",
          name: "demo-fallback",
          strategy: "fallback",
          members: [],
          createdAt: Date.now(),
        },
      ],
    });
    sessionAuth.setManualUnlocked(true);
    return;
  }
  if (st.startsWith("step:")) {
    const step = st.slice(5);
    store.seed({
      onboardingComplete: false,
      onboardingStep: step,
      adminPasswordHash: step === "permissions" || step === "admin-password" ? null : "harness",
    });
    sessionAuth.setManualUnlocked(true);
  }
}

function trayIcon() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath)
    : path.join(__dirname, "..", "resources");
  const p2 = path.join(base, "trayTemplate@2x.png");
  const p1 = path.join(base, "trayTemplate.png");
  const imgPath = fs.existsSync(p2) ? p2 : p1;
  const img = nativeImage.createFromPath(imgPath);
  img.setTemplateImage(true);
  return img;
}

function createPanel() {
  panel = new BrowserWindow({
    width: 420,
    height: 700,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: "panel",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.loadFile(path.join(__dirname, "renderer", "index.html"));

  panel.on("blur", () => {
    if (process.env.REROUTED_KEEP_OPEN === "1") return;
    lastBlurHide = Date.now();
    hidePanel();
  });

  panel.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      hidePanel();
      event.preventDefault();
    }
  });
}

function showPanel() {
  if (!panel) createPanel();
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });
  const winW = 420;
  const winH = 700;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winW / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 4);
  // Keep on screen
  const wa = display.workArea;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - winW - 8));
  if (y + winH > wa.y + wa.height) {
    y = Math.max(wa.y + 8, trayBounds.y - winH - 4);
  }
  panel.setPosition(x, y, false);
  panel.show();
  panel.focus();
}

function hidePanel() {
  if (panel && panel.isVisible()) panel.hide();
}

function togglePanel() {
  if (Date.now() - lastBlurHide < 250) return;
  if (panel && panel.isVisible()) hidePanel();
  else showPanel();
}

function updateTrayTitle() {
  if (!tray) return;
  const n = router.totalRequests;
  tray.setTitle(n > 0 ? ` ${n}` : "");
}

// ─── IPC ───────────────────────────────────────────────────────────────
function registerIpc() {
  function publicStats(stats, combos) {
    if (!stats) return stats;
    return {
      ...stats,
      recent: (stats.recent || []).map((entry) => ({
        ...entry,
        model: publicRouteId(combos, entry.model),
      })),
    };
  }

  function publicUsage(usage, combos) {
    if (!usage) return usage;
    return {
      ...usage,
      byModel: (usage.byModel || []).map((entry) => ({
        ...entry,
        model: publicRouteId(combos, entry.model),
      })),
      recent: (usage.recent || []).map((entry) => ({
        ...entry,
        model: publicRouteId(combos, entry.model),
      })),
    };
  }

  ipcMain.handle("app:get-state", async () => {
    const cfg = store.load();
    const publicProviders = (cfg.providers || []).map((p) => {
      const models = listProviderModels(p, { includeDisabled: true }).map((m) => ({
        id: m.upstreamModel,
        gatewayId: m.id,
        name: m.name,
        enabled: m.enabled !== false,
      }));
      return {
        id: p.id,
        type: p.type,
        name: p.name,
        accountAlias: p.accountAlias || null,
        email: p.email,
        enabled: p.enabled !== false,
        hasToken: !!(p.accessToken || p.apiKey),
        models,
        baseUrl: p.baseUrl,
      };
    });
    const port = cfg.port || DEFAULT_PORT;
    const bindHost = cfg.bindHost || "127.0.0.1";
    const apiKeys = (cfg.apiKeys || []).map((k) => ({
      id: k.id,
      name: k.name || "Key",
      key: k.key,
      enabled: k.enabled !== false,
      createdAt: k.createdAt,
    }));
    // Primary key for simple copy on Home / onboarding
    const primaryKey =
      apiKeys.find((k) => k.enabled !== false)?.key || cfg.apiKey || "";
    return {
      onboardingComplete: !!cfg.onboardingComplete,
      appVersion: app.getVersion(),
      update: updateService?.state() || {
        status: "idle",
        currentVersion: app.getVersion(),
        version: null,
        checkedAt: null,
        error: null,
      },
      onboardingStep: cfg.onboardingStep || "permissions",
      openAtLogin: !!cfg.openAtLogin,
      port,
      bindHost,
      apiKey: primaryKey,
      apiKeys,
      endpoint: `http://127.0.0.1:${port}/v1`,
      // When bound to all interfaces, tools on other Tailscale nodes can use this host's tailnet IP
      listenHint:
        bindHost === "0.0.0.0"
          ? "Listening on all interfaces (LAN / Tailscale). Use this Mac's Tailscale IP + port 4949."
          : "Listening on localhost only. Switch bind to All interfaces in Settings for Tailscale.",
      serverEnabled: cfg.serverEnabled !== false,
      serverListening: gateway.isListening(),
      providers: publicProviders,
      combos: (cfg.combos || []).map(publicCombo),
      stats: publicStats(router.stats(), cfg.combos),
      usage: publicUsage(router.usageAggregate("24h"), cfg.combos),
      unlocked: sessionAuth.isUnlocked(
        !!cfg.adminPasswordHash && cfg.adminPasswordHash !== "harness"
      ) || !!process.env.REROUTED_STATE,
      hasAdminPassword: !!cfg.adminPasswordHash && cfg.adminPasswordHash !== "harness",
      oauthProviders: Object.keys(OAUTH).map((k) => ({
        id: k,
        name: OAUTH[k].name,
      })),
      keyedPresets: Object.values(KEYED_PRESETS),
      steps: ONBOARDING_STEPS,
    };
  });

  ipcMain.handle("app:set-onboarding-step", async (_e, step) => {
    store.update((cfg) => {
      cfg.onboardingStep = step;
      if (step === "done") cfg.onboardingComplete = true;
    });
    return { ok: true };
  });

  ipcMain.handle("app:complete-onboarding", async () => {
    store.update((cfg) => {
      cfg.onboardingComplete = true;
      cfg.onboardingStep = "done";
    });
    return { ok: true };
  });

  ipcMain.handle("app:set-open-at-login", async (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
    store.update((cfg) => {
      cfg.openAtLogin = !!enabled;
    });
    return { ok: true, openAtLogin: !!enabled };
  });

  ipcMain.handle("app:set-admin-password", async (_e, password) => {
    if (!password || String(password).length < 4) {
      return { ok: false, error: "Password must be at least 4 characters" };
    }
    const hash = await hashPassword(password);
    store.update((cfg) => {
      cfg.adminPasswordHash = hash;
    });
    sessionAuth.setManualUnlocked(true);
    return { ok: true };
  });

  ipcMain.handle("app:verify-admin-password", async (_e, password) => {
    const cfg = store.load();
    if (!cfg.adminPasswordHash || cfg.adminPasswordHash === "harness") {
      sessionAuth.setManualUnlocked(true);
      return { ok: true };
    }
    const ok = await verifyPassword(password, cfg.adminPasswordHash);
    sessionAuth.setManualUnlocked(ok);
    return { ok };
  });

  ipcMain.handle("app:change-admin-password", async (_e, { current, next }) => {
    const cfg = store.load();
    if (cfg.adminPasswordHash && cfg.adminPasswordHash !== "harness") {
      const ok = await verifyPassword(current, cfg.adminPasswordHash);
      if (!ok) return { ok: false, error: "Current password incorrect" };
    }
    if (!next || String(next).length < 4) {
      return { ok: false, error: "New password too short" };
    }
    const hash = await hashPassword(next);
    store.update((c) => {
      c.adminPasswordHash = hash;
    });
    return { ok: true };
  });

  ipcMain.handle("app:detect-providers", async () => {
    detectedCache = await detectAll();
    return { ok: true, found: summarizeDetected(detectedCache) };
  });

  ipcMain.handle("app:import-detected", async (_e, ids) => {
    const want = new Set(ids || []);
    const toImport = detectedCache.filter((d) => want.has(d.id));
    store.update((cfg) => {
      for (const d of toImport) {
        // Avoid duplicate by type+email/source path
        const exists = cfg.providers.some(
          (p) =>
            p.type === d.type &&
            ((d.email && p.email === d.email) || (d.path && p.importPath === d.path))
        );
        if (exists) continue;
        cfg.providers.push({
          id: d.id || generateId("prov"),
          type: d.type,
          name: d.name,
          email: d.email,
          accessToken: d.accessToken,
          refreshToken: d.refreshToken,
          accountId: d.accountId,
          projectId: d.projectId,
          clientId: d.clientId,
          clientSecret: d.clientSecret,
          models: d.models,
          enabled: true,
          importPath: d.path,
          source: d.source,
          createdAt: Date.now(),
        });
      }
    });
    return { ok: true };
  });

  ipcMain.handle("app:oauth-start", async (_e, type) => {
    try {
      logger.oauth(`UI requested OAuth start for ${type}`);
      const result = await startOAuth(type);
      logger.oauth(`Opening external browser for ${type}`);
      await shell.openExternal(result.authUrl);
      logger.oauth(`Browser open dispatched for ${type}`);
      return {
        ok: true,
        authUrl: result.authUrl,
        altAuthUrl: result.altAuthUrl || null,
        redirectUri: result.redirectUri,
        needsPaste: result.needsPaste,
        params: result.params,
        logFile: logger.getFilePath(),
      };
    } catch (e) {
      logger.error(`oauth-start failed: ${e.message}`);
      return { ok: false, error: e.message, logFile: logger.getFilePath() };
    }
  });

  ipcMain.handle("app:oauth-status", async (_e, type) => oauthStatus(type));

  ipcMain.handle("app:oauth-complete", async (_e, { type, pasteCode, providerId }) => {
    try {
      logger.oauth(`UI requested OAuth complete for ${type}`, {
        providerId: providerId || null,
        pasteLen: pasteCode ? String(pasteCode).length : 0,
      });
      const account = await completeOAuth(type, { pasteCode });
      store.update((cfg) => {
        if (providerId) {
          const i = cfg.providers.findIndex((p) => p.id === providerId);
          if (i >= 0) {
            const prev = cfg.providers[i];
            cfg.providers[i] = {
              ...prev,
              accessToken: account.accessToken,
              refreshToken: account.refreshToken || prev.refreshToken,
              expiresAt: account.expiresAt,
              accountId: account.accountId || prev.accountId,
              projectId: account.projectId || prev.projectId,
              email: account.email || prev.email,
              name: prev.name || account.name,
              enabled: true,
            };
            return;
          }
        }
        cfg.providers.push(account);
      });
      logger.oauth(`OAuth complete SUCCESS for ${type}`, {
        name: account.name,
        reauthed: !!providerId,
      });
      return {
        ok: true,
        account: {
          id: providerId || account.id,
          type: account.type,
          name: account.name,
          reauthed: !!providerId,
        },
      };
    } catch (e) {
      logger.error(`oauth-complete FAILED for ${type}: ${e.message}`);
      return { ok: false, error: e.message, logFile: logger.getFilePath() };
    }
  });

  ipcMain.handle("app:logs-get", async (_e, limit) => {
    return {
      ok: true,
      entries: logger.list(limit || 200),
      file: logger.getFilePath(),
    };
  });

  ipcMain.handle("app:logs-clear", async () => {
    logger.clear();
    logger.info("Logs cleared by user");
    return { ok: true };
  });

  ipcMain.handle("app:logs-reveal", async () => {
    const f = logger.getFilePath();
    if (f) {
      shell.showItemInFolder(f);
      return { ok: true, file: f };
    }
    return { ok: false, error: "No log file" };
  });

  ipcMain.handle("app:add-keyed-provider", async (_e, payload) => {
    const { preset, name, baseUrl, apiKey, accountId, models } = payload || {};
    let finalBase = baseUrl;
    let finalName = name;
    let type = "custom";
    if (preset && KEYED_PRESETS[preset]) {
      const p = KEYED_PRESETS[preset];
      finalBase = p.baseUrl.replace("{account_id}", accountId || "");
      finalName = finalName || p.name;
      type = preset;
    }
    if (!finalBase || !apiKey) return { ok: false, error: "Base URL and API key required" };
    const prov = {
      id: generateId("prov"),
      type: type === "custom" ? "openai-compat" : type,
      name: finalName || "Custom",
      baseUrl: finalBase.replace(/\/+$/, ""),
      apiKey,
      models: models || [],
      enabled: true,
      createdAt: Date.now(),
    };
    store.update((cfg) => {
      cfg.providers.push(prov);
    });
    return { ok: true, id: prov.id };
  });

  ipcMain.handle("app:test-keyed-provider", async (_e, { baseUrl, apiKey }) => {
    try {
      const models = await openaiCompat.listModels({ baseUrl, apiKey });
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("app:remove-provider", async (_e, id) => {
    store.update((cfg) => {
      cfg.providers = cfg.providers.filter((p) => p.id !== id);
      for (const c of cfg.combos) {
        c.members = (c.members || []).filter((m) => m.providerId !== id);
      }
    });
    return { ok: true };
  });

  ipcMain.handle("app:set-provider-enabled", async (_e, { id, enabled }) => {
    let found = false;
    store.update((cfg) => {
      const p = cfg.providers.find((x) => x.id === id);
      if (p) {
        p.enabled = !!enabled;
        found = true;
      }
    });
    return { ok: found, enabled: !!enabled };
  });

  ipcMain.handle("app:usage", async (_e, period) => {
    const cfg = store.load();
    return {
      ok: true,
      usage: publicUsage(router.usageAggregate(period || "24h"), cfg.combos),
      stats: publicStats(router.stats(), cfg.combos),
    };
  });

  ipcMain.handle("app:quota-get", async () => {
    return { ok: true, quota: quota.current() };
  });

  ipcMain.handle("app:quota-refresh", async () => {
    return { ok: true, quota: await quota.refresh() };
  });

  ipcMain.handle("app:save-combo", async (_e, combo) => {
    const name = String(combo?.name || "").trim();
    if (!name) return { ok: false, error: "Model ID is required" };
    const current = store.load();
    const editIndex = combo.id
      ? (current.combos || []).findIndex((entry) => comboMatchesId(entry, combo.id))
      : -1;
    if (combo.id && editIndex < 0) return { ok: false, error: "Route not found" };
    if (comboNameConflict(current.combos, name, editIndex)) {
      return { ok: false, error: `A route named ${name} already exists` };
    }
    if (comboStorageIdConflict(current.combos, name)) {
      return { ok: false, error: "That model ID is reserved by an existing route" };
    }
    if (providerRouteIds(current.providers).has(name.toLowerCase())) {
      return { ok: false, error: "That model ID is already used by a connected provider" };
    }
    store.update((cfg) => {
      if (combo.id) {
        const i = cfg.combos.findIndex((c) => comboMatchesId(c, combo.id));
        if (i >= 0) {
          const internalId = cfg.combos[i].id;
          cfg.combos[i] = { ...cfg.combos[i], ...combo, name, id: internalId };
        }
      } else {
        cfg.combos.push({
          id: generateId("combo"),
          name,
          strategy: combo.strategy || "fallback",
          members: combo.members || [],
          createdAt: Date.now(),
        });
      }
    });
    return { ok: true, combos: store.load().combos.map(publicCombo) };
  });

  ipcMain.handle("app:delete-combo", async (_e, id) => {
    store.update((cfg) => {
      cfg.combos = cfg.combos.filter((c) => !comboMatchesId(c, id));
    });
    return { ok: true };
  });

  ipcMain.handle("app:set-server-enabled", async (_e, enabled) => {
    store.update((cfg) => {
      cfg.serverEnabled = !!enabled;
    });
    return { ok: true };
  });

  ipcMain.handle("app:set-bind-host", async (_e, bindHost) => {
    const h = bindHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
    store.update((cfg) => {
      cfg.bindHost = h;
    });
    try {
      await gateway.restart();
      return { ok: true, bindHost: h };
    } catch (e) {
      return { ok: false, error: e.message, bindHost: h };
    }
  });

  ipcMain.handle("app:create-api-key", async (_e, name) => {
    const key = generateApiKey();
    const entry = {
      id: generateId("key"),
      key,
      name: (name && String(name).trim()) || "Key",
      createdAt: Date.now(),
      enabled: true,
    };
    store.update((cfg) => {
      if (!Array.isArray(cfg.apiKeys)) cfg.apiKeys = [];
      cfg.apiKeys.push(entry);
    });
    return { ok: true, key: entry };
  });

  ipcMain.handle("app:revoke-api-key", async (_e, id) => {
    store.update((cfg) => {
      cfg.apiKeys = (cfg.apiKeys || []).filter((k) => k.id !== id);
      if (!cfg.apiKeys.length) {
        const key = generateApiKey();
        cfg.apiKeys = [
          { id: generateId("key"), key, name: "Default", createdAt: Date.now(), enabled: true },
        ];
      }
      cfg.apiKey = cfg.apiKeys.find((k) => k.enabled !== false)?.key || cfg.apiKeys[0].key;
    });
    return { ok: true, apiKeys: store.load().apiKeys };
  });

  ipcMain.handle("app:set-api-key-enabled", async (_e, { id, enabled }) => {
    store.update((cfg) => {
      const k = (cfg.apiKeys || []).find((x) => x.id === id);
      if (k) k.enabled = !!enabled;
      cfg.apiKey = cfg.apiKeys.find((x) => x.enabled !== false)?.key || cfg.apiKey;
    });
    return { ok: true };
  });

  ipcMain.handle("app:set-model-enabled", async (_e, { providerId, modelId, enabled }) => {
    store.update((cfg) => {
      const p = cfg.providers.find((x) => x.id === providerId);
      if (!p) return;
      if (!Array.isArray(p.models)) p.models = [];
      let m = p.models.find((x) => (typeof x === "string" ? x : x.id) === modelId);
      if (!m) {
        p.models.push({ id: modelId, name: modelId, enabled: !!enabled });
      } else if (typeof m === "string") {
        const i = p.models.indexOf(m);
        p.models[i] = { id: m, name: m, enabled: !!enabled };
      } else {
        m.enabled = !!enabled;
      }
    });
    return { ok: true };
  });

  ipcMain.handle("app:add-model", async (_e, { providerId, modelId }) => {
    const mid = String(modelId || "").trim();
    if (!mid) return { ok: false, error: "Model name required" };
    const cfg = store.load();
    const prov = (cfg.providers || []).find((p) => p.id === providerId);
    if (!prov) return { ok: false, error: "Provider not found" };
    if (prov.enabled === false) return { ok: false, error: "Provider is disabled" };

    // Verify with a minimal non-stream chat request through the real adapter
    const adapter = getAdapter(prov.type);
    if (!adapter || typeof adapter.chat !== "function") {
      return { ok: false, error: `No chat adapter for ${prov.type}` };
    }
    const testResult = await runProviderModelTest({
      adapter,
      provider: prov,
      model: mid,
      logger,
      onTokenRefresh: async (tokens) => {
        store.update((c) => {
          const p = c.providers.find((x) => x.id === providerId);
          if (p) Object.assign(p, tokens);
        });
      },
    });
    if (!testResult.ok) return testResult;

    store.update((c) => {
      const p = c.providers.find((x) => x.id === providerId);
      if (!p) return;
      if (!Array.isArray(p.models)) p.models = [];
      const exists = p.models.some((m) => (typeof m === "string" ? m : m.id) === mid);
      if (!exists) p.models.push({ id: mid, name: mid, enabled: true });
      else {
        const m = p.models.find((x) => (typeof x === "string" ? x : x.id) === mid);
        if (m && typeof m !== "string") m.enabled = true;
      }
    });
    return { ok: true, modelId: mid };
  });

  ipcMain.handle("app:remove-model", async (_e, { providerId, modelId }) => {
    store.update((cfg) => {
      const p = cfg.providers.find((x) => x.id === providerId);
      if (!p || !Array.isArray(p.models)) return;
      p.models = p.models.filter((m) => (typeof m === "string" ? m : m.id) !== modelId);
    });
    return { ok: true };
  });

  ipcMain.handle("app:open-external", async (_e, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle("app:update-check", async () => updateService?.check() || { ok: false });

  ipcMain.handle("app:update-install", async () => {
    if (!updateService || updateService.state().status !== "ready") {
      return { ok: false, error: "No downloaded update is ready" };
    }
    await gateway.stop();
    return updateService.install();
  });

  ipcMain.handle("app:hide-panel", async () => {
    hidePanel();
    return { ok: true };
  });

  ipcMain.handle("app:quit", async () => {
    app.quit();
  });

  ipcMain.handle("app:regenerate-key", async () => {
    // Back-compat: create an additional key named Regenerated
    const key = generateApiKey();
    const entry = {
      id: generateId("key"),
      key,
      name: "Regenerated",
      createdAt: Date.now(),
      enabled: true,
    };
    store.update((cfg) => {
      if (!Array.isArray(cfg.apiKeys)) cfg.apiKeys = [];
      cfg.apiKeys.push(entry);
      cfg.apiKey = key;
    });
    return { ok: true, apiKey: key };
  });

  // Harness: force step without full reset
  ipcMain.handle("harness:goto", async (_e, step) => {
    if (step === "app" || step === "home") {
      store.update((cfg) => {
        cfg.onboardingComplete = true;
        cfg.onboardingStep = "done";
      });
      sessionAuth.setManualUnlocked(true);
      return { ok: true, page: "home" };
    }
    store.update((cfg) => {
      cfg.onboardingComplete = false;
      cfg.onboardingStep = step;
    });
    sessionAuth.setManualUnlocked(true);
    return { ok: true, step };
  });
}

// ─── Boot ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  applyStateEnv();
  if (process.platform === "darwin") {
    let active = false;
    try {
      const idleState = powerMonitor.getSystemIdleState(1);
      active = isMacSessionActive(idleState);
    } catch {
      logger.warn("Could not determine macOS lock state; requiring admin unlock");
    }
    setMacSessionUnlocked(active);
    powerMonitor.on("lock-screen", () => setMacSessionUnlocked(false));
    powerMonitor.on("unlock-screen", () => setMacSessionUnlocked(true));
  }
  updateService = createUpdateService({ app, autoUpdater, logger, publish: publishUpdateState });
  updateService.initialize();
  registerIpc();

  // Sync open-at-login from config
  const cfg = store.load();
  try {
    app.setLoginItemSettings({
      openAtLogin: !!cfg.openAtLogin,
      openAsHidden: true,
    });
  } catch {
    /* ignore */
  }

  tray = new Tray(trayIcon());
  tray.setToolTip("ReRouted");
  // Never setContextMenu — left click toggles panel
  tray.on("click", () => togglePanel());
  tray.on("right-click", () => {
    const update = updateService?.state();
    const updateBusy = update?.status === "checking" || update?.status === "downloading";
    const menu = Menu.buildFromTemplate([
      {
        label: panel?.isVisible() ? "Hide ReRouted" : "Show ReRouted",
        click: () => togglePanel(),
      },
      { type: "separator" },
      {
        label: update?.status === "ready" ? "Restart to Update" : "Check for Updates…",
        enabled: !updateBusy && update?.status !== "installing",
        click: async () => {
          if (update?.status === "ready") {
            await gateway.stop();
            updateService.install();
            return;
          }
          showPanel();
          panel?.webContents.send("app:open-settings");
          updateService?.check();
        },
      },
      { type: "separator" },
      {
        label: "Quit ReRouted",
        click: () => app.quit(),
      },
    ]);
    tray.popUpContextMenu(menu);
  });

  createPanel();
  updateService.schedule();

  try {
    const addr = await gateway.start(cfg.port || DEFAULT_PORT, cfg.bindHost || "127.0.0.1");
    logger.info(`Gateway listening on ${addr.host}:${addr.port}/v1`);
    console.log(`ReRouted gateway on ${addr.host}:${addr.port}/v1`);
  } catch (e) {
    logger.error(`Gateway failed to start: ${e.message}`);
    console.error("Gateway failed to start:", e.message);
  }

  // Periodic tray counter
  setInterval(updateTrayTitle, 2000);

  // Auto-show panel on first run so user sees onboarding
  if (!cfg.onboardingComplete && !process.env.REROUTED_HEADLESS) {
    setTimeout(() => showPanel(), 400);
  }
});

app.on("second-instance", () => {
  showPanel();
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", async () => {
  updateService?.stop();
  await gateway.stop();
});

autoUpdater.on("before-quit-for-update", () => {
  updateService?.stop();
  void gateway.stop();
});

// Export for tests / harness requiring main pieces
module.exports = { store, router, gateway };
