"use strict";

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function mergeIdentity(...values) {
  const merged = {};
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const email = stringValue(value.email);
    const profileName = stringValue(value.profileName);
    const accountId = stringValue(value.accountId);
    if (email && !merged.email) merged.email = email;
    if (profileName && !merged.profileName) merged.profileName = profileName;
    if (accountId && !merged.accountId) merged.accountId = accountId;
  }
  return merged;
}

function identityFromJwt(type, token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return {};

  if (type === "chatgpt" || type === "codex") {
    const profile = payload["https://api.openai.com/profile"] || {};
    const auth = payload["https://api.openai.com/auth"] || {};
    return {
      email: stringValue(profile.email) || stringValue(payload.email),
      profileName: stringValue(profile.name) || stringValue(payload.name),
      accountId:
        stringValue(auth.chatgpt_account_id) ||
        stringValue(payload.account_id),
    };
  }

  if (type === "xai") {
    const username = stringValue(payload.preferred_username);
    return {
      email: stringValue(payload.email) ||
        (String(username || "").includes("@") ? username : undefined),
      profileName:
        stringValue(payload.name) ||
        stringValue(payload.given_name) ||
        (username && !username.includes("@") ? username : undefined),
      accountId:
        stringValue(payload.principal_id) || stringValue(payload.user_id) || stringValue(payload.sub),
    };
  }

  return {};
}

function identityFromTokens(type, tokens = {}) {
  return mergeIdentity(
    identityFromJwt(type, tokens.idToken || tokens.id_token),
    identityFromJwt(type, tokens.accessToken || tokens.access_token)
  );
}

function identityFromProfile(type, profile = {}) {
  if (!profile || typeof profile !== "object") return {};

  if (type === "claude") {
    const account = profile.tokenAccount || profile.account || {};
    const organization = profile.organization || {};
    return {
      email:
        stringValue(profile.email_address) ||
        stringValue(profile.emailAddress) ||
        stringValue(account.email_address) ||
        stringValue(account.emailAddress) ||
        stringValue(account.email),
      profileName:
        stringValue(profile.name) ||
        stringValue(profile.display_name) ||
        stringValue(profile.displayName) ||
        stringValue(account.name) ||
        stringValue(organization.name) ||
        stringValue(profile.organization_name) ||
        stringValue(profile.organizationName),
      accountId:
        stringValue(profile.account_uuid) ||
        stringValue(profile.accountUuid) ||
        stringValue(account.uuid) ||
        stringValue(account.id),
    };
  }

  if (type === "antigravity") {
    return {
      email: stringValue(profile.email),
      profileName: stringValue(profile.name) || stringValue(profile.given_name),
      accountId: stringValue(profile.id) || stringValue(profile.sub),
    };
  }

  return {};
}

function applyIdentity(target, identity, { overwrite = false } = {}) {
  if (!target || !identity) return false;
  let changed = false;
  for (const key of ["email", "profileName", "accountId"]) {
    const value = stringValue(identity[key]);
    if (!value || (!overwrite && stringValue(target[key]))) continue;
    if (target[key] !== value) {
      target[key] = value;
      changed = true;
    }
  }
  return changed;
}

function backfillTokenIdentity(provider) {
  if (!provider) return false;
  const type = provider.type === "codex" ? "chatgpt" : provider.type;
  if (type !== "chatgpt" && type !== "xai") return false;
  return applyIdentity(provider, identityFromTokens(type, provider));
}

module.exports = {
  decodeJwtPayload,
  identityFromJwt,
  identityFromTokens,
  identityFromProfile,
  mergeIdentity,
  applyIdentity,
  backfillTokenIdentity,
};
