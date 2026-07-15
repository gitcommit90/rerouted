"use strict";

const openaiCompat = require("./openai-compat");
const cloudflare = require("./cloudflare");
const claude = require("./claude");
const chatgpt = require("./chatgpt");
const antigravity = require("./antigravity");
const xai = require("./xai");
const { OAUTH } = require("../constants");
const { canonicalProviderType, isOAuthProvider } = require("../store");
const { isCustomProviderType, customProviderModelId } = require("../model-ids");

const TYPE_ADAPTER = {
  "openai-compat": openaiCompat,
  openrouter: openaiCompat,
  nvidia: openaiCompat,
  cloudflare,
  glm: openaiCompat,
  custom: openaiCompat,
  claude,
  chatgpt,
  codex: chatgpt, // alias — ChatGPT/Codex backend
  antigravity,
  xai,
};

function getAdapter(type) {
  return TYPE_ADAPTER[type] || null;
}

/** Build the public gateway model id while retaining provider-specific disambiguation. */
function modelIdFor(provider, model) {
  const mid = typeof model === "string" ? model : model.id;
  const base = canonicalProviderType(provider.type);
  if (isOAuthProvider(provider) && provider.accountAlias) {
    return `${base}/${provider.accountAlias}/${mid}`;
  }
  if (isCustomProviderType(provider.type)) {
    return customProviderModelId(provider, mid);
  }
  // Named keyed presets retain their stable provider-id disambiguator.
  const acc = (provider.id || "").replace(/^prov_/, "").slice(0, 8);
  if (acc) return `${base}/${acc}/${mid}`;
  return `${base}/${mid}`;
}

function sharedModelIdFor(provider, model) {
  const mid = typeof model === "string" ? model : model.id;
  return `${canonicalProviderType(provider.type)}/${mid}`;
}

/**
 * List models for a provider.
 * @param {{ includeDisabled?: boolean }} opts — when false (default), skip models with enabled===false
 */
function listProviderModels(provider, opts = {}) {
  const includeDisabled = !!opts.includeDisabled;
  if (!provider || provider.enabled === false) return [];
  const adapter = getAdapter(provider.type);
  if (!adapter) return [];
  // Prefer stored models. Never call async network listModels here —
  // listing must stay sync for /v1/models.
  let models = provider.models || [];
  if (!models.length && typeof adapter.listModels === "function") {
    try {
      const result = adapter.listModels(provider);
      if (Array.isArray(result)) models = result;
    } catch {
      models = [];
    }
  }
  if (!models.length) models = defaultModelsForType(provider.type);
  return models
    .map((m) => {
      const mid = typeof m === "string" ? m : m.id;
      const enabled = typeof m === "string" ? true : m.enabled !== false;
      return {
        id: modelIdFor(provider, m),
        object: "model",
        created: Math.floor((provider.createdAt || Date.now()) / 1000),
        owned_by: provider.type,
        name: typeof m === "string" ? m : m.name || m.id,
        providerId: provider.id,
        accountAlias: provider.accountAlias || null,
        upstreamModel: mid,
        enabled,
      };
    })
    .filter((m) => includeDisabled || m.enabled);
}

function listSharedProviderModels(providers) {
  const shared = new Map();
  for (const provider of providers || []) {
    if (!isOAuthProvider(provider) || provider.enabled === false) continue;
    for (const model of listProviderModels(provider, { includeDisabled: false })) {
      const id = sharedModelIdFor(provider, model.upstreamModel);
      const existing = shared.get(id);
      if (existing) {
        existing.accountAliases.push(provider.accountAlias);
        existing.providerIds.push(provider.id);
        continue;
      }
      shared.set(id, {
        id,
        object: "model",
        created: model.created,
        owned_by: canonicalProviderType(provider.type),
        name: model.name,
        providerId: null,
        providerIds: [provider.id],
        accountAlias: null,
        accountAliases: [provider.accountAlias],
        upstreamModel: model.upstreamModel,
        shared: true,
        enabled: true,
      });
    }
  }
  return [...shared.values()];
}

function defaultModelsForType(type) {
  if (OAUTH[type]) return OAUTH[type].models.map((m) => ({ ...m, enabled: true }));
  if (type === "codex") return OAUTH.chatgpt.models.map((m) => ({ ...m, enabled: true }));
  return [];
}

module.exports = {
  getAdapter,
  modelIdFor,
  sharedModelIdFor,
  listProviderModels,
  listSharedProviderModels,
  defaultModelsForType,
  TYPE_ADAPTER,
};
