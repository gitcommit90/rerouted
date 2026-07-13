"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const INVOKE_CHANNELS = new Set([
  "app:get-state",
  "app:set-onboarding-step",
  "app:complete-onboarding",
  "app:set-open-at-login",
  "app:set-admin-password",
  "app:verify-admin-password",
  "app:change-admin-password",
  "app:detect-providers",
  "app:import-detected",
  "app:oauth-start",
  "app:oauth-status",
  "app:oauth-cancel",
  "app:oauth-complete",
  "app:logs-get",
  "app:logs-clear",
  "app:logs-reveal",
  "app:add-keyed-provider",
  "app:test-keyed-provider",
  "app:remove-provider",
  "app:set-provider-enabled",
  "app:usage",
  "app:quota-get",
  "app:quota-refresh",
  "app:save-combo",
  "app:delete-combo",
  "app:set-server-enabled",
  "app:set-bind-host",
  "app:create-api-key",
  "app:revoke-api-key",
  "app:set-api-key-enabled",
  "app:set-model-enabled",
  "app:add-model",
  "app:remove-model",
  "app:open-external",
  "app:update-check",
  "app:update-install",
  "app:hide-panel",
  "app:quit",
  "app:regenerate-key",
  // Registered only by scripts/capture-ui.js; the production main process has no harness handler.
  "harness:goto",
  "harness:keyed-provider-adds",
  "harness:oauth-cancel-races",
  "harness:oauth-cancels",
  "harness:set-update-state",
]);

const EVENT_CHANNELS = new Set([
  "app:update-state",
  "app:session-lock-changed",
  "app:provider-identities-updated",
  "app:open-settings",
]);

contextBridge.exposeInMainWorld("rerouted", {
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(new Error("Unsupported IPC channel"));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.has(channel)) throw new Error("Unsupported IPC channel");
    const handler = (_e, ...a) => cb(...a);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
