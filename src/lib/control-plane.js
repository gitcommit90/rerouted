"use strict";

const { hydrateUsageIdentity } = require("./usage");
const { hashPassword, verifyPassword, generateId, generateApiKey } = require("./password");
const { startOAuth, completeOAuth, oauthStatus, clearPending } = require("./oauth");
const {
  canInvoke,
  hasAdminPassword,
  isAllowedExternalUrl,
  lockedError,
  redactLockedState,
} = require("./ipc-security");
const { runProviderModelTest } = require("./model-test");
const { testKeyedProvider } = require("./keyed-provider-test");
const { KEYED_PRESETS, ONBOARDING_STEPS, DEFAULT_PORT, OAUTH } = require("./constants");
const { listProviderModels, getAdapter } = require("./providers");
const {
  customConnectionNameError,
  customModelRouteConflict,
  customProviderModelId,
  isCustomProviderType,
} = require("./model-ids");
const {
  publicCombo,
  comboMatchesId,
  publicRouteId,
  providerRouteIds,
  comboStorageIdConflict,
  comboNameConflict,
} = require("./combos");

function createControlPlane({
  store,
  router,
  gateway,
  requestActivity,
  quota,
  logger,
  sessionAuth,
  getAppVersion = () => "0.0.0",
  getUpdateService = () => null,
  harnessModeEnabled = () => false,
  restartGateway = () => gateway.restart(),
  setOpenAtLogin = async () => {},
  openExternal = async () => {},
  revealFile = async () => {},
  hidePanel = async () => {},
  quit = async () => {},
  runtime = "desktop",
  platform = process.platform,
} = {}) {
  if (!store || !router || !gateway || !requestActivity || !quota || !logger || !sessionAuth) {
    throw new TypeError("Control plane requires the ReRouted runtime services");
  }

  const handlers = new Map();
  const handle = (channel, handler) => {
    if (handlers.has(channel)) throw new Error(`Duplicate control-plane handler: ${channel}`);
    handlers.set(channel, handler);
  };

  function publicActivityEntry(entry, cfg) {
    return {
      ...hydrateUsageIdentity(entry, cfg.providers),
      model: publicRouteId(cfg.combos, entry.model),
    };
  }

  function publicStats(stats, cfg) {
    if (!stats) return stats;
    return {
      ...stats,
      recent: (stats.recent || []).map((entry) => publicActivityEntry(entry, cfg)),
    };
  }

  function publicUsage(usage, cfg) {
    if (!usage) return usage;
    return {
      ...usage,
      byModel: (usage.byModel || []).map((entry) => ({
        ...entry,
        model: publicRouteId(cfg.combos, entry.model),
      })),
      byProvider: (usage.byProvider || []).map((entry) =>
        hydrateUsageIdentity(entry, cfg.providers)
      ),
      recent: (usage.recent || []).map((entry) => publicActivityEntry(entry, cfg)),
    };
  }

  handle("app:get-state", async (_e) => {
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
      profileName: p.profileName,
      enabled: p.enabled !== false,
      hasToken: !!(p.accessToken || p.apiKey),
      models,
      baseUrl: p.baseUrl,
    };
  });
  const listening = gateway.getListeningAddress?.();
  const port = listening?.port || cfg.port || DEFAULT_PORT;
  const bindHost = listening?.host || cfg.bindHost || "127.0.0.1";
  const apiKeys = (cfg.apiKeys || []).map((k) => ({
    id: k.id,
    name: k.name || "Key",
    key: k.key,
    enabled: k.enabled !== false,
    createdAt: k.createdAt,
  }));
  // Primary key for simple copy on Home / onboarding
  const primaryKey = apiKeys.find((k) => k.enabled !== false)?.key || "";
  const hasPassword = hasAdminPassword(cfg);
  const unlocked = _e.sessionAuth.isUnlocked(hasPassword) || _e.harness;
  return redactLockedState({
    onboardingComplete: !!cfg.onboardingComplete,
    appVersion: getAppVersion(),
    runtime,
    platform,
    update: getUpdateService()?.state() || {
      status: runtime === "headless" ? "unsupported" : "idle",
      currentVersion: getAppVersion(),
      version: null,
      checkedAt: null,
      error:
        runtime === "headless"
          ? "Update ReRouted through the package manager you installed it with."
          : null,
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
        ? "Listening on all interfaces (LAN / Tailscale). Use this machine's network address and configured port."
        : "Listening on localhost only. Switch bind to All interfaces in Settings for LAN or Tailscale.",
    serverEnabled: cfg.serverEnabled !== false,
    serverListening: gateway.isListening(),
    providers: publicProviders,
    combos: (cfg.combos || []).map(publicCombo),
    stats: publicStats(router.stats(), cfg),
    usage: publicUsage(router.usageAggregate("24h"), cfg),
    activeRequests: requestActivity.snapshot(),
    unlocked,
    hasAdminPassword: hasPassword,
    oauthProviders: Object.keys(OAUTH).map((k) => ({
      id: k,
      name: OAUTH[k].name,
    })),
    keyedPresets: Object.values(KEYED_PRESETS),
    steps: ONBOARDING_STEPS,
  });
  });

handle("app:set-onboarding-step", async (_e, step) => {
  if (!ONBOARDING_STEPS.includes(step) || step === "done") {
    return { ok: false, error: "Unknown onboarding step" };
  }
  store.update((cfg) => {
    cfg.onboardingStep = step;
  });
  return { ok: true };
});

handle("app:complete-onboarding", async () => {
  store.update((cfg) => {
    cfg.onboardingComplete = true;
    cfg.onboardingStep = "done";
  });
  return { ok: true };
});

handle("app:set-open-at-login", async (_e, enabled) => {
  await setOpenAtLogin(!!enabled);
  store.update((cfg) => {
    cfg.openAtLogin = !!enabled;
  });
  return { ok: true, openAtLogin: !!enabled };
});

handle("app:set-admin-password", async (_e, password) => {
  if (!password || String(password).length < 4) {
    return { ok: false, error: "Password must be at least 4 characters" };
  }
  const hash = await hashPassword(password);
  store.update((cfg) => {
    cfg.adminPasswordHash = hash;
  });
  _e.sessionAuth.setManualUnlocked(true);
  return { ok: true };
});

handle("app:verify-admin-password", async (_e, password) => {
  const cfg = store.load();
  if (!cfg.adminPasswordHash || cfg.adminPasswordHash === "harness") {
    _e.sessionAuth.setManualUnlocked(true);
    return { ok: true };
  }
  const ok = await verifyPassword(password, cfg.adminPasswordHash);
  _e.sessionAuth.setManualUnlocked(ok);
  return { ok };
});

handle("app:change-admin-password", async (_e, { current, next }) => {
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

handle("app:oauth-start", async (_e, type) => {
  try {
    logger.oauth(`UI requested OAuth start for ${type}`);
    const result = await startOAuth(type);
    logger.oauth(`Opening external browser for ${type}`);
    if (runtime === "desktop") await openExternal(result.authUrl);
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

handle("app:oauth-status", async (_e, type) => oauthStatus(type));

handle("app:oauth-cancel", async (_e, type) => {
  clearPending(type);
  return { ok: true };
});

handle("app:oauth-complete", async (_e, { type, pasteCode, providerId }) => {
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
            profileName: account.profileName || prev.profileName,
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
        email: account.email || null,
        profileName: account.profileName || null,
        reauthed: !!providerId,
      },
    };
  } catch (e) {
    logger.error(`oauth-complete FAILED for ${type}: ${e.message}`);
    return { ok: false, error: e.message, logFile: logger.getFilePath() };
  }
});

handle("app:logs-get", async (_e, limit) => {
  return {
    ok: true,
    entries: logger.list(limit || 200),
    file: logger.getFilePath(),
  };
});

handle("app:logs-clear", async () => {
  logger.clear();
  logger.info("Logs cleared by user");
  return { ok: true };
});

handle("app:logs-reveal", async () => {
  const f = logger.getFilePath();
  if (f) {
    await revealFile(f);
    return { ok: true, file: f };
  }
  return { ok: false, error: "No log file" };
});

handle("app:add-keyed-provider", async (_e, payload) => {
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
  if (type === "custom") {
    const current = store.load();
    const nameError = customConnectionNameError(finalName, current.providers);
    if (nameError) return { ok: false, error: nameError };
    finalName = String(finalName).trim();
    const conflict = customModelRouteConflict(finalName, models, current.combos);
    if (conflict) {
      const modelId = typeof conflict === "string" ? conflict : conflict.id;
      return {
        ok: false,
        error: `A route named ${customProviderModelId({ name: finalName }, modelId)} already exists`,
      };
    }
  }
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

handle("app:test-keyed-provider", async (_e, payload) => {
  const adapter = getAdapter(payload?.providerType);
  return testKeyedProvider(payload, { adapter: adapter || undefined, logger });
});

handle("app:remove-provider", async (_e, id) => {
  store.update((cfg) => {
    cfg.providers = cfg.providers.filter((p) => p.id !== id);
    for (const c of cfg.combos) {
      c.members = (c.members || []).filter((m) => m.providerId !== id);
    }
  });
  return { ok: true };
});

handle("app:set-provider-enabled", async (_e, { id, enabled }) => {
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

handle("app:usage", async (_e, period) => {
  const cfg = store.load();
  return {
    ok: true,
    usage: publicUsage(router.usageAggregate(period || "24h"), cfg),
    stats: publicStats(router.stats(), cfg),
  };
});

handle("app:quota-get", async () => {
  return { ok: true, quota: quota.current() };
});

handle("app:quota-refresh", async () => {
  return { ok: true, quota: await quota.refresh() };
});

handle("app:save-combo", async (_e, combo) => {
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

handle("app:delete-combo", async (_e, id) => {
  store.update((cfg) => {
    cfg.combos = cfg.combos.filter((c) => !comboMatchesId(c, id));
  });
  return { ok: true };
});

handle("app:set-server-enabled", async (_e, enabled) => {
  store.update((cfg) => {
    cfg.serverEnabled = !!enabled;
  });
  return { ok: true };
});

handle("app:set-bind-host", async (_e, bindHost) => {
  const h = bindHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
  store.update((cfg) => {
    cfg.bindHost = h;
  });
  try {
    await restartGateway();
    return { ok: true, bindHost: h };
  } catch (e) {
    return { ok: false, error: e.message, bindHost: h };
  }
});

handle("app:create-api-key", async (_e, name) => {
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

handle("app:revoke-api-key", async (_e, id) => {
  store.update((cfg) => {
    cfg.apiKeys = (cfg.apiKeys || []).filter((k) => k.id !== id);
    if (!cfg.apiKeys.length) {
      const key = generateApiKey();
      cfg.apiKeys = [
        { id: generateId("key"), key, name: "Default", createdAt: Date.now(), enabled: true },
      ];
    }
    cfg.apiKey = cfg.apiKeys.find((k) => k.enabled !== false)?.key || "";
  });
  return { ok: true, apiKeys: store.load().apiKeys };
});

handle("app:set-api-key-enabled", async (_e, { id, enabled }) => {
  store.update((cfg) => {
    const k = (cfg.apiKeys || []).find((x) => x.id === id);
    if (k) k.enabled = !!enabled;
    cfg.apiKey = cfg.apiKeys.find((x) => x.enabled !== false)?.key || "";
  });
  return { ok: true };
});

handle("app:set-model-enabled", async (_e, { providerId, modelId, enabled }) => {
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

handle("app:set-all-models-enabled", async (_e, { providerId, enabled }) => {
  let updated = 0;
  store.update((cfg) => {
    const provider = cfg.providers.find((item) => item.id === providerId);
    if (!provider || !Array.isArray(provider.models)) return;
    provider.models = provider.models.map((model) => {
      updated += 1;
      return typeof model === "string"
        ? { id: model, name: model, enabled: !!enabled }
        : { ...model, enabled: !!enabled };
    });
  });
  return { ok: updated > 0, updated, enabled: !!enabled };
});

handle("app:add-model", async (_e, { providerId, modelId }) => {
  const mid = String(modelId || "").trim();
  if (!mid) return { ok: false, error: "Model name required" };
  const cfg = store.load();
  const prov = (cfg.providers || []).find((p) => p.id === providerId);
  if (!prov) return { ok: false, error: "Provider not found" };
  if (prov.enabled === false) return { ok: false, error: "Provider is disabled" };
  if (isCustomProviderType(prov.type)) {
    const conflict = customModelRouteConflict(prov.name, [mid], cfg.combos);
    if (conflict) {
      return {
        ok: false,
        error: `A route named ${customProviderModelId(prov, mid)} already exists`,
      };
    }
  }

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
  const savedModel = store
    .load()
    .providers.find((provider) => provider.id === providerId)
    ?.models?.find((model) => (typeof model === "string" ? model : model.id) === mid);
  if (!savedModel || (typeof savedModel !== "string" && savedModel.enabled === false)) {
    return { ok: false, error: "Model passed its test but could not be saved" };
  }
  return { ok: true, modelId: mid };
});

handle("app:remove-model", async (_e, { providerId, modelId }) => {
  store.update((cfg) => {
    const p = cfg.providers.find((x) => x.id === providerId);
    if (!p || !Array.isArray(p.models)) return;
    p.models = p.models.filter((m) => (typeof m === "string" ? m : m.id) !== modelId);
  });
  return { ok: true };
});

handle("app:open-external", async (_e, url) => {
  if (!isAllowedExternalUrl(url)) {
    return { ok: false, error: "That external link is not allowed." };
  }
  if (runtime === "desktop") await openExternal(url);
  return { ok: true };
});

handle("app:update-check", async () =>
  getUpdateService()?.check() || {
    ok: false,
    error: "Updates are managed by the current distribution.",
  }
);

handle("app:update-install", async () => {
  const updateService = getUpdateService();
  if (!updateService || updateService.state().status !== "ready") {
    return { ok: false, error: "No downloaded update is ready" };
  }
  await gateway.stop();
  return updateService.install();
});

handle("app:hide-panel", async () => {
  await hidePanel();
  return { ok: true };
});

handle("app:quit", async () => {
  await quit();
  return { ok: true };
});

handle("app:regenerate-key", async () => {
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

  async function invoke(channel, args = [], context = {}) {
    const handler = handlers.get(channel);
    if (!handler) {
      return { ok: false, code: "unsupported_action", error: "Unsupported ReRouted action." };
    }
    const auth = context.sessionAuth || sessionAuth;
    const harness = context.harness === true || harnessModeEnabled();
    const cfg = store.load();
    if (!canInvoke(channel, cfg, auth, { harness })) {
      logger.warn("Blocked locked control-plane request", { channel });
      return lockedError();
    }
    return handler({ sessionAuth: auth, harness, runtime, platform }, ...args);
  }

  return {
    invoke,
    channels: () => [...handlers.keys()],
  };
}

module.exports = { createControlPlane };
