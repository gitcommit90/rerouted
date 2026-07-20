"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  applyIdentity,
  identityFromTokens,
  mergeIdentity,
} = require("./oauth-identity");

function home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function localXaiIdentity(provider, authData) {
  const stored = identityFromTokens("xai", provider || {});
  const entries = Object.values(authData || {}).filter(
    (entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  );

  for (const entry of entries) {
    const identity = mergeIdentity(
      {
        email: entry.email,
        profileName:
          entry.name || [entry.first_name, entry.last_name].filter(Boolean).join(" "),
        accountId: entry.principal_id || entry.user_id,
      },
      identityFromTokens("xai", {
        accessToken: entry.key || entry.access_token || entry.accessToken,
        idToken: entry.id_token || entry.idToken,
      })
    );
    const sameAccount =
      (stored.accountId && identity.accountId && stored.accountId === identity.accountId) ||
      (provider?.accessToken &&
        provider.accessToken === (entry.key || entry.access_token || entry.accessToken));
    if (sameAccount) return identity;
  }
  return {};
}

function backfillLocalOAuthIdentities(providers, { xaiAuthData } = {}) {
  let authData = xaiAuthData;
  if (authData === undefined) {
    try {
      authData = JSON.parse(fs.readFileSync(path.join(home(), ".grok", "auth.json"), "utf8"));
    } catch {
      authData = null;
    }
  }

  let changed = false;
  for (const provider of providers || []) {
    if (provider?.type !== "xai" || (provider.email && provider.profileName)) continue;
    changed = applyIdentity(provider, localXaiIdentity(provider, authData)) || changed;
  }
  return changed;
}

module.exports = {
  localXaiIdentity,
  backfillLocalOAuthIdentities,
};
