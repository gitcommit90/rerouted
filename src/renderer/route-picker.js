"use strict";

(function exposeRoutePicker(root) {
  function enabledModelOptions(provider) {
    const models = [];
    for (const model of provider?.models || []) {
      if (typeof model !== "string" && model?.enabled === false) continue;
      const id = typeof model === "string" ? model : model?.id;
      if (!id) continue;
      models.push({
        id,
        name: typeof model === "string" ? model : model.name || id,
        gatewayId: typeof model === "string" ? null : model.gatewayId || null,
        providerId: provider.id,
        upstreamModel: id,
      });
    }
    return models;
  }

  function buildRouteAccountOptions(providers) {
    const accounts = [];
    for (const provider of providers || []) {
      if (!provider?.id || provider.enabled === false) continue;
      const models = enabledModelOptions(provider);
      if (!models.length) continue;
      accounts.push({
        id: provider.id,
        name: String(provider.name || provider.type || "Account").trim() || "Account",
        accountAlias: provider.accountAlias || null,
        providerType: provider.type || "",
        models,
      });
    }
    const duplicateGroups = new Map();
    for (const account of accounts) {
      if (account.accountAlias) continue;
      const key = `${account.providerType}:${account.name}`.toLowerCase();
      if (!duplicateGroups.has(key)) duplicateGroups.set(key, []);
      duplicateGroups.get(key).push(account);
    }
    for (const group of duplicateGroups.values()) {
      if (group.length < 2) continue;
      group.forEach((account, index) => {
        account.connectionIndex = index + 1;
        account.connectionCount = group.length;
      });
    }
    return accounts;
  }

  function modelsForRouteAccount(accounts, accountId) {
    return (accounts || []).find((account) => account.id === accountId)?.models || [];
  }

  function moveRouteMember(members, fromIndex, toIndex) {
    if (!Array.isArray(members)) return members;
    const from = Number(fromIndex);
    const to = Number(toIndex);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < 0 ||
      from >= members.length ||
      to >= members.length ||
      from === to
    ) {
      return members;
    }
    const [member] = members.splice(from, 1);
    members.splice(to, 0, member);
    return members;
  }

  const api = { buildRouteAccountOptions, modelsForRouteAccount, moveRouteMember };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReroutedRoutePicker = api;
})(typeof window !== "undefined" ? window : null);
