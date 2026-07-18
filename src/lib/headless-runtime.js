"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("./store");
const { createRouter } = require("./router");
const { createGateway } = require("./gateway");
const { createDashboard } = require("./dashboard");
const { createRequestActivity } = require("./request-activity");
const { createUsageStore } = require("./usage");
const { createQuotaService } = require("./quota");
const { createSessionAuth } = require("./session-auth");
const { createControlPlane } = require("./control-plane");
const { backfillLocalOAuthIdentities } = require("./detect");
const { backfillClaudeProfiles } = require("./oauth");
const { getAdapter } = require("./providers");
const { DEFAULT_PORT } = require("./constants");
const defaultLogger = require("./logger");

function defaultUserData({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  if (env.REROUTED_USER_DATA) return path.resolve(env.REROUTED_USER_DATA);
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(homedir, "AppData", "Roaming"), "ReRouted");
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "ReRouted");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir, ".config"), "rerouted");
}

function createProcessLock(userData, { pid = process.pid, kill = process.kill } = {}) {
  const lockPath = path.join(userData, "rerouted.pid");
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });

  function liveProcess(savedPid) {
    if (!Number.isSafeInteger(savedPid) || savedPid <= 0) return false;
    try {
      kill(savedPid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${pid}\n`, "utf8");
      fs.closeSync(fd);
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            const current = Number(fs.readFileSync(lockPath, "utf8").trim());
            if (current === pid) fs.unlinkSync(lockPath);
          } catch {
            // The process lock is best-effort during shutdown.
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let savedPid = null;
      try {
        savedPid = Number(fs.readFileSync(lockPath, "utf8").trim());
      } catch {
        // Treat an unreadable lock as stale only if we can replace it atomically below.
      }
      if (liveProcess(savedPid)) {
        const active = new Error(`ReRouted is already running (PID ${savedPid})`);
        active.code = "ALREADY_RUNNING";
        active.pid = savedPid;
        throw active;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire the ReRouted process lock");
}

function createHeadlessRuntime({
  userData = defaultUserData(),
  version = "0.0.0",
  rendererRoot = path.join(__dirname, "..", "renderer"),
  logger = defaultLogger,
  openExternal = async () => {},
  onQuit = async () => {},
} = {}) {
  const configPath = path.join(userData, "config.json");
  const usagePath = path.join(userData, "usage.sqlite");
  const legacyUsagePath = path.join(userData, "usage.json");
  const logPath = path.join(userData, "rerouted.log");
  logger.configure(logPath);

  const store = createStore(configPath);
  const usage = createUsageStore(usagePath, { legacyPath: legacyUsagePath });
  const requestActivity = createRequestActivity();
  const router = createRouter({ store, usage });
  const gateway = createGateway({ store, router, requestActivity });
  const sessionAuth = createSessionAuth({ platform: "linux" });

  async function refreshProviderForQuota(provider) {
    const adapter = getAdapter(provider?.type);
    if (!adapter || !provider?.refreshToken || typeof adapter.refreshToken !== "function") {
      return provider;
    }
    const tokens = await adapter.refreshToken(provider);
    store.update((cfg) => {
      const saved = (cfg.providers || []).find((item) => item.id === provider.id);
      if (saved) Object.assign(saved, tokens);
    });
    return { ...provider, ...tokens };
  }

  const quota = createQuotaService({ store, refreshProvider: refreshProviderForQuota });
  let dashboard = null;
  const controlPlane = createControlPlane({
    store,
    router,
    gateway,
    requestActivity,
    quota,
    logger,
    sessionAuth,
    getAppVersion: () => version,
    openExternal,
    revealFile: async () => {},
    quit: onQuit,
    restartGateway: async () => {
      dashboard?.disconnect();
      setTimeout(() => {
        gateway.restart().catch((error) =>
          logger.error("Gateway restart failed", { error: error.message })
        );
      }, 100).unref?.();
    },
    runtime: "headless",
    platform: process.platform,
  });
  dashboard = createDashboard({ store, controlPlane, rendererRoot, logger });
  gateway.setDashboardHandler(dashboard.handle);
  const unsubscribeActivity = requestActivity.subscribe((activity) => {
    dashboard.publish("app:request-activity", activity);
  });

  let started = false;
  let closing = null;

  async function start({ port, host } = {}) {
    if (started) {
      return {
        address: gateway.getAddress(),
        dashboard: gateway.getAddress()?.replace(/\/v1$/, "/dashboard/"),
      };
    }
    const cfg = store.load();
    if (backfillLocalOAuthIdentities(cfg.providers)) store.save(cfg);
    const address = await gateway.start(port ?? cfg.port ?? DEFAULT_PORT, host ?? cfg.bindHost);
    started = true;
    logger.info("ReRouted headless runtime started", {
      host: address.host,
      port: address.port,
      userData,
    });

    const claudeAdapter = getAdapter("claude");
    void backfillClaudeProfiles(store.load().providers, {
      refreshImpl: (provider, options) => claudeAdapter.refreshToken(provider, options),
    })
      .then((changed) => {
        if (!changed) return;
        store.save(store.load());
        dashboard.publish("app:provider-identities-updated", { changed: true });
      })
      .catch((error) => logger.warn(`Could not enrich Claude account identities: ${error.message}`));

    return {
      ...address,
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      dashboard: `http://127.0.0.1:${address.port}/dashboard/`,
    };
  }

  async function close({ drainMs = 5_000 } = {}) {
    if (closing) return closing;
    closing = (async () => {
      unsubscribeActivity();
      dashboard.close();
      const deadline = Date.now() + Math.max(0, Number(drainMs) || 0);
      while (requestActivity.snapshot().length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await gateway.stop();
      usage.close();
      started = false;
      logger.info("ReRouted headless runtime stopped");
    })();
    return closing;
  }

  return {
    userData,
    store,
    usage,
    router,
    gateway,
    requestActivity,
    quota,
    sessionAuth,
    controlPlane,
    dashboard,
    start,
    close,
  };
}

module.exports = {
  createHeadlessRuntime,
  createProcessLock,
  defaultUserData,
};
