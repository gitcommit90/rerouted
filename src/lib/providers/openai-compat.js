"use strict";

const { applyOpenAIEffort } = require("./effort");

const MODELS_TIMEOUT_MS = 15_000;

/**
 * Thin OpenAI-compatible keyed provider adapter.
 * baseUrl should end without trailing slash; we call /chat/completions and /models.
 */

function joinUrl(base, suffix) {
  const b = String(base || "").replace(/\/+$/, "");
  const s = String(suffix || "").replace(/^\/+/, "");
  return `${b}/${s}`;
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
    ...(body.generationConfig ? { generationConfig: { ...body.generationConfig } } : {}),
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
  applyOpenAIEffort(payload, body, { omit: /grok-composer/i.test(String(model || body.model)) });
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
  return res;
}

module.exports = { listModels, chat, joinUrl };
