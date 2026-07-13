"use strict";

const os = require("node:os");

const DEFAULT_TIMEOUT_MS = 15_000;

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function epochMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function quotaWindow(id, label, usedPercent, resetsAt, windowSeconds) {
  const used = clampPercent(usedPercent);
  if (used == null) return null;
  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: Math.max(0, 100 - used),
    resetsAt: epochMs(resetsAt),
    windowSeconds: Number(windowSeconds) || null,
  };
}

function parseCodexQuota(data) {
  const rate = data?.rate_limit || {};
  const windows = [];
  const primary = quotaWindow(
    "session",
    "Session",
    rate.primary_window?.used_percent,
    rate.primary_window?.reset_at,
    rate.primary_window?.limit_window_seconds
  );
  const weekly = quotaWindow(
    "weekly",
    "Weekly",
    rate.secondary_window?.used_percent,
    rate.secondary_window?.reset_at,
    rate.secondary_window?.limit_window_seconds
  );
  if (primary) windows.push(primary);
  if (weekly) windows.push(weekly);

  for (const [index, extra] of (data?.additional_rate_limits || []).entries()) {
    const title = extra?.limit_name || extra?.metered_feature || `Additional limit ${index + 1}`;
    const details = extra?.rate_limit || {};
    const short = quotaWindow(
      `extra-${index}-session`,
      `${title} session`,
      details.primary_window?.used_percent,
      details.primary_window?.reset_at,
      details.primary_window?.limit_window_seconds
    );
    const long = quotaWindow(
      `extra-${index}-weekly`,
      `${title} weekly`,
      details.secondary_window?.used_percent,
      details.secondary_window?.reset_at,
      details.secondary_window?.limit_window_seconds
    );
    if (short) windows.push(short);
    if (long) windows.push(long);
  }

  const credits = data?.credits || null;
  return {
    source: "ChatGPT quota API",
    plan: data?.plan_type || null,
    windows,
    credits: credits
      ? {
          balance: Number.isFinite(Number(credits.balance)) ? Number(credits.balance) : null,
          unlimited: !!credits.unlimited,
          hasCredits: !!credits.has_credits,
        }
      : null,
  };
}

function parseClaudeQuota(data) {
  const windows = [];
  const definitions = [
    ["session", "Session", data?.five_hour],
    ["weekly", "Weekly", data?.seven_day || data?.seven_day_oauth_apps],
    ["weekly-sonnet", "Sonnet weekly", data?.seven_day_sonnet],
    ["weekly-opus", "Opus weekly", data?.seven_day_opus],
    [
      "weekly-routines",
      "Routines weekly",
      data?.seven_day_routines ||
        data?.seven_day_claude_routines ||
        data?.claude_routines ||
        data?.routines ||
        data?.routine ||
        data?.seven_day_cowork ||
        data?.cowork,
    ],
  ];
  for (const [id, label, value] of definitions) {
    const item = quotaWindow(id, label, value?.utilization, value?.resets_at, null);
    if (item) windows.push(item);
  }
  for (const [index, limit] of (data?.limits || []).entries()) {
    if (limit?.is_active === false) continue;
    const label =
      limit?.scope?.model?.display_name || limit?.scope?.model?.id || limit?.kind || `Limit ${index + 1}`;
    const item = quotaWindow(
      `scoped-${index}`,
      label,
      limit?.percent,
      limit?.resets_at,
      null
    );
    if (item) windows.push(item);
  }

  const extra = data?.extra_usage;
  return {
    source: "Claude OAuth quota API",
    plan: data?.subscription_type || data?.rate_limit_tier || null,
    windows,
    credits: extra?.is_enabled
      ? {
          balance: null,
          unlimited: false,
          hasCredits: true,
          used: Number.isFinite(Number(extra.used_credits)) ? Number(extra.used_credits) / 100 : null,
          limit: Number.isFinite(Number(extra.monthly_limit)) ? Number(extra.monthly_limit) / 100 : null,
          currency: extra.currency || null,
        }
      : null,
  };
}

function parseAntigravityQuota(data, subscriptionInfo) {
  const windows = [];
  for (const [modelId, info] of Object.entries(data?.models || {})) {
    if (!info?.quotaInfo || info.isInternal) continue;
    const remaining = clampPercent(Number(info.quotaInfo.remainingFraction) * 100);
    if (remaining == null) continue;
    const item = quotaWindow(
      `model-${modelId}`,
      info.displayName || modelId,
      100 - remaining,
      info.quotaInfo.resetTime,
      null
    );
    if (item) windows.push({ ...item, modelId });
  }
  return {
    source: "Antigravity Cloud Code quota API",
    plan: subscriptionInfo?.currentTier?.name || subscriptionInfo?.currentTier?.id || null,
    windows,
    credits: null,
  };
}

function parseAntigravityQuotaBuckets(data) {
  const models = {};
  for (const bucket of data?.buckets || []) {
    const modelId = String(bucket?.modelId || bucket?.model_id || "").trim();
    const remainingFraction = Number(bucket?.remainingFraction);
    if (!modelId || !Number.isFinite(remainingFraction)) continue;
    const existing = models[modelId]?.quotaInfo?.remainingFraction;
    if (existing != null && existing <= remainingFraction) continue;
    models[modelId] = {
      displayName: modelId,
      quotaInfo: {
        remainingFraction,
        resetTime: bucket.resetTime || bucket.reset_time || null,
      },
    };
  }
  return { models };
}

function antigravityMetadata() {
  let platform = 0;
  if (process.platform === "darwin") platform = os.arch() === "arm64" ? 2 : 1;
  else if (process.platform === "linux") platform = os.arch() === "arm64" ? 4 : 3;
  else if (process.platform === "win32") platform = 5;
  return { ideType: 9, platform, pluginType: 2 };
}

async function responseJson(res) {
  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
    error.status = res.status;
    throw error;
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("Quota endpoint returned invalid JSON");
  }
}

async function fetchProviderQuota(provider, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!provider?.accessToken) {
    return { supported: false, note: "No OAuth access token available" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Quota refresh timed out")), timeoutMs);
  try {
    if (provider.type === "chatgpt" || provider.type === "codex") {
      const headers = {
        Authorization: `Bearer ${provider.accessToken}`,
        Accept: "application/json",
        "User-Agent": "codex_cli_rs/0.136.0",
        originator: "codex_cli_rs",
      };
      if (provider.accountId) headers["chatgpt-account-id"] = provider.accountId;
      const res = await fetchImpl("https://chatgpt.com/backend-api/wham/usage", {
        headers,
        signal: controller.signal,
      });
      return { supported: true, ...parseCodexQuota(await responseJson(res)) };
    }
    if (provider.type === "claude") {
      const res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          Authorization: `Bearer ${provider.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.0",
        },
        signal: controller.signal,
      });
      return { supported: true, ...parseClaudeQuota(await responseJson(res)) };
    }
    if (provider.type === "antigravity") {
      const commonHeaders = {
        Authorization: `Bearer ${provider.accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": `antigravity/1.107.0 ${process.platform}/${os.arch()}`,
        "x-request-source": "local",
      };
      let subscriptionInfo = null;
      try {
        const load = await fetchImpl(
          "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
          {
            method: "POST",
            headers: commonHeaders,
            body: JSON.stringify({ metadata: antigravityMetadata(), mode: 1 }),
            signal: controller.signal,
          }
        );
        if (load.ok) subscriptionInfo = await load.json();
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
      const project =
        provider.projectId ||
        subscriptionInfo?.cloudaicompanionProject?.id ||
        subscriptionInfo?.cloudaicompanionProject ||
        null;
      const res = await fetchImpl(
        "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
        {
          method: "POST",
          headers: {
            ...commonHeaders,
            "X-Client-Name": "antigravity",
            "X-Client-Version": "1.107.0",
          },
          body: JSON.stringify(project ? { project } : {}),
          signal: controller.signal,
        }
      );
      if (!res.ok && res.status !== 403) await responseJson(res);
      let parsed = res.ok
        ? parseAntigravityQuota(await responseJson(res), subscriptionInfo)
        : parseAntigravityQuota({}, subscriptionInfo);
      const needsVerification =
        res.status === 403 ||
        (parsed.windows.length > 0 &&
          parsed.windows.every((window) => window.remainingPercent >= 99.9));
      if (needsVerification) {
        const verified = await fetchImpl(
          "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
          {
            method: "POST",
            headers: commonHeaders,
            body: JSON.stringify(project ? { project } : {}),
            signal: controller.signal,
          }
        );
        if (!verified.ok) {
          return {
            supported: true,
            source: "Antigravity Cloud Code quota API",
            plan: parsed.plan,
            windows: [],
            credits: null,
            note: "Antigravity quota verification was unavailable for this account.",
          };
        }
        parsed = parseAntigravityQuota(
          parseAntigravityQuotaBuckets(await responseJson(verified)),
          subscriptionInfo
        );
      }
      const configured = new Set(
        (provider.models || []).map((model) => (typeof model === "string" ? model : model.id))
      );
      if (configured.size) {
        parsed.windows = parsed.windows.filter((window) => configured.has(window.modelId));
      }
      return {
        supported: true,
        ...parsed,
      };
    }
    if (provider.type === "xai") {
      return { supported: false, note: "xAI does not expose a supported OAuth quota endpoint" };
    }
    return {
      supported: false,
      note: "This provider does not expose a supported subscription quota endpoint yet",
    };
  } finally {
    clearTimeout(timer);
  }
}

function accountBase(provider) {
  return {
    providerId: provider.id,
    type: provider.type,
    name: provider.name || provider.type,
    accountAlias: provider.accountAlias || null,
    email: provider.email || null,
    profileName: provider.profileName || null,
    refreshedAt: null,
    source: null,
    plan: null,
    windows: [],
    credits: null,
  };
}

function createQuotaService({
  store,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  refreshProvider,
  now = () => Date.now(),
} = {}) {
  let snapshot = { refreshedAt: null, refreshing: false, accounts: [] };
  let pending = null;

  function quotaProviders() {
    const types = new Set(["chatgpt", "codex", "claude", "antigravity", "xai"]);
    return (store?.load()?.providers || []).filter(
      (provider) =>
        provider && provider.enabled !== false && provider.accessToken && types.has(provider.type)
    );
  }

  function configuredAccounts() {
    return quotaProviders().map((provider) => ({ ...accountBase(provider), status: "idle" }));
  }

  function current() {
    if (!snapshot.accounts.length) return { ...snapshot, accounts: configuredAccounts() };
    return snapshot;
  }

  async function refresh() {
    if (pending) return pending;
    snapshot = { ...current(), refreshing: true };
    pending = (async () => {
      const providers = quotaProviders();
      const accounts = await Promise.all(
        providers.map(async (provider) => {
          const base = accountBase(provider);
          let activeProvider = provider;
          try {
            if (
              refreshProvider &&
              provider.refreshToken &&
              provider.expiresAt &&
              provider.expiresAt < now() + 60_000
            ) {
              activeProvider = await refreshProvider(provider);
            }
            let quota;
            try {
              quota = await fetchProviderQuota(activeProvider, { fetchImpl, timeoutMs });
            } catch (error) {
              if (error?.status === 401 && refreshProvider && provider.refreshToken) {
                activeProvider = await refreshProvider(provider);
                quota = await fetchProviderQuota(activeProvider, { fetchImpl, timeoutMs });
              } else {
                throw error;
              }
            }
            return {
              ...base,
              ...quota,
              status: quota.supported ? (quota.windows.length ? "ok" : "empty") : "unsupported",
              refreshedAt: now(),
            };
          } catch (error) {
            return {
              ...base,
              status: "error",
              error: error?.message || String(error),
              refreshedAt: now(),
            };
          }
        })
      );
      snapshot = { refreshedAt: now(), refreshing: false, accounts };
      return snapshot;
    })().finally(() => {
      pending = null;
    });
    return pending;
  }

  return { current, refresh };
}

module.exports = {
  clampPercent,
  epochMs,
  parseCodexQuota,
  parseClaudeQuota,
  parseAntigravityQuota,
  parseAntigravityQuotaBuckets,
  fetchProviderQuota,
  createQuotaService,
};
