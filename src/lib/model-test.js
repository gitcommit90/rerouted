"use strict";

const { redactString } = require("./logger");

const MAX_ERROR_BODY_LENGTH = 4096;
const DEFAULT_MODEL_TEST_TIMEOUT_MS = 60_000;

function safeErrorBody(value, maxLength = MAX_ERROR_BODY_LENGTH) {
  const body = redactString(value);
  if (body.length <= maxLength) return body;
  return `${body.slice(0, maxLength)}... [truncated ${body.length - maxLength} chars]`;
}

function hasErrorValue(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value === true;
}

function payloadHasUpstreamError(payload) {
  if (!payload || typeof payload !== "object") return false;
  const type = String(payload.type || "").toLowerCase();
  if (type === "error" || type === "response.failed") return true;
  if (hasErrorValue(payload.error)) return true;
  if (hasErrorValue(payload.response?.error)) return true;
  return false;
}

function bodyHasUpstreamError(body) {
  const text = String(body || "");
  if (!text.trim()) return false;

  try {
    if (payloadHasUpstreamError(JSON.parse(text))) return true;
  } catch {
    /* SSE and plain text are checked below. */
  }

  for (const block of text.split(/\r?\n\r?\n/)) {
    let eventName = "";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim().toLowerCase();
      if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (eventName === "error") return true;
    const dataText = data.join("\n");
    if (!dataText || dataText === "[DONE]") continue;
    try {
      if (payloadHasUpstreamError(JSON.parse(dataText))) return true;
    } catch {
      /* Non-JSON SSE data is not an upstream error without an error event. */
    }
  }
  return false;
}

async function inspectModelTestResponse(response) {
  if (!response) {
    return { ok: false, status: null, body: "no response" };
  }

  let body;
  try {
    body = await response.text();
  } catch (error) {
    body = safeErrorBody(error?.message || String(error));
    return { ok: false, status: response.status || null, body };
  }

  body = String(body || "");
  if (!response.ok) {
    return {
      ok: false,
      status: response.status || null,
      body: safeErrorBody(body || response.statusText || ""),
    };
  }
  if (bodyHasUpstreamError(body)) {
    return { ok: false, status: response.status || 200, body: safeErrorBody(body) };
  }
  return { ok: true, status: response.status || 200, body };
}

function logFailure(logger, label, status, body) {
  logger?.error?.(`Model test failed for ${label}`, { status, body: safeErrorBody(body) });
}

async function runProviderModelTest({ adapter, provider, model, onTokenRefresh, logger, timeoutMs = DEFAULT_MODEL_TEST_TIMEOUT_MS } = {}) {
  const label = `${provider?.name || provider?.type || "provider"}/${model}`;
  const controller = new AbortController();
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_MODEL_TEST_TIMEOUT_MS);
  const timeoutError = new Error(`model test timed out after ${boundedTimeoutMs}ms`);
  timeoutError.name = "TimeoutError";
  timeoutError.code = "ETIMEDOUT";
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, boundedTimeoutMs);
  });
  try {
    const request = adapter.chat(
      { ...provider },
      {
        model,
        body: {
          model,
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 8,
          stream: false,
        },
        stream: false,
        signal: controller.signal,
        onTokenRefresh,
      }
    );
    const result = await Promise.race([request, timeout]);
    const response = result && result.response ? result.response : result;
    const inspection = await inspectModelTestResponse(response);
    if (!inspection.ok) {
      logFailure(logger, label, inspection.status, inspection.body);
      return {
        ok: false,
        error: `Model test failed (${inspection.status || "?"}): ${inspection.body}`,
      };
    }
    return { ok: true };
  } catch (error) {
    const message = safeErrorBody(error?.message || String(error));
    logFailure(logger, label, error?.status || null, message);
    return { ok: false, error: `Model test failed: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_MODEL_TEST_TIMEOUT_MS,
  MAX_ERROR_BODY_LENGTH,
  bodyHasUpstreamError,
  inspectModelTestResponse,
  payloadHasUpstreamError,
  runProviderModelTest,
  safeErrorBody,
};
