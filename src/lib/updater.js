"use strict";

const DEFAULT_OWNER = "gitcommit90";
const DEFAULT_REPO = "rerouted";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function publicError(error) {
  const message = String(error?.message || error || "Update check failed")
    .replace(/https?:\/\/\S+/g, "the update service")
    .replace(/\s+/g, " ")
    .trim();
  return message.slice(0, 220) || "Update check failed";
}

function releaseVersion(name) {
  const match = String(name || "").match(/v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function createUpdateService({
  app,
  autoUpdater,
  logger,
  publish = () => {},
  platform = process.platform,
  arch = process.arch,
  owner = DEFAULT_OWNER,
  repo = DEFAULT_REPO,
} = {}) {
  let initialized = false;
  let active = false;
  let busy = false;
  let initialTimer = null;
  let intervalTimer = null;
  let state = {
    status: "idle",
    currentVersion: app.getVersion(),
    version: null,
    checkedAt: null,
    error: null,
  };

  let inApplications = true;
  if (platform === "darwin" && typeof app.isInApplicationsFolder === "function") {
    try {
      inApplications = app.isInApplicationsFolder();
    } catch {
      inApplications = false;
    }
  }
  const supported =
    platform === "darwin" && arch === "arm64" && app.isPackaged === true && inApplications;
  const feedUrl = `https://update.electronjs.org/${owner}/${repo}/darwin-arm64/${encodeURIComponent(
    app.getVersion()
  )}`;

  function snapshot() {
    return { ...state };
  }

  function setState(patch) {
    state = { ...state, ...patch };
    publish(snapshot());
  }

  function initialize() {
    if (initialized) return active;
    initialized = true;
    if (!supported) {
      setState({
        status: "unsupported",
        error:
          app.isPackaged && platform === "darwin" && arch === "arm64" && !inApplications
            ? "Move ReRouted to Applications to enable updates."
            : app.isPackaged
              ? "Updates are currently available on Apple Silicon macOS."
              : null,
      });
      return false;
    }

    autoUpdater.on("checking-for-update", () => {
      busy = true;
      setState({ status: "checking", error: null });
    });
    autoUpdater.on("update-available", () => {
      busy = true;
      setState({ status: "downloading", error: null });
    });
    autoUpdater.on("update-not-available", () => {
      busy = false;
      setState({ status: "current", checkedAt: Date.now(), error: null });
    });
    autoUpdater.on("update-downloaded", (_event, notes, name) => {
      busy = false;
      setState({
        status: "ready",
        version: releaseVersion(name) || releaseVersion(notes),
        checkedAt: Date.now(),
        error: null,
      });
    });
    autoUpdater.on("error", (error) => {
      busy = false;
      logger.error(`Update failed: ${error?.message || error}`);
      setState({ status: "error", checkedAt: Date.now(), error: publicError(error) });
    });
    try {
      autoUpdater.setFeedURL({ url: feedUrl });
      active = true;
      logger.info("Updater ready", { currentVersion: app.getVersion() });
      return true;
    } catch (error) {
      logger.error(`Updater initialization failed: ${error?.message || error}`);
      setState({ status: "error", error: publicError(error) });
      return false;
    }
  }

  function check() {
    if (!initialize()) {
      return { ok: false, error: state.error || "Updates are unavailable in this build", update: snapshot() };
    }
    if (busy || state.status === "ready") return { ok: true, update: snapshot() };
    busy = true;
    setState({ status: "checking", error: null });
    try {
      autoUpdater.checkForUpdates();
      return { ok: true, update: snapshot() };
    } catch (error) {
      busy = false;
      logger.error(`Update check failed: ${error?.message || error}`);
      setState({ status: "error", checkedAt: Date.now(), error: publicError(error) });
      return { ok: false, error: state.error, update: snapshot() };
    }
  }

  function install() {
    if (state.status !== "ready") {
      return { ok: false, error: "No downloaded update is ready", update: snapshot() };
    }
    setState({ status: "installing", error: null });
    try {
      autoUpdater.quitAndInstall();
      return { ok: true, update: snapshot() };
    } catch (error) {
      logger.error(`Update install failed: ${error?.message || error}`);
      setState({ status: "error", error: publicError(error) });
      return { ok: false, error: state.error, update: snapshot() };
    }
  }

  function schedule({ initialDelayMs = 20_000, intervalMs = CHECK_INTERVAL_MS } = {}) {
    if (!initialize()) return;
    if (!initialTimer) {
      initialTimer = setTimeout(() => check(), initialDelayMs);
      initialTimer.unref?.();
    }
    if (!intervalTimer) {
      intervalTimer = setInterval(() => check(), intervalMs);
      intervalTimer.unref?.();
    }
  }

  function stop() {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  return { initialize, check, install, schedule, stop, state: snapshot, feedUrl };
}

module.exports = { createUpdateService, publicError, releaseVersion };
