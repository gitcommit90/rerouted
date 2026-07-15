"use strict";

function isCustomProviderType(type) {
  const value = String(type || "").toLowerCase();
  return value === "openai-compat" || value === "custom";
}

function customConnectionName(provider) {
  return String(provider?.name || "").trim() || "Custom";
}

function customProviderModelId(provider, model) {
  const modelId = typeof model === "string" ? model : model?.id;
  return `${customConnectionName(provider)}/custom/${modelId}`;
}

function customModelRouteConflict(name, models = [], combos = []) {
  const routeIds = new Set(
    combos
      .map((combo) => String(combo?.name || combo?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const provider = { type: "openai-compat", name };
  return (
    models.find((model) => {
      const modelId = typeof model === "string" ? model : model?.id;
      return modelId && routeIds.has(customProviderModelId(provider, modelId).toLowerCase());
    }) || null
  );
}

function ensureUniqueCustomConnectionNames(providers = [], combos = []) {
  const used = new Set();
  for (const provider of providers) {
    if (!isCustomProviderType(provider?.type)) continue;
    const base = customConnectionName(provider);
    let candidate = base;
    let suffix = 2;
    while (
      used.has(candidate.toLowerCase()) ||
      customModelRouteConflict(candidate, provider.models, combos)
    ) {
      candidate = `${base} ${suffix}`;
      suffix += 1;
    }
    provider.name = candidate;
    used.add(candidate.toLowerCase());
  }
  return providers;
}

function customConnectionNameError(name, providers = []) {
  const candidate = String(name || "").trim();
  if (!candidate) return "Custom connection name required";
  if (candidate.includes("/")) return "Custom connection names cannot contain /";
  const duplicate = providers.some(
    (provider) =>
      isCustomProviderType(provider?.type) &&
      customConnectionName(provider).toLowerCase() === candidate.toLowerCase()
  );
  return duplicate ? `A custom connection named ${candidate} already exists` : null;
}

module.exports = {
  isCustomProviderType,
  customConnectionNameError,
  customConnectionName,
  customModelRouteConflict,
  customProviderModelId,
  ensureUniqueCustomConnectionNames,
};
