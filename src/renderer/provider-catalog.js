"use strict";

(function exposeProviderCatalog(root) {
  const TYPE_ALIASES = {
    codex: "chatgpt",
    custom: "custom",
    "openai-compat": "custom",
  };

  function canonicalProviderType(type) {
    const value = String(type || "").trim();
    if (!value) return "";
    return TYPE_ALIASES[value.toLowerCase()] || value;
  }

  function providerName(provider, fallback) {
    const name = String(provider?.name || "").trim();
    if (name) return name;
    return String(fallback || "Provider")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function buildProviderCatalog(source = {}) {
    const oauthProviders = Array.isArray(source.oauthProviders) ? source.oauthProviders : [];
    const keyedPresets = Array.isArray(source.keyedPresets) ? source.keyedPresets : [];
    const connectedProviders = Array.isArray(source.providers)
      ? source.providers
      : Array.isArray(source.connectedProviders)
        ? source.connectedProviders
        : [];
    const entries = [];
    const entriesById = new Map();

    for (const provider of oauthProviders) {
      const id = canonicalProviderType(provider?.id || provider?.type);
      if (!id || entriesById.has(id)) continue;
      const entry = {
        id,
        name: providerName(provider, id),
        kind: "oauth",
        accounts: [],
        oauthType: id,
      };
      entries.push(entry);
      entriesById.set(id, entry);
    }

    let customPreset = null;
    for (const preset of keyedPresets) {
      const id = canonicalProviderType(preset?.id || preset?.type);
      if (!id) continue;
      if (id === "custom") {
        customPreset ||= preset;
        continue;
      }
      if (entriesById.has(id)) continue;
      const entry = {
        id,
        name: providerName(preset, id),
        kind: "keyed",
        accounts: [],
        preset,
      };
      entries.push(entry);
      entriesById.set(id, entry);
    }

    const customEntry = {
      id: "custom",
      name: "Custom",
      kind: "custom",
      accounts: [],
    };
    if (customPreset) customEntry.preset = customPreset;
    entries.push(customEntry);
    entriesById.set(customEntry.id, customEntry);

    for (const account of connectedProviders) {
      const id = canonicalProviderType(account?.type) || "unknown";
      let entry = entriesById.get(id);
      if (!entry) {
        entry = {
          id,
          name: providerName(account, id),
          kind: "unknown",
          accounts: [],
        };
        entries.push(entry);
        entriesById.set(id, entry);
      }
      entry.accounts.push(account);
    }

    return entries;
  }

  const api = { buildProviderCatalog, canonicalProviderType };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReroutedProviderCatalog = api;
})(typeof window !== "undefined" ? window : null);
