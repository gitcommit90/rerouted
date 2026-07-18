"use strict";

const {
  getAdapter,
  listProviderModels,
  listSharedProviderModels,
  modelIdFor,
  sharedModelIdFor,
} = require("./providers");
const claude = require("./providers/claude");
const chatgpt = require("./providers/chatgpt");
const antigravity = require("./providers/antigravity");
const { REQUEST_TIMEOUT_MS, KEYED_PRESETS, OAUTH } = require("./constants");
const { extractUsage } = require("./usage");
const appLogger = require("./logger");
const { canonicalProviderType, isOAuthProvider, getActiveModelLock } = require("./store");
const { publicComboId, comboMatchesId } = require("./combos");
const { createSseParser } = require("./sse");
const ANTHROPIC_METADATA = Symbol.for("rerouted.anthropic.metadata");

const COOLDOWN_MS = {
  quota: 60_000,
  auth: 2 * 60_000,
  transient: 30_000,
};

function createRequestLog(max = 50) {
  const items = [];
  return {
    push(entry) {
      items.unshift({ ...entry, at: Date.now() });
      if (items.length > max) items.length = max;
    },
    list() {
      return items.slice();
    },
    count() {
      return items.length;
    },
  };
}

function accountNumber(provider) {
  const match = /^oauth(\d+)$/.exec(String(provider?.accountAlias || ""));
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareAccounts(a, b) {
  const aliasDiff = accountNumber(a) - accountNumber(b);
  if (aliasDiff) return aliasDiff;
  const createdDiff = Number(a?.createdAt || 0) - Number(b?.createdAt || 0);
  if (createdDiff) return createdDiff;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function providerHasModel(provider, upstreamModel) {
  return listProviderModels(provider, { includeDisabled: false }).some(
    (model) => model.upstreamModel === upstreamModel
  );
}

function accountCandidatesFor(cfg, preferredProvider, upstreamModel, { preferRequested = true } = {}) {
  if (!preferredProvider || !isOAuthProvider(preferredProvider)) return preferredProvider ? [preferredProvider] : [];
  const family = canonicalProviderType(preferredProvider.type);
  const candidates = (cfg.providers || [])
    .filter(
      (provider) =>
        provider.enabled !== false &&
        isOAuthProvider(provider) &&
        canonicalProviderType(provider.type) === family &&
        providerHasModel(provider, upstreamModel)
    )
    .sort(compareAccounts);
  if (!preferRequested || candidates[0]?.id === preferredProvider.id) return candidates;
  const requested = candidates.find((provider) => provider.id === preferredProvider.id);
  return requested
    ? [requested, ...candidates.filter((provider) => provider.id !== requested.id)]
    : candidates;
}

function makeMember(cfg, provider, upstreamModel, opts) {
  return {
    provider,
    upstreamModel,
    accounts: accountCandidatesFor(cfg, provider, upstreamModel, opts),
  };
}

function resolveTargets(cfg, modelId) {
  const combo = (cfg.combos || []).find((c) => comboMatchesId(c, modelId));
  if (combo) {
    const members = (combo.members || [])
      .map((m) => {
        if (typeof m === "string") {
          return resolveSingle(cfg, m);
        }
        const prov = (cfg.providers || []).find((p) => p.id === m.providerId);
        if (!prov || prov.enabled === false) return null;
        // Skip disabled models on the provider
        const models = prov.models || [];
        const mid = m.model || m.upstreamModel;
        const modelEntry = models.find((x) => (typeof x === "string" ? x : x.id) === mid);
        if (modelEntry && typeof modelEntry !== "string" && modelEntry.enabled === false) {
          return null;
        }
        return makeMember(cfg, prov, mid, { preferRequested: true });
      })
      .filter(Boolean);
    return {
      kind: "combo",
      combo,
      strategy: combo.strategy || "fallback",
      members,
    };
  }
  const single = resolveSingle(cfg, modelId);
  if (!single) return null;
  return { kind: "single", members: [single], strategy: "fallback" };
}

function resolveSingle(cfg, modelId) {
  // Account-specific human model ids, e.g. chatgpt/oauth2/gpt-5.4.
  for (const prov of cfg.providers || []) {
    if (prov.enabled === false) continue;
    for (const m of listProviderModels(prov, { includeDisabled: false })) {
      const storedAccount = String(prov.id || "").replace(/^prov_/, "").slice(0, 8);
      const storedIds = storedAccount
        ? new Set([
            `${prov.type}/${storedAccount}/${m.upstreamModel}`,
            `${canonicalProviderType(prov.type)}/${storedAccount}/${m.upstreamModel}`,
          ])
        : new Set();
      if (m.id === modelId || storedIds.has(modelId)) {
        return makeMember(cfg, prov, m.upstreamModel, { preferRequested: true });
      }
    }
  }

  // Shared OAuth route, e.g. chatgpt/gpt-5.4, starts with oauth1 and fills forward.
  for (const prov of (cfg.providers || []).slice().sort(compareAccounts)) {
    if (prov.enabled === false || !isOAuthProvider(prov)) continue;
    for (const m of listProviderModels(prov, { includeDisabled: false })) {
      if (sharedModelIdFor(prov, m.upstreamModel) === modelId) {
        return makeMember(cfg, prov, m.upstreamModel, { preferRequested: false });
      }
    }
  }

  // Backward-compatible raw ids for keyed providers and older clients.
  for (const prov of cfg.providers || []) {
    if (prov.enabled === false) continue;
    const models = prov.models || [];
    for (const m of models) {
      const mid = typeof m === "string" ? m : m.id;
      const enabled = typeof m === "string" ? true : m.enabled !== false;
      if (!enabled) continue;
      if (
        mid === modelId ||
        modelId === `${prov.type}/${mid}` ||
        modelId === `${canonicalProviderType(prov.type)}/${mid}`
      ) {
        return makeMember(cfg, prov, mid, {
          preferRequested: modelId !== `${canonicalProviderType(prov.type)}/${mid}`,
        });
      }
    }
  }
  return null;
}

function orderMembers(resolved, rrState) {
  const members = resolved.members.slice();
  if (!members.length) return members;
  if (resolved.strategy === "round-robin" && resolved.combo) {
    const key = resolved.combo.id;
    const idx = rrState.get(key) || 0;
    rrState.set(key, (idx + 1) % members.length);
    return members.slice(idx).concat(members.slice(0, idx));
  }
  return members;
}

function isRetryableStatus(status) {
  return !(status >= 200 && status < 300);
}

function humanProviderName(attempt) {
  const name = String(attempt?.providerName || "").trim();
  if (name && !/^prov_/i.test(name)) return name;
  const type = canonicalProviderType(attempt?.providerType);
  return OAUTH[type]?.name || KEYED_PRESETS[type]?.name || type || "Disconnected account";
}

function attemptLabel(attempt) {
  const provider = humanProviderName(attempt);
  return attempt?.accountAlias ? `${provider} (${attempt.accountAlias})` : provider;
}

function errorMessageFromText(text, fallback = "") {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
    const parts = [
      error?.message,
      error?.detail,
      error?.type,
      error?.code,
      parsed?.message,
      parsed?.detail,
    ]
      .filter((part) => typeof part === "string" && part.trim());
    if (parts.length) return [...new Set(parts)].join(" ");
    if (typeof parsed?.error === "string") return parsed.error;
  } catch {
    /* plain-text upstream error */
  }
  return String(text).slice(0, 500);
}

function classifyFailure(status, errorText) {
  const text = String(errorText || "").toLowerCase();
  const quota =
    status === 429 ||
    /rate[ _-]?limit|too many requests|quota|usage[ _-]?limit|resource[ _-]?exhaust|capacity|overload/.test(text);
  if (quota) return { eligible: true, kind: "quota", defaultCooldownMs: COOLDOWN_MS.quota };
  const capability =
    (status === 400 || status === 404 || status === 422) &&
    (/(?:unsupported|invalid|unknown)[ _-]?model|model[ _-]?(?:not[ _-]?found|unsupported|unavailable)/.test(
      text
    ) ||
      /\bmodel\b.{0,160}\b(?:is |are )?(?:not supported|not available|unavailable|not found|unknown|does not exist)\b/.test(
        text
      ) ||
      /\b(?:does not|doesn't|cannot|can't) support\b.{0,160}\bmodel\b/.test(text));
  if (capability) {
    return { eligible: true, kind: "capability", defaultCooldownMs: 0 };
  }
  if (status === 401 || status === 403) {
    return { eligible: true, kind: "auth", defaultCooldownMs: COOLDOWN_MS.auth };
  }
  if (status === 408 || status >= 500) {
    return { eligible: true, kind: "transient", defaultCooldownMs: COOLDOWN_MS.transient };
  }
  return { eligible: false, kind: "request", defaultCooldownMs: 0 };
}

function parseResetHint(response, bodyText, now = Date.now()) {
  const candidates = [];
  const addEpoch = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms > now) candidates.push(ms);
  };
  const addDelay = (value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) candidates.push(now + n * 1000);
  };

  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) addDelay(seconds);
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date) && date > now) candidates.push(date);
    }
  }
  addEpoch(response?.headers?.get?.("x-ratelimit-reset"));
  addDelay(response?.headers?.get?.("x-ratelimit-reset-after"));

  try {
    const parsed = JSON.parse(bodyText || "{}");
    const error = parsed?.error && typeof parsed.error === "object" ? parsed.error : parsed;
    addEpoch(error?.resets_at ?? error?.reset_at ?? error?.resetAt);
    addDelay(error?.resets_in_seconds ?? error?.retry_after ?? error?.retryAfter);
  } catch {
    /* no structured reset hint */
  }

  return candidates.length ? Math.max(...candidates) : null;
}

function parseEarlyResponsesFailure(text, response) {
  const events = String(text || "").split(/\r?\n\r?\n/);
  for (const event of events) {
    const eventType = event
      .split(/\r?\n/)
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const dataText = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!dataText || dataText === "[DONE]") continue;
    let data;
    try {
      data = JSON.parse(dataText);
    } catch {
      continue;
    }
    const error = data?.error && typeof data.error === "object"
      ? data.error
      : data?.response?.error && typeof data.response.error === "object"
        ? data.response.error
        : data;
    const explicitFailure =
      eventType === "error" ||
      data?.type === "error" ||
      data?.type === "response.failed" ||
      !!data?.error ||
      !!data?.response?.error;
    if (!explicitFailure) continue;
    const signature = [data?.type, error?.type, error?.code, error?.message]
      .filter(Boolean)
      .join(" ");
    const quota =
      /usage[ _-]?limit|rate[ _-]?limit|quota|resource[ _-]?exhaust|insufficient[ _-]?quota/i.test(
        signature
      );
    const reportedStatus = Number(error?.status ?? data?.status);
    const status =
      Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599
        ? reportedStatus
        : quota
          ? 429
          : 502;
    const message =
      error?.message || data?.message || error?.code || error?.type || "Upstream stream failed";
    return {
      status,
      error: message,
      resetAt: parseResetHint(response, JSON.stringify(error)),
    };
  }
  return null;
}

function nonStreamingFailure(text, response) {
  const bodyText = String(text || "").trim();
  let status = 502;
  let error = bodyText || "Upstream returned a non-streaming response to a streaming request";
  try {
    const parsed = JSON.parse(bodyText);
    const upstream =
      parsed?.error && typeof parsed.error === "object"
        ? parsed.error
        : parsed?.response?.error && typeof parsed.response.error === "object"
          ? parsed.response.error
          : parsed;
    const reportedStatus = Number(upstream?.status ?? parsed?.status);
    if (Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599) {
      status = reportedStatus;
    }
    error =
      upstream?.message ||
      upstream?.detail ||
      upstream?.code ||
      upstream?.type ||
      error;
  } catch {
    /* preserve the plain-text upstream response */
  }
  return {
    status,
    error: String(error).slice(0, 500),
    resetAt: parseResetHint(response, bodyText),
  };
}

function hasProductiveResponsesEvent(text) {
  const events = String(text || "").split(/\r?\n\r?\n/);
  for (const event of events) {
    const dataText = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!dataText || dataText === "[DONE]") continue;
    try {
      const data = JSON.parse(dataText);
      const type = String(data?.type || "");
      if (
        type === "response.output_text.delta" &&
        ((typeof data?.delta === "string" && data.delta.length > 0) ||
          (typeof data?.delta?.text === "string" && data.delta.text.length > 0))
      ) {
        return true;
      }
      if (
        type === "response.function_call_arguments.delta" &&
        typeof data?.delta === "string" &&
        data.delta.length > 0
      ) {
        return true;
      }
      if (
        (type === "response.output_item.added" || type === "response.output_item.done") &&
        (data?.item?.type === "function_call" || data?.item?.type === "custom_tool_call") &&
        typeof data.item.name === "string" &&
        data.item.name.length > 0
      ) {
        return true;
      }
      if (
        type === "content_block_start" &&
        data?.content_block?.type === "tool_use" &&
        typeof data.content_block.name === "string" &&
        data.content_block.name.length > 0
      ) {
        return true;
      }
      if (
        type === "content_block_delta" &&
        [data?.delta?.text, data?.delta?.partial_json].some(
          (value) => typeof value === "string" && value.length > 0
        )
      ) {
        return true;
      }
      const choices = Array.isArray(data?.choices) ? data.choices : [];
      if (
        choices.some(
          (choice) =>
            (typeof choice?.delta?.content === "string" && choice.delta.content.length > 0) ||
            (typeof choice?.delta?.refusal === "string" && choice.delta.refusal.length > 0) ||
            (typeof choice?.delta?.reasoning_content === "string" &&
              choice.delta.reasoning_content.length > 0) ||
            (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0)
        )
      ) {
        return true;
      }
      const candidates = data?.candidates || data?.response?.candidates;
      if (
        Array.isArray(candidates) &&
        candidates.some(
          (candidate) =>
            (candidate?.content?.parts || []).some(
              (part) =>
                (typeof part?.text === "string" && part.text.length > 0) ||
                (typeof part?.functionCall?.name === "string" && part.functionCall.name.length > 0)
            )
        )
      ) {
        return true;
      }
    } catch {
      /* wait for a complete JSON event */
    }
  }
  return false;
}

function isUsableChatCompletion(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    Array.isArray(payload.choices) &&
    payload.choices.some(
      (choice) => {
        const message = choice?.message;
        if (!message || typeof message !== "object") return false;
        if (typeof message.content === "string" && message.content.length > 0) return true;
        if (Array.isArray(message.content) && message.content.length > 0) return true;
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
        if (message.function_call && typeof message.function_call === "object") return true;
        if (typeof message.refusal === "string" && message.refusal.length > 0) return true;
        return false;
      }
    )
  );
}

function parseSseError(text) {
  const events = String(text || "").split(/\r?\n\r?\n/);
  for (const event of events) {
    const eventType = event
      .split(/\r?\n/)
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const dataText = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!dataText || dataText === "[DONE]") continue;
    try {
      const data = JSON.parse(dataText);
      const upstream =
        data?.error && typeof data.error === "object"
          ? data.error
          : data?.response?.error && typeof data.response.error === "object"
            ? data.response.error
            : data;
      if (eventType !== "error" && data?.type !== "error" && !data?.error && !data?.response?.error) {
        continue;
      }
      return upstream?.message || upstream?.code || upstream?.type || "Upstream stream failed";
    } catch {
      if (eventType === "error") return dataText;
    }
  }
  return null;
}

async function pipeOpenAiCompatibleSse(upstreamBody, clientRes) {
  if (!upstreamBody) return null;
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let pending = "";
  let streamUsage = null;
  const inspect = (chunk) => {
    const text = decoder.decode(chunk, { stream: true });
    pending += text;
    const error = parseSseError(pending);
    if (error) throw new Error(error);
    for (const event of parser.push(text)) {
      if (event.data === "[DONE]") continue;
      try {
        const data = JSON.parse(event.data);
        if (data?.usage) streamUsage = data.usage;
      } catch {
        /* passthrough streams may contain provider-specific non-JSON events */
      }
    }
    if (pending.length > 128 * 1024) pending = pending.slice(-64 * 1024);
  };

  if (upstreamBody[Symbol.asyncIterator]) {
    for await (const chunk of upstreamBody) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      clientRes.write(bytes);
      inspect(bytes);
    }
    return streamUsage;
  }
  if (upstreamBody.getReader) {
    const reader = upstreamBody.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      clientRes.write(Buffer.from(value));
      inspect(value);
    }
  }
  return streamUsage;
}

function rebuildResponseWithPrelude(response, chunks, reader) {
  let index = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function inspectEarlyResponsesSse(response) {
  if (!response?.ok || !response.body?.getReader) return { response, failure: null };
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (contentType && !contentType.includes("text/event-stream")) {
    const text = await response.text().catch(() => "");
    try {
      const payload = JSON.parse(text);
      if (isUsableChatCompletion(payload)) {
        return { response: null, failure: null, openAiJson: payload };
      }
    } catch {
      /* classify the non-streaming body below */
    }
    return { response: null, failure: nonStreamingFailure(text, response) };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let text = "";
  let done = false;
  while (true) {
    const next = await reader.read();
    done = next.done;
    if (done) break;
    chunks.push(next.value);
    text += decoder.decode(next.value, { stream: true });
    const failure = parseEarlyResponsesFailure(text, response);
    if (failure) {
      await reader.cancel().catch(() => {});
      return { response: null, failure };
    }
    // Metadata events such as response.created can precede a quota error.
    // Hold the stream until actual output (or completion) proves the account usable.
    if (hasProductiveResponsesEvent(text)) break;
  }

  if (done) {
    try {
      const payload = JSON.parse(text);
      if (isUsableChatCompletion(payload)) {
        return { response: null, failure: null, openAiJson: payload };
      }
    } catch {
      /* the completed body may be SSE */
    }
    if (!hasProductiveResponsesEvent(text)) {
      return {
        response: null,
        failure: {
          status: 502,
          error: "Upstream stream ended before producing a usable response",
          resetAt: null,
        },
      };
    }
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      failure: null,
    };
  }
  return { response: rebuildResponseWithPrelude(response, chunks, reader), failure: null };
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const msg = String(err.message || err);
  return /aborted|timeout|TimeoutError/i.test(msg);
}

function memberSignal(outer, timeoutMs) {
  const ms = timeoutMs ?? REQUEST_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  let timer = setTimeout(() => {
    timedOut = true;
    try {
      ctrl.abort(new Error("Upstream request timeout"));
    } catch {
      ctrl.abort();
    }
  }, ms);
  const onOuter = () => {
    try {
      ctrl.abort(outer?.reason || new Error("aborted"));
    } catch {
      ctrl.abort();
    }
  };
  if (outer) {
    if (outer.aborted) onOuter();
    else outer.addEventListener("abort", onOuter, { once: true });
  }
  const clearRequestTimeout = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  return {
    signal: ctrl.signal,
    clearRequestTimeout,
    cleanup: () => {
      clearRequestTimeout();
      if (outer) outer.removeEventListener("abort", onOuter);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

/**
 * @param {{ store, fetchImpl?, requestLog?, timeoutMs?, usage?, logger? }} opts
 */
function createRouter({ store, fetchImpl = fetch, requestLog, timeoutMs, usage, logger = appLogger } = {}) {
  const rrState = new Map();
  const log = requestLog || createRequestLog();
  let totalRequests = 0;
  const memberTimeoutMs = timeoutMs ?? REQUEST_TIMEOUT_MS;

  function getConfig() {
    return store.load();
  }

  function recordEvent(entry) {
    log.push(entry);
    if (usage && typeof usage.record === "function") {
      try {
        usage.record(entry);
      } catch (e) {
        console.error("usage.record failed:", e.message);
      }
    }
  }

  function listModels() {
    const cfg = getConfig();
    const data = [];
    const comboIds = new Set(
      (cfg.combos || []).map((combo) => publicComboId(combo).toLowerCase())
    );
    for (const prov of cfg.providers || []) {
      if (prov.enabled === false || isOAuthProvider(prov)) continue;
      data.push(
        ...listProviderModels(prov, { includeDisabled: false }).filter(
          (model) => !comboIds.has(String(model.id).toLowerCase())
        )
      );
    }
    data.push(
      ...listSharedProviderModels(cfg.providers).filter(
        (model) => !comboIds.has(String(model.id).toLowerCase())
      )
    );
    for (const combo of cfg.combos || []) {
      data.push({
        id: publicComboId(combo),
        object: "model",
        created: Math.floor((combo.createdAt || Date.now()) / 1000),
        owned_by: "rerouted",
        name: combo.name || combo.id,
        combo: true,
      });
    }
    return { object: "list", data };
  }

  async function persistProviderTokens(providerId, tokens) {
    store.update((cfg) => {
      const p = cfg.providers.find((x) => x.id === providerId);
      if (p) Object.assign(p, tokens);
    });
  }

  function persistModelLock(provider, upstreamModel, result) {
    if (
      !provider?.id ||
      !isOAuthProvider(provider) ||
      !result?.cooldownEligible ||
      result.failureKind === "capability"
    ) {
      return null;
    }
    const now = Date.now();
    const until = result.resetAt || now + result.defaultCooldownMs;
    const lock = {
      until,
      status: result.status,
      kind: result.failureKind,
      reason: String(result.error || "Upstream account failure").slice(0, 500),
      failedAt: now,
      resetHint: !!result.resetAt,
    };
    store.update((cfg) => {
      const saved = (cfg.providers || []).find((entry) => entry.id === provider.id);
      if (!saved) return;
      if (!saved.modelLocks || typeof saved.modelLocks !== "object") saved.modelLocks = {};
      saved.modelLocks[upstreamModel] = lock;
      if (result.failureKind === "quota") saved.modelLocks["*"] = lock;
    });
    return lock;
  }

  function clearModelLock(providerId, upstreamModel) {
    const current = (getConfig().providers || []).find((entry) => entry.id === providerId);
    if (!current?.modelLocks?.[upstreamModel]) return;
    store.update((cfg) => {
      const provider = (cfg.providers || []).find((entry) => entry.id === providerId);
      if (!provider?.modelLocks?.[upstreamModel]) return;
      delete provider.modelLocks[upstreamModel];
    });
  }

  async function tryMember(member, body, stream, outerSignal) {
    const { provider, upstreamModel } = member;
    const adapter = getAdapter(provider.type);
    if (!adapter) {
      return { ok: false, status: 500, error: `Unknown provider type ${provider.type}`, retryable: false };
    }

    const onTokenRefresh = async (tokens) => {
      await persistProviderTokens(provider.id, tokens);
    };

    if (
      provider.expiresAt &&
      provider.expiresAt < Date.now() + 60_000 &&
      provider.refreshToken &&
      typeof adapter.refreshToken === "function"
    ) {
      try {
        const tokens = await adapter.refreshToken(provider, { fetchImpl });
        Object.assign(provider, tokens);
        await persistProviderTokens(provider.id, tokens);
      } catch {
        /* will fail on request */
      }
    }

    const bound = memberSignal(outerSignal, memberTimeoutMs);
    let cleanupDeferred = false;
    try {
      const result = await adapter.chat(provider, {
        model: upstreamModel,
        body,
        stream,
        signal: bound.signal,
        fetchImpl,
        onTokenRefresh,
      });

      let res = result && result.response ? result.response : result;
      const meta = result && result.response ? result : { translate: false };
      const isResponsesStream =
        meta.translate === "responses" || provider.type === "chatgpt" || provider.type === "codex";
      if (res.ok && (isResponsesStream || stream)) {
        const inspected = await inspectEarlyResponsesSse(res);
        if (inspected.failure) {
          const classification = classifyFailure(inspected.failure.status, inspected.failure.error);
          return {
            ok: false,
            status: inspected.failure.status,
            error: inspected.failure.error,
            cooldownEligible: classification.eligible,
            failureKind: classification.kind,
            defaultCooldownMs: classification.defaultCooldownMs,
            resetAt: inspected.failure.resetAt,
          };
        }
        if (inspected.openAiJson) {
          if (stream) {
            bound.clearRequestTimeout();
            cleanupDeferred = true;
            return {
              ok: true,
              status: res.status,
              streamPipe: async (clientRes) => {
                try {
                  const completion = inspected.openAiJson;
                  const chunk = {
                    id: completion.id || `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: completion.created || Math.floor(Date.now() / 1000),
                    model: completion.model || upstreamModel,
                    choices: completion.choices.map((choice, index) => ({
                      index: choice.index ?? index,
                      delta: choice.message || {},
                      finish_reason: choice.finish_reason ?? "stop",
                    })),
                  };
                  clientRes.write(`data: ${JSON.stringify(chunk)}\n\n`);
                  clientRes.write("data: [DONE]\n\n");
                  return completion.usage || null;
                } finally {
                  bound.cleanup();
                }
              },
              providerId: provider.id,
              providerType: provider.type,
              providerName: provider.name,
              model: upstreamModel,
            };
          }
          return {
            ok: true,
            status: res.status,
            openAiJson: inspected.openAiJson,
            providerId: provider.id,
            providerType: provider.type,
            providerName: provider.name,
            model: upstreamModel,
          };
        }
        res = inspected.response;
      }
      const status = res.status;

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const error = errorMessageFromText(text, res.statusText);
        const classification = classifyFailure(status, error);
        return {
          ok: false,
          status,
          error,
          cooldownEligible: classification.eligible,
          failureKind: classification.kind,
          defaultCooldownMs: classification.defaultCooldownMs,
          resetAt: parseResetHint(res, text),
        };
      }

      if (stream) {
        if (!res.body) {
          return {
            ok: false,
            status: 502,
            error: "Upstream returned no response body",
            cooldownEligible: true,
            failureKind: "transient",
            defaultCooldownMs: COOLDOWN_MS.transient,
          };
        }
        // Response selection succeeded; keep client cancellation, not the header timeout.
        bound.clearRequestTimeout();
        cleanupDeferred = true;
        return {
          ok: true,
          status,
          streamPipe: async (clientRes) => {
            try {
              if (meta.translate === true || provider.type === "claude") {
                return await claude.pipeAnthropicSseToOpenAi(
                  res.body,
                  clientRes,
                  upstreamModel,
                  { preserveAnthropic: !!body[ANTHROPIC_METADATA] }
                );
              } else if (
                meta.translate === "responses" ||
                provider.type === "chatgpt" ||
                provider.type === "codex"
              ) {
                return await chatgpt.pipeResponsesSse(res.body, clientRes, upstreamModel, {
                  collect: false,
                  reasoningScope: meta.reasoningScope,
                });
              } else if (meta.translate === "gemini" || provider.type === "antigravity") {
                return await antigravity.pipeGeminiSse(res.body, clientRes, upstreamModel);
              } else {
                return await pipeOpenAiCompatibleSse(res.body, clientRes);
              }
            } catch (error) {
              if (!outerSignal?.aborted || bound.timedOut) {
                logger.error("router stream failure after output started", {
                  event: "stream_failure_no_fallback",
                  providerId: provider.id,
                  providerType: canonicalProviderType(provider.type),
                  providerName: provider.name,
                  accountAlias: provider.accountAlias || null,
                  upstreamModel,
                  error: error?.message || String(error),
                });
              }
              throw error;
            } finally {
              bound.cleanup();
            }
          },
          providerId: provider.id,
          providerType: provider.type,
          providerName: provider.name,
          model: upstreamModel,
        };
      }

      if (meta.translate === "responses" || provider.type === "chatgpt" || provider.type === "codex") {
        const collected = await chatgpt.pipeResponsesSse(res.body, null, upstreamModel, {
          collect: true,
          reasoningScope: meta.reasoningScope,
        });
        if (!isUsableChatCompletion(collected)) {
          return {
            ok: false,
            status: 502,
            error: "Upstream returned no usable completion",
            cooldownEligible: true,
            failureKind: "transient",
            defaultCooldownMs: COOLDOWN_MS.transient,
          };
        }
        return {
          ok: true,
          status: 200,
          openAiJson: collected,
          providerId: provider.id,
          providerType: provider.type,
          providerName: provider.name,
          model: upstreamModel,
        };
      }

      const raw = await res.json();
      if (raw?.error || raw?.response?.error) {
        const error = errorMessageFromText(JSON.stringify(raw), "Upstream returned an error payload");
        const reportedStatus = Number(raw?.error?.status ?? raw?.response?.error?.status);
        const errorStatus =
          Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599
            ? reportedStatus
            : 502;
        const classification = classifyFailure(errorStatus, error);
        return {
          ok: false,
          status: errorStatus,
          error,
          cooldownEligible: classification.eligible,
          failureKind: classification.kind,
          defaultCooldownMs: classification.defaultCooldownMs,
          resetAt: parseResetHint(res, JSON.stringify(raw)),
        };
      }
      let openAiJson = raw;
      if (meta.translate === true || provider.type === "claude") {
        openAiJson = claude.fromAnthropicJson(raw, upstreamModel);
      } else if (meta.translate === "gemini" || provider.type === "antigravity") {
        openAiJson = antigravity.fromGeminiJson(raw, upstreamModel);
      }
      if (!isUsableChatCompletion(openAiJson)) {
        return {
          ok: false,
          status: 502,
          error: "Upstream returned no usable completion",
          cooldownEligible: true,
          failureKind: "transient",
          defaultCooldownMs: COOLDOWN_MS.transient,
        };
      }
      return {
        ok: true,
        status: 200,
        openAiJson,
        providerId: provider.id,
        providerType: provider.type,
        providerName: provider.name,
        model: upstreamModel,
      };
    } catch (e) {
      if (outerSignal?.aborted && !bound.timedOut) {
        return {
          ok: false,
          status: 499,
          error: "Client disconnected",
          cooldownEligible: false,
          canceled: true,
          failureKind: "canceled",
          defaultCooldownMs: 0,
        };
      }
      if (isAbortError(e) || bound.timedOut) {
        return {
          ok: false,
          status: 408,
          error: e.message || "Upstream request timeout",
          cooldownEligible: true,
          failureKind: "transient",
          defaultCooldownMs: COOLDOWN_MS.transient,
        };
      }
      return {
        ok: false,
        status: 502,
        error: e.message || String(e),
        cooldownEligible: true,
        failureKind: "transient",
        defaultCooldownMs: COOLDOWN_MS.transient,
      };
    } finally {
      if (!cleanupDeferred) bound.cleanup();
    }
  }

  async function chatCompletions({ body, signal, onProviderSelected } = {}) {
    const cfg = getConfig();
    const modelId = body.model;
    const stream = !!body.stream;
    totalRequests += 1;

    const resolved = resolveTargets(cfg, modelId);
    if (!resolved || !resolved.members.length) {
      recordEvent({
        model: modelId,
        status: 404,
        error: `Model not found: ${modelId}`,
        stream,
      });
      return {
        ok: false,
        status: 404,
        error: {
          error: {
            message: `Model not found: ${modelId}`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
      };
    }

    const ordered = orderMembers(resolved, rrState);
    const errors = [];
    const attempted = new Set();
    let fallbackFrom = null;
    const attemptedOAuthPools = new Set();
    let sawNonOAuthAttempt = false;
    let lastAttemptedFailure = null;

    for (const member of ordered) {
      const accounts = member.accounts?.length ? member.accounts : [member.provider];
      for (let accountIndex = 0; accountIndex < accounts.length; accountIndex += 1) {
        const provider = accounts[accountIndex];
        const oauthAttempt = isOAuthProvider(provider);
        if (oauthAttempt) {
          attemptedOAuthPools.add(`${canonicalProviderType(provider.type)}:${member.upstreamModel}`);
        } else {
          sawNonOAuthAttempt = true;
        }
        const attemptKey = `${provider.id}:${member.upstreamModel}`;
        if (attempted.has(attemptKey)) continue;
        attempted.add(attemptKey);

        const lock = isOAuthProvider(provider)
          ? getActiveModelLock(provider, member.upstreamModel)
          : null;
        if (lock) {
          const skipped = {
            providerId: provider.id,
            providerType: canonicalProviderType(provider.type),
            providerName: provider.name,
            accountAlias: provider.accountAlias || null,
            model: member.upstreamModel,
            status: lock.status || 429,
            error: `Account locked until ${new Date(lock.until).toISOString()}: ${lock.reason || lock.kind}`,
            lockedUntil: lock.until,
            skipped: true,
          };
          errors.push(skipped);
          logger.info("router account skipped", { event: "account_locked_skip", routeModel: modelId, ...skipped });
          fallbackFrom = skipped;
          continue;
        }

        if (fallbackFrom) {
          const sameAccountPool =
            oauthAttempt &&
            fallbackFrom.providerType === canonicalProviderType(provider.type) &&
            fallbackFrom.model === member.upstreamModel;
          logger.info("router fallback selection", {
            event: sameAccountPool ? "account_fallback" : "route_fallback",
            routeModel: modelId,
            upstreamModel: member.upstreamModel,
            fromProviderId: fallbackFrom.providerId,
            fromAccountAlias: fallbackFrom.accountAlias || null,
            toProviderId: provider.id,
            toAccountAlias: provider.accountAlias || null,
          });
        } else {
          logger.info(oauthAttempt ? "router account selection" : "router route selection", {
            event: oauthAttempt ? "account_selection" : "route_selection",
            routeModel: modelId,
            upstreamModel: member.upstreamModel,
            providerId: provider.id,
            providerType: canonicalProviderType(provider.type),
            providerName: provider.name,
            accountAlias: provider.accountAlias || null,
          });
        }

        const attemptMember = { ...member, provider };
        if (typeof onProviderSelected === "function") {
          try {
            onProviderSelected({
              providerId: provider.id,
              providerType: canonicalProviderType(provider.type),
              providerName: provider.name,
              accountAlias: provider.accountAlias || null,
              upstreamModel: member.upstreamModel,
            });
          } catch {
            // UI telemetry must remain isolated from routing.
          }
        }
        let result;
        try {
          result = await tryMember(attemptMember, body, stream, signal);
        } catch (e) {
          const status = isAbortError(e) ? 408 : 500;
          const classification = classifyFailure(status, e.message);
          result = {
            ok: false,
            status,
            error: e.message || String(e),
            cooldownEligible: classification.eligible,
            failureKind: classification.kind,
            defaultCooldownMs: classification.defaultCooldownMs,
          };
        }

        if (result.ok) {
          clearModelLock(provider.id, member.upstreamModel);
          const tokens = result.openAiJson ? extractUsage(result.openAiJson) : {};
          const usageEvent = {
            model: modelId,
            status: 200,
            providerId: result.providerId,
            providerType: result.providerType || provider.type,
            providerName: result.providerName || provider.name,
            accountAlias: provider.accountAlias || null,
            upstream: result.model,
            stream,
          };
          if (stream && result.streamPipe) {
            const upstreamPipe = result.streamPipe;
            result.streamPipe = async (clientRes) => {
              try {
                const streamUsage = await upstreamPipe(clientRes);
                recordEvent({
                  ...usageEvent,
                  ...extractUsage(streamUsage ? { usage: streamUsage } : null),
                });
                return streamUsage;
              } catch (error) {
                recordEvent({
                  ...usageEvent,
                  status: signal?.aborted ? 499 : 502,
                  error: signal?.aborted
                    ? "Client disconnected"
                    : error?.message || String(error),
                });
                throw error;
              }
            };
          } else {
            recordEvent({ ...usageEvent, ...tokens });
          }
          return { ok: true, stream, accountAlias: provider.accountAlias || null, ...result };
        }

        if (result.canceled) {
          return {
            ok: false,
            status: 499,
            error: {
              error: {
                message: "Client disconnected",
                type: "request_error",
                code: "client_disconnected",
              },
            },
          };
        }

        const savedLock = persistModelLock(provider, member.upstreamModel, result);
        const failed = {
          providerId: provider.id,
          providerType: canonicalProviderType(provider.type),
          providerName: provider.name,
          accountAlias: provider.accountAlias || null,
          model: member.upstreamModel,
          status: result.status,
          error: result.error,
          failureKind: result.failureKind,
          retryable: true,
          lockedUntil: savedLock?.until || null,
        };
        errors.push(failed);
        lastAttemptedFailure = failed;
        logger.warn(oauthAttempt ? "router account failure" : "router route member failure", {
          event: oauthAttempt ? "account_failure" : "route_member_failure",
          routeModel: modelId,
          ...failed,
        });
        fallbackFrom = failed;
      }
    }

    const last = lastAttemptedFailure ||
      errors[errors.length - 1] || { status: 502, error: "All providers failed" };
    const attemptsSummary = errors
      .map((attempt) => {
        return `${attemptLabel(attempt)} [${attempt.status || 502}]: ${attempt.error}`;
      })
      .join("; ");
    const accountsExhausted = attemptedOAuthPools.size === 1 && !sawNonOAuthAttempt;
    const terminalMessage = accountsExhausted
      ? `All eligible accounts failed for ${modelId}. Attempts: ${attemptsSummary || "none"}`
      : `Route failed for ${modelId}. Attempts: ${attemptsSummary || "none"}`;
    logger.error(accountsExhausted ? "router accounts exhausted" : "router route failed", {
      event: accountsExhausted ? "accounts_exhausted" : "route_failure_no_fallback",
      routeModel: modelId,
      status: last.status || 502,
      attempts: errors,
    });
    recordEvent({
      model: modelId,
      status: last.status || 502,
      error: terminalMessage,
      stream,
      providerId: last.providerId,
      providerType: last.providerType || null,
      providerName: humanProviderName(last),
      accountAlias: last.accountAlias || null,
      attempts: errors,
    });
    return {
      ok: false,
      status: last.status && last.status >= 400 ? last.status : 502,
      error: {
        error: {
          message: terminalMessage,
          type: "api_error",
          code: "all_failed",
          details: errors,
        },
      },
    };
  }

  function stats() {
    const recent = usage ? usage.recent(50) : log.list();
    const allTime = usage ? usage.totalsAllTime().allTimeRequests : totalRequests;
    return {
      totalRequests: allTime || totalRequests,
      sessionRequests: totalRequests,
      recent,
    };
  }

  function usageAggregate(period) {
    if (!usage) return null;
    return usage.aggregate(period || "24h");
  }

  return {
    listModels,
    chatCompletions,
    resolveTargets,
    orderMembers,
    stats,
    usageAggregate,
    requestLog: log,
    get totalRequests() {
      return totalRequests;
    },
  };
}

module.exports = {
  createRouter,
  createRequestLog,
  resolveTargets,
  resolveSingle,
  accountCandidatesFor,
  compareAccounts,
  orderMembers,
  isRetryableStatus,
  classifyFailure,
  errorMessageFromText,
  attemptLabel,
  parseResetHint,
  hasProductiveResponsesEvent,
  isAbortError,
  memberSignal,
  modelIdFor,
};
