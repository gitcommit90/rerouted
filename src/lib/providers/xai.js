"use strict";

const { OAUTH } = require("../constants");
const openaiCompat = require("./openai-compat");

const cfg = OAUTH.xai;

async function refreshToken(provider, { fetchImpl = fetch } = {}) {
  if (!provider.refreshToken) throw new Error("No xAI refresh token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: provider.refreshToken,
    client_id: cfg.clientId,
  });
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`xAI refresh failed: ${res.status} ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || provider.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
}

async function chat(provider, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const keyed = {
    baseUrl: "https://api.x.ai/v1",
    apiKey: provider.accessToken || provider.apiKey,
  };

  async function once() {
    keyed.apiKey = provider.accessToken || provider.apiKey;
    return openaiCompat.chat(keyed, opts);
  }

  let res = await once();
  if (res.status === 401 && provider.refreshToken) {
    const tokens = await refreshToken(provider, { fetchImpl });
    if (opts.onTokenRefresh) await opts.onTokenRefresh(tokens);
    Object.assign(provider, tokens);
    res = await once();
  }
  return res;
}

function listModels(provider) {
  return (provider.models || cfg.models).map((m) => ({ ...m }));
}

module.exports = { chat, listModels, refreshToken, cfg };
