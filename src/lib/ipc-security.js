"use strict";

const LOCKED_CHANNELS = new Set([
  "app:get-state",
  "app:verify-admin-password",
  "app:hide-panel",
  "app:quit",
]);

const PRODUCT_HOSTS = new Set(["rerouted.dev", "www.rerouted.dev"]);
const PROVIDER_KEY_URLS = new Set([
  "https://openrouter.ai/workspaces/default/keys",
  "https://build.nvidia.com/settings/api-keys",
]);

function hasAdminPassword(cfg) {
  return !!cfg?.adminPasswordHash && cfg.adminPasswordHash !== "harness";
}

function isUnlocked(cfg, sessionAuth, { harness = false } = {}) {
  return !!harness || sessionAuth.isUnlocked(hasAdminPassword(cfg));
}

function canInvoke(channel, cfg, sessionAuth, options) {
  if (!cfg?.onboardingComplete || !hasAdminPassword(cfg)) return true;
  if (isUnlocked(cfg, sessionAuth, options)) return true;
  return LOCKED_CHANNELS.has(channel);
}

function lockedError() {
  return {
    ok: false,
    code: "rerouted_locked",
    error: "Unlock ReRouted to continue.",
  };
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    if (PRODUCT_HOSTS.has(url.hostname.toLowerCase())) return true;
    url.hash = "";
    url.search = "";
    return PROVIDER_KEY_URLS.has(url.toString().replace(/\/$/, ""));
  } catch {
    return false;
  }
}

function redactLockedState(state) {
  if (!state?.hasAdminPassword || state.unlocked || !state.onboardingComplete) return state;
  return {
    onboardingComplete: true,
    onboardingStep: "done",
    appVersion: state.appVersion,
    update: state.update,
    port: state.port,
    serverEnabled: state.serverEnabled,
    serverListening: state.serverListening,
    unlocked: false,
    hasAdminPassword: true,
    steps: state.steps || [],
  };
}

module.exports = {
  LOCKED_CHANNELS,
  hasAdminPassword,
  isUnlocked,
  canInvoke,
  lockedError,
  isAllowedExternalUrl,
  redactLockedState,
};
