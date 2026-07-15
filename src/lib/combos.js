"use strict";

const { isCustomProviderType, customProviderModelId } = require("./model-ids");

function publicComboId(combo) {
  const name = String(combo?.name || "").trim();
  return name || String(combo?.id || "");
}

function publicCombo(combo) {
  return { ...combo, id: publicComboId(combo), storageId: combo?.id || null };
}

function comboMatchesId(combo, id) {
  return combo?.id === id || publicComboId(combo) === id;
}

function publicRouteId(combos, id) {
  const combo = (combos || []).find((entry) => comboMatchesId(entry, id));
  return combo ? publicComboId(combo) : id;
}

function providerRouteIds(providers) {
  const ids = new Set();
  for (const provider of providers || []) {
    const type = String(provider?.type || "");
    const family = type === "codex" ? "chatgpt" : type;
    const account = String(provider?.id || "").replace(/^prov_/, "").slice(0, 8);
    const alias = String(provider?.accountAlias || "");
    for (const model of provider?.models || []) {
      const modelId = String(typeof model === "string" ? model : model?.id || "");
      if (!modelId) continue;
      ids.add(modelId.toLowerCase());
      ids.add(`${type}/${modelId}`.toLowerCase());
      ids.add(`${family}/${modelId}`.toLowerCase());
      if (isCustomProviderType(type)) {
        ids.add(customProviderModelId(provider, modelId).toLowerCase());
      }
      if (account) {
        ids.add(`${type}/${account}/${modelId}`.toLowerCase());
        ids.add(`${family}/${account}/${modelId}`.toLowerCase());
      }
      if (alias) ids.add(`${family}/${alias}/${modelId}`.toLowerCase());
    }
  }
  return ids;
}

function comboStorageIdConflict(combos, name) {
  const candidate = String(name || "").trim().toLowerCase();
  if (!candidate) return null;
  return (combos || []).find((combo) => String(combo?.id || "").toLowerCase() === candidate) || null;
}

function ensureUniqueComboNames(combos, reservedIds = new Set()) {
  const list = Array.isArray(combos) ? combos : [];
  const storageIds = new Set(list.map((combo) => String(combo?.id || "").toLowerCase()));
  const reserved = new Set([...reservedIds, ...storageIds].map((id) => String(id).toLowerCase()));
  const originalNames = new Set(
    list.map((combo) => String(combo?.name || "route").trim().toLowerCase()).filter(Boolean)
  );
  const used = new Set();

  for (const combo of list) {
    const base = String(combo?.name || "route").trim() || "route";
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate.toLowerCase()) || reserved.has(candidate.toLowerCase())) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
      while (originalNames.has(candidate.toLowerCase())) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
      }
    }
    combo.name = candidate;
    used.add(candidate.toLowerCase());
  }
  return list;
}

function comboNameConflict(combos, name, excludeIndex = -1) {
  const candidate = String(name || "").trim().toLowerCase();
  if (!candidate) return null;
  return (combos || []).find(
    (combo, index) => index !== excludeIndex && publicComboId(combo).trim().toLowerCase() === candidate
  ) || null;
}

module.exports = {
  publicComboId,
  publicCombo,
  comboMatchesId,
  publicRouteId,
  providerRouteIds,
  comboStorageIdConflict,
  ensureUniqueComboNames,
  comboNameConflict,
};
