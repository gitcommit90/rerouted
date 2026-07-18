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
const { createRequestActivity } = require("./lib/request-activity");
const { createUsageStore } = require("./lib/usage");
const logger = require("./lib/logger");
const { generateApiKey } = require("./lib/password");
const { backfillLocalOAuthIdentities } = require("./lib/detect");
const { backfillClaudeProfiles } = require("./lib/oauth");
const { createQuotaService } = require("./lib/quota");
const { createSessionAuth, isMacSessionActive } = require("./lib/session-auth");
const { hasAdminPassword } = require("./lib/ipc-security");
const { createUpdateService } = require("./lib/updater");
const { acquireSingleInstance } = require("./lib/single-instance");
const { createControlPlane } = require("./lib/control-plane");
const { DEFAULT_PORT } = require("./lib/constants");
const { getAdapter } = require("./lib/providers");

// ─── Paths / single instance ───────────────────────────────────────────
const gotLock = acquireSingleInstance(app);

if (gotLock) {

const userData = process.env.REROUTED_USER_DATA || app.getPath("userData");
const configPath = path.join(userData, "config.json");
const usagePath = path.join(userData, "usage.sqlite");
const legacyUsagePath = path.join(userData, "usage.json");
const logPath = path.join(userData, "rerouted.log");
logger.configure(logPath);
logger.info("ReRouted starting", { userData, logPath });

const store = createStore(configPath);
const usage = createUsageStore(usagePath, { legacyPath: legacyUsagePath });
const requestActivity = createRequestActivity();
const router = createRouter({ store, usage });
const gateway = createGateway({ store, router, requestActivity });
const sessionAuth = createSessionAuth();
const quota = createQuotaService({ store, refreshProvider: refreshProviderForQuota });

let tray = null;
let panel = null;
let lastBlurHide = 0;
let detectedCache = [];
let updateService = null;
let updatePromptShown = false;

requestActivity.subscribe((activity) => {
  const cfg = store.load();
  const canPublish =
    !hasAdminPassword(cfg) || sessionAuth.isUnlocked(true) || harnessModeEnabled();
  if (canPublish && panel && !panel.isDestroyed()) {
    panel.webContents.send("app:request-activity", activity);
  }
});

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
    const hasPassword = hasAdminPassword(cfg);
    panel.webContents.send("app:session-lock-changed", {
      unlocked: sessionAuth.isUnlocked(hasPassword),
    });
  }
}

function harnessModeEnabled() {
  return !app.isPackaged && !!process.env.REROUTED_STATE;
}

// Dev / harness state jump
function applyStateEnv() {
  if (!harnessModeEnabled()) return;
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
      sandbox: true,
    },
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
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

// ─── Shared control plane / IPC ───────────────────────────────────────
const controlPlane = createControlPlane({
  store,
  router,
  gateway,
  requestActivity,
  quota,
  logger,
  sessionAuth,
  getAppVersion: () => app.getVersion(),
  getUpdateService: () => updateService,
  harnessModeEnabled,
  setOpenAtLogin: async (enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
  },
  openExternal: (url) => shell.openExternal(url),
  revealFile: async (filePath) => {
    shell.showItemInFolder(filePath);
  },
  hidePanel,
  quit: async () => app.quit(),
  runtime: "desktop",
  platform: process.platform,
});

function registerIpc() {
  for (const channel of controlPlane.channels()) {
    ipcMain.handle(channel, async (_event, ...args) =>
      controlPlane.invoke(channel, args, {
        sessionAuth,
        harness: harnessModeEnabled(),
      })
    );
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  let identityConfig;
  try {
    applyStateEnv();
    identityConfig = store.load();
  } catch (error) {
    logger.error("ReRouted could not load its configuration", {
      code: error?.code || null,
      recoveryPath: error?.recoveryPath || null,
    });
    await dialog.showMessageBox({
      type: "error",
      title: "ReRouted could not open its configuration",
      message: "Your existing accounts, keys, and routes were not overwritten.",
      detail:
        error?.message ||
        "ReRouted could not read config.json. Restore a valid configuration or move the damaged file before reopening the app.",
      buttons: ["Quit ReRouted"],
      defaultId: 0,
      noLink: true,
    });
    app.quit();
    return;
  }
  if (backfillLocalOAuthIdentities(identityConfig.providers)) store.save(identityConfig);
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
  const claudeAdapter = getAdapter("claude");
  void backfillClaudeProfiles(store.load().providers, {
    refreshImpl: (provider, options) => claudeAdapter.refreshToken(provider, options),
  })
    .then((changed) => {
      if (!changed) return;
      store.save(store.load());
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send("app:provider-identities-updated");
      }
    })
    .catch((error) => logger.warn(`Could not enrich Claude account identities: ${error.message}`));
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
}
