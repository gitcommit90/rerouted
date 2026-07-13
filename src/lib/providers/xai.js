"use strict";

const crypto = require("node:crypto");
const { OAUTH } = require("../constants");
const { extractEffort } = require("./effort");
const responses = require("./chatgpt");

const cfg = OAUTH.xai;
const CLIENT_VERSION = "0.2.99";
const VIRTUAL_MODEL = /^grok-4\.5-(high|medium|low)$/;

function resolveModel(model) {
  const requested = String(model || cfg.models[0].id);
  const match = requested.match(VIRTUAL_MODEL);
  return {
    requested,
    upstream: match ? "grok-4.5" : requested,
    modelEffort: match ? match[1] : null,
  };
}

function normalizeEffort(level, fallback = "high") {
  if (level === "low" || level === "medium" || level === "high") return level;
  if (level === "minimal" || level === "none") return "low";
  if (level === "xhigh" || level === "max") return "high";
  return fallback;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((part) => typeof part === "string" || part?.type === "text")
    .map((part) => (typeof part === "string" ? part : part.text || ""))
    .join("\n");
}

function toResponsesInput(messages) {
  const input = [];
  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: textContent(message.content),
      });
      continue;
    }

    const content = textContent(message.content);
    if (content || !Array.isArray(message.tool_calls) || !message.tool_calls.length) {
      input.push({
        type: "message",
        role: message.role || "user",
        content,
      });
    }
    for (const call of message.tool_calls || []) {
      if (!call?.function?.name) continue;
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments:
          typeof call.function.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function.arguments || {}),
      });
    }
  }
  if (!input.length) input.push({ type: "message", role: "user", content: "Hello" });
  return input;
}

function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools.slice(0, 200)) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type !== "function") {
      converted.push({ ...tool });
      continue;
    }
    const fn = tool.function || tool;
    if (!fn.name) continue;
    converted.push({
      type: "function",
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      parameters: fn.parameters || { type: "object", properties: {} },
    });
  }
  return converted.length ? converted : undefined;
}

function toResponsesToolChoice(choice) {
  if (!choice || typeof choice !== "object" || choice.type !== "function") return choice;
  const name = choice.name || choice.function?.name;
  return name ? { type: "function", name } : undefined;
}

function toResponsesBody(body = {}, model) {
  const resolved = resolveModel(model || body.model);
  const payload = {
    model: resolved.upstream,
    input: Array.isArray(body.input)
      ? body.input.map((item) =>
          item && typeof item === "object" && !Array.isArray(item) ? { ...item } : item
        )
      : toResponsesInput(body.messages),
    stream: true,
    store: false,
  };

  const tools = toResponsesTools(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = toResponsesToolChoice(body.tool_choice);
  if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  if (body.parallel_tool_calls !== undefined) {
    payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.text !== undefined) payload.text = body.text;
  if (body.metadata !== undefined) payload.metadata = body.metadata;
  if (body.prompt_cache_key !== undefined) payload.prompt_cache_key = body.prompt_cache_key;

  const maxOutputTokens = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  if (maxOutputTokens !== undefined) payload.max_output_tokens = maxOutputTokens;

  if (!/grok-composer/i.test(resolved.upstream)) {
    const explicit = extractEffort(body);
    const modelEffort = resolved.modelEffort || "high";
    const effort = normalizeEffort(explicit?.level, modelEffort);
    payload.reasoning = {
      effort,
      summary: body.reasoning?.summary || "concise",
    };
    const include = Array.isArray(body.include) ? [...body.include] : [];
    if (!include.includes("reasoning.encrypted_content")) {
      include.push("reasoning.encrypted_content");
    }
    payload.include = include;
  } else if (Array.isArray(body.include)) {
    const include = body.include.filter((item) => item !== "reasoning.encrypted_content");
    if (include.length) payload.include = include;
  }

  return payload;
}

function requestHeaders(accessToken, model, body) {
  const sessionId = crypto.randomUUID();
  const userTurns = (body.messages || []).filter((message) => message?.role === "user").length;
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": `grok-shell/${CLIENT_VERSION} (darwin; arm64)`,
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-identifier": "grok-shell",
    "x-grok-client-version": CLIENT_VERSION,
    "x-authenticateresponse": "authenticate-response",
    "x-grok-session-id": sessionId,
    "x-grok-conv-id": sessionId,
    "x-grok-req-id": crypto.randomUUID(),
    "x-grok-turn-idx": String(Math.max(1, userTurns)),
    "x-grok-model-override": model,
  };
}

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

async function chat(
  provider,
  { model, body = {}, stream, signal, fetchImpl = fetch, onTokenRefresh } = {}
) {
  const requestedModel = model || body.model || cfg.models[0].id;
  const payload = toResponsesBody(body, requestedModel);

  async function once(accessToken) {
    return fetchImpl(cfg.chatUrl, {
      method: "POST",
      headers: requestHeaders(accessToken, payload.model, body),
      body: JSON.stringify(payload),
      signal,
    });
  }

  let res = await once(provider.accessToken || provider.apiKey);
  if (res.status === 401 && provider.refreshToken) {
    const tokens = await refreshToken(provider, { fetchImpl });
    if (onTokenRefresh) await onTokenRefresh(tokens);
    Object.assign(provider, tokens);
    res = await once(provider.accessToken);
  }
  return {
    response: res,
    model: requestedModel,
    translate: "responses",
    clientStream: !!stream,
  };
}

function listModels(provider) {
  return (provider.models || cfg.models).map((m) => ({ ...m }));
}

module.exports = {
  chat,
  listModels,
  refreshToken,
  resolveModel,
  normalizeEffort,
  toResponsesBody,
  fromResponsesJson: responses.fromResponsesJson,
  pipeResponsesSse: responses.pipeResponsesSse,
  cfg,
};
