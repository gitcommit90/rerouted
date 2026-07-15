"use strict";

const { applyGlmEffort, applyOpenAIEffort } = require("./effort");

const MODELS_TIMEOUT_MS = 15_000;
const MAX_ENVELOPE_DEPTH = 8;

/**
 * Thin OpenAI-compatible keyed provider adapter.
 * baseUrl should end without trailing slash; we call /chat/completions and /models.
 */

function joinUrl(base, suffix) {
  const b = String(base || "").replace(/\/+$/, "");
  const s = String(suffix || "").replace(/^\/+/, "");
  return `${b}/${s}`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function isChatCompletion(value) {
  return isRecord(value) && Array.isArray(value.choices);
}

function unwrapSuccessfulDataEnvelope(payload) {
  if (isChatCompletion(payload)) return payload;
  if (!isRecord(payload) || payload.success !== true || !("data" in payload)) {
    return payload;
  }

  let current = payload.data;
  for (let depth = 0; depth < MAX_ENVELOPE_DEPTH; depth += 1) {
    current = parseJsonRecord(current);
    if (isChatCompletion(current)) return current;
    if (
      !isRecord(current) ||
      current.success === false ||
      !("data" in current)
    ) {
      break;
    }
    current = current.data;
  }
  return payload;
}

function hasCompleteToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return false;
  return toolCalls.every((call) => {
    const fn = call?.function;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) return false;
    if (typeof fn.arguments !== "string") return false;
    try {
      JSON.parse(fn.arguments);
      return true;
    } catch {
      return false;
    }
  });
}

function normalizeToolFinishReasons(payload) {
  if (!isChatCompletion(payload)) return false;
  let changed = false;
  for (const choice of payload.choices) {
    const toolCalls = choice?.message?.tool_calls;
    if (
      hasCompleteToolCalls(toolCalls) &&
      (choice.finish_reason == null || choice.finish_reason === "stop")
    ) {
      choice.finish_reason = "tool_calls";
      changed = true;
    }
  }
  return changed;
}

function responseHeaders(response) {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return headers;
}

function failureEnvelopeStatus(payload) {
  const candidates = [
    payload?.status,
    payload?.statusCode,
    payload?.error?.status,
    payload?.error?.statusCode,
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return 502;
}

async function normalizeChatResponse(response, stream) {
  if (stream || !response?.ok || typeof response.clone !== "function")
    return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (isRecord(payload) && payload.success === false) {
    return new Response(JSON.stringify(payload), {
      status: failureEnvelopeStatus(payload),
      headers: responseHeaders(response),
    });
  }

  const normalized = unwrapSuccessfulDataEnvelope(payload);
  const finishReasonChanged = normalizeToolFinishReasons(normalized);
  const changed = normalized !== payload || finishReasonChanged;
  if (!changed) return response;

  return new Response(JSON.stringify(normalized), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  });
}

async function listModels(provider, { fetchImpl = fetch, timeoutMs = MODELS_TIMEOUT_MS } = {}) {
  const url = joinUrl(provider.baseUrl, "models");
  const controller = new AbortController();
  let timer;
  const timeoutError = new Error(`models fetch timed out after ${timeoutMs}ms`);
  timeoutError.name = "TimeoutError";
  timeoutError.code = "ETIMEDOUT";
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeoutMs);
  });
  const request = (async () => {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`models fetch failed: ${res.status} ${text}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
    return list.map((m) => ({
      id: m.id || m.name,
      name: m.name || m.id,
    }));
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute chat completion. Returns { status, headers, body, stream } where body is
 * either a parsed JSON object (non-stream) or a ReadableStream/Node stream (stream).
 */
async function chat(provider, { model, body, stream, signal, fetchImpl = fetch } = {}) {
  const url = joinUrl(provider.baseUrl, "chat/completions");
  const payload = {
    ...body,
    ...(body.generationConfig
      ? { generationConfig: { ...body.generationConfig } }
      : {}),
    ...(body.request
      ? {
          request: {
            ...body.request,
            ...(body.request.generationConfig
              ? { generationConfig: { ...body.request.generationConfig } }
              : {}),
          },
        }
      : {}),
    model: model || body.model,
    stream: !!stream,
  };
  if (provider.type === "glm") {
    applyGlmEffort(payload, body);
  } else {
    applyOpenAIEffort(payload, body, { omit: /grok-composer/i.test(String(model || body.model)) });
  }
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  return normalizeChatResponse(res, stream);
}

module.exports = { listModels, chat, joinUrl };
