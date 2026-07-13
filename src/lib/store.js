"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { generateApiKey, generateId } = require("./password");
const { DEFAULT_PORT, OAUTH, RETIRED_OAUTH_MODELS } = require("./constants");
const { ensureUniqueComboNames, providerRouteIds } = require("./combos");

const CONFIG_VERSION = 6;
const COMBO_NAME_MIGRATION_VERSION = 5;
const XAI_LOCK_RESET_VERSION = 6;
const OAUTH_ALIAS_RE = /^oauth([1-9]\d*)$/;

function canonicalProviderType(type) {
  return type === "codex" ? "chatgpt" : type;
}

function isOAuthProvider(provider) {
  if (!provider) return false;
  return !!OAUTH[canonicalProviderType(provider.type)];
}

function ensureOAuthAliases(providers, counters = {}) {
  for (const family of Object.keys(counters)) {
    const value = Math.floor(Number(counters[family]));
    counters[family] = Number.isFinite(value) && value > 0 ? value : 0;
  }

  const groups = new Map();
  for (const provider of providers || []) {
    if (!isOAuthProvider(provider)) continue;
    const family = canonicalProviderType(provider.type);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(provider);
  }

  for (const accounts of groups.values()) {
    const family = canonicalProviderType(accounts[0]?.type);
    const ordered = accounts
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) => {
        const createdDiff = Number(a.provider.createdAt || 0) - Number(b.provider.createdAt || 0);
        if (createdDiff) return createdDiff;
        const idDiff = String(a.provider.id || "").localeCompare(String(b.provider.id || ""));
        return idDiff || a.index - b.index;
      });
    const used = new Set();
    let highWater = Number(counters[family]) || 0;

    for (const { provider } of ordered) {
      const match = OAUTH_ALIAS_RE.exec(String(provider.accountAlias || ""));
      if (!match || used.has(Number(match[1]))) {
        delete provider.accountAlias;
        continue;
      }
      const account = Number(match[1]);
      used.add(account);
      highWater = Math.max(highWater, account);
    }

    for (const { provider } of ordered) {
      if (provider.accountAlias) continue;
      do {
        highWater += 1;
      } while (used.has(highWater));
      provider.accountAlias = `oauth${highWater}`;
      used.add(highWater);
    }
    counters[family] = highWater;
  }
  return counters;
}

function normalizeModelLocks(provider, now = Date.now()) {
  const source = provider && provider.modelLocks;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    if (provider) provider.modelLocks = {};
    return;
  }
  for (const [model, lock] of Object.entries(source)) {
    const until = Number(lock && lock.until);
    if (!model || !Number.isFinite(until) || until <= now) delete source[model];
  }
}

function getActiveModelLock(provider, model, now = Date.now()) {
  const locks = [provider?.modelLocks?.[model], provider?.modelLocks?.["*"]]
    .filter((lock) => lock && Number(lock.until) > now)
    .sort((a, b) => Number(b.until) - Number(a.until));
  return locks[0] || null;
}

function mergeOAuthCatalog(provider) {
  if (!isOAuthProvider(provider)) return;
  const family = canonicalProviderType(provider.type);
  const catalog = OAUTH[family]?.models || [];
  const existing = new Map((provider.models || []).map((model) => [model.id, model]));
  const catalogIds = new Set(catalog.map((model) => model.id));
  const retiredIds = new Set(RETIRED_OAUTH_MODELS[family] || []);
  provider.models = [
    ...catalog.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      enabled: existing.get(model.id)?.enabled !== false,
    })),
    ...(provider.models || []).filter(
      (model) => !catalogIds.has(model.id) && !retiredIds.has(model.id)
    ),
  ];
}

function defaultConfig() {
  const key = generateApiKey();
  return {
    version: CONFIG_VERSION,
    onboardingComplete: false,
    onboardingStep: "permissions",
    adminPasswordHash: null,
    openAtLogin: false,
    port: DEFAULT_PORT,
    apiKey: key,
    apiKeys: [
      {
        id: generateId("key"),
        key,
        name: "Default",
        createdAt: Date.now(),
        enabled: true,
      },
    ],
    bindHost: "127.0.0.1",
    serverEnabled: true,
    providers: [],
    providerAliasCounters: {},
    combos: [],
  };
}

function migrate(cfg) {
  if (!cfg || typeof cfg !== "object") return defaultConfig();
  const sourceVersion = Number(cfg.version) || 1;
  const needsComboNameMigration = sourceVersion < COMBO_NAME_MIGRATION_VERSION;
  const needsXaiLockReset = sourceVersion < XAI_LOCK_RESET_VERSION;

  if (!Array.isArray(cfg.providers)) cfg.providers = [];

  if (!Array.isArray(cfg.apiKeys) || !cfg.apiKeys.length) {
    const k = cfg.apiKey || generateApiKey();
    cfg.apiKeys = [
      {
        id: generateId("key"),
        key: k,
        name: "Default",
        createdAt: Date.now(),
        enabled: true,
      },
    ];
    cfg.apiKey = k;
  } else {
    const primary = cfg.apiKeys.find((k) => k.enabled !== false) || cfg.apiKeys[0];
    if (primary) cfg.apiKey = primary.key;
  }
  if (!cfg.bindHost) cfg.bindHost = "127.0.0.1";
  if (!cfg.providerAliasCounters || typeof cfg.providerAliasCounters !== "object") {
    cfg.providerAliasCounters = {};
  }

  for (const p of cfg.providers || []) {
    normalizeModelLocks(p);
    if (needsXaiLockReset && canonicalProviderType(p.type) === "xai") {
      p.modelLocks = {};
    }
    if (!Array.isArray(p.models)) p.models = [];
    p.models = p.models.map((m) => {
      if (typeof m === "string") return { id: m, name: m, enabled: true };
      return {
        id: m.id,
        name: m.name || m.id,
        enabled: m.enabled !== false,
      };
    });
    mergeOAuthCatalog(p);
  }

  ensureOAuthAliases(cfg.providers, cfg.providerAliasCounters);

  if (!Array.isArray(cfg.combos)) cfg.combos = [];
  if (needsComboNameMigration) {
    ensureUniqueComboNames(cfg.combos, providerRouteIds(cfg.providers));
  }

  cfg.version = Math.max(Number(cfg.version) || 1, CONFIG_VERSION);
  return cfg;
}

function createStore(filePath) {
  let cache = null;

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  }

  function load() {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const before = JSON.stringify(parsed);
      cache = migrate(parsed);
      if (JSON.stringify(cache) !== before) save(cache);
    } catch {
      cache = defaultConfig();
      save(cache);
    }
    return cache;
  }

  function save(cfg) {
    ensureDir();
    const next = migrate(cfg || cache || defaultConfig());
    const primary = (next.apiKeys || []).find((k) => k.enabled !== false);
    if (primary) next.apiKey = primary.key;
    cache = next;
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* ignore */
    }
    return cache;
  }

  function update(mutator) {
    const cfg = load();
    const result = mutator(cfg);
    save(cfg);
    return result === undefined ? cfg : result;
  }

  function getPath() {
    return filePath;
  }

  function reset() {
    cache = defaultConfig();
    save(cache);
    return cache;
  }

  function seed(partial) {
    cache = migrate({ ...defaultConfig(), ...partial });
    save(cache);
    return cache;
  }

  return { load, save, update, getPath, reset, seed, defaultConfig, migrate };
}

module.exports = {
  createStore,
  defaultConfig,
  migrate,
  canonicalProviderType,
  isOAuthProvider,
  ensureOAuthAliases,
  getActiveModelLock,
  mergeOAuthCatalog,
};
