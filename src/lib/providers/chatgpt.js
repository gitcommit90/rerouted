"use strict";

const { OAUTH } = require("../constants");
const { identityFromTokens } = require("../oauth-identity");
const { openaiChunk, formatSseData, SSE_DONE, createSseParser } = require("../sse");
const { applyResponsesEffort } = require("./effort");
const { textFromOpenAiContent, toResponsesContent } = require("./content");

const cfg = OAUTH.chatgpt;

/**
 * Convert OpenAI chat messages → Codex Responses API input.
 */
function toResponsesBody(body, model, stream) {
  const instructions = [];
  const input = [];
  for (const m of body.messages || []) {
    if (m.role === "system") {
      instructions.push(textFromOpenAiContent(m.content));
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : m.role === "developer" ? "developer" : "user";
    input.push({
      type: "message",
      role,
      content: toResponsesContent(m.content, role),
    });
  }
  if (!input.length) {
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Hello" }],
    });
  }
  const out = {
    model,
    input,
    stream: true, // Codex force-stream
    store: false,
  };
  if (instructions.length) out.instructions = instructions.join("\n\n");
  return applyResponsesEffort(out, body);
}

function fromResponsesJson(data, model) {
  let text = "";
  const toolCalls = [];
  const output = data.output || data.choices || [];
  if (typeof data.output_text === "string") text = data.output_text;
  else {
    for (const item of output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" || c.type === "text") text += c.text || "";
        }
      } else if (item.type === "function_call" && item.name) {
        toolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments || "" },
        });
      }
    }
  }
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    ...(data.usage ? { usage: normalizeResponsesUsage(data.usage) } : {}),
  };
}

function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const promptTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
    ...(usage.input_tokens_details?.cached_tokens != null
      ? {
          prompt_tokens_details: {
            cached_tokens: usage.input_tokens_details.cached_tokens,
          },
        }
      : {}),
  };
}

/**
 * Translate Codex Responses SSE → OpenAI chat.completion.chunk SSE.
 * If client asked for non-stream, collect text and return JSON via collect mode.
 */
async function pipeResponsesSse(upstreamBody, res, model, { collect = false } = {}) {
  const parser = createSseParser();
  const id = `chatcmpl-${Date.now()}`;
  let roleSent = false;
  let collected = "";
  let collectedUsage;
  const toolCalls = [];
  const toolIndexes = new Map();

  function writeChunk(obj) {
    if (!collect && res) res.write(formatSseData(obj));
  }

  function ensureRole() {
    if (roleSent) return;
    writeChunk(openaiChunk({ id, model, role: "assistant", content: "" }));
    roleSent = true;
  }

  function toolIndexFor(data, item) {
    const keys = [
      item?.call_id,
      item?.id,
      data.item_id,
      `output:${data.output_index ?? 0}`,
    ].filter(Boolean);
    let index = keys.map((key) => toolIndexes.get(key)).find((value) => value !== undefined);
    if (index === undefined) {
      index = toolCalls.length;
      toolCalls.push({
        id: item?.call_id || item?.id || data.item_id,
        type: "function",
        function: { name: item?.name || "", arguments: "" },
      });
    }
    for (const key of keys) toolIndexes.set(key, index);
    return index;
  }

  async function handleEvents(events) {
    for (const ev of events) {
      if (ev.data === "[DONE]") continue;
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = data.type || ev.event;
      if (type === "error" || type === "response.failed" || data.error || data.response?.error) {
        const upstream =
          data.error && typeof data.error === "object"
            ? data.error
            : data.response?.error && typeof data.response.error === "object"
              ? data.response.error
              : data.error || data.response?.error || data;
        throw new Error(
          typeof upstream === "string"
            ? upstream
            : upstream.message || upstream.code || upstream.type || "Upstream Responses stream failed"
        );
      }

      const item = data.item || data.output_item;
      if (
        (type === "response.output_item.added" || type === "response.output_item.done") &&
        item?.type === "function_call" &&
        item.name
      ) {
        const index = toolIndexFor(data, item);
        const current = toolCalls[index];
        current.id ||= item.call_id || item.id;
        current.function.name ||= item.name;
        if (!current.function.arguments && item.arguments) {
          current.function.arguments = item.arguments;
        }
        if (type === "response.output_item.added") {
          ensureRole();
          writeChunk(
            openaiChunk({
              id,
              model,
              tool_calls: [
                {
                  index,
                  id: current.id,
                  type: "function",
                  function: { name: current.function.name, arguments: "" },
                },
              ],
            })
          );
        }
      } else if (type === "response.function_call_arguments.delta") {
        const index = toolIndexFor(data, item);
        const delta = typeof data.delta === "string" ? data.delta : "";
        toolCalls[index].function.arguments += delta;
        if (delta) {
          ensureRole();
          writeChunk(
            openaiChunk({
              id,
              model,
              tool_calls: [{ index, function: { arguments: delta } }],
            })
          );
        }
      } else if (type === "response.function_call_arguments.done") {
        const index = toolIndexFor(data, item);
        if (!toolCalls[index].function.arguments && typeof data.arguments === "string") {
          toolCalls[index].function.arguments = data.arguments;
        }
      }

      let delta = "";
      if (type === "response.output_text.delta" && typeof data.delta === "string") delta = data.delta;
      else if (type === "response.output_text.delta" && data.delta?.text) delta = data.delta.text;
      else if (type === "response.output_text.delta" && typeof data.text === "string")
        delta = data.text;
      else if (data.delta?.content) {
        for (const c of data.delta.content) {
          if (c.type === "output_text" || c.type === "text") delta += c.text || "";
        }
      } else if (
        type !== "response.function_call_arguments.delta" &&
        typeof data.delta === "string"
      ) {
        delta = data.delta;
      }

      if (delta) {
        collected += delta;
        ensureRole();
        writeChunk(openaiChunk({ id, model, content: delta }));
      }
      if (type === "response.completed" || type === "response.done") {
        collectedUsage = normalizeResponsesUsage(data.response?.usage || data.usage);
        const finalChunk = openaiChunk({
          id,
          model,
          finishReason: toolCalls.length ? "tool_calls" : "stop",
        });
        if (collectedUsage) finalChunk.usage = collectedUsage;
        writeChunk(finalChunk);
      }
    }
  }

  if (upstreamBody && upstreamBody[Symbol.asyncIterator]) {
    for await (const chunk of upstreamBody) {
      await handleEvents(parser.push(chunk));
    }
  } else if (upstreamBody && typeof upstreamBody.on === "function") {
    await new Promise((resolve, reject) => {
      upstreamBody.on("data", (c) => handleEvents(parser.push(c)).catch(reject));
      upstreamBody.on("end", resolve);
      upstreamBody.on("error", reject);
    });
  } else if (upstreamBody && upstreamBody.getReader) {
    const reader = upstreamBody.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handleEvents(parser.push(value));
    }
  }

  if (collect) {
    const message = { role: "assistant", content: collected || null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
        },
      ],
      ...(collectedUsage ? { usage: collectedUsage } : {}),
    };
  }
  if (res) res.write(SSE_DONE);
  return collectedUsage || null;
}

async function refreshToken(provider, { fetchImpl = fetch } = {}) {
  if (!provider.refreshToken) throw new Error("No ChatGPT refresh token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: provider.refreshToken,
    client_id: cfg.clientId,
    scope: cfg.scope,
  });
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`ChatGPT refresh failed: ${res.status} ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const identity = identityFromTokens("chatgpt", data);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || provider.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    ...identity,
    accountId: identity.accountId || provider.accountId,
  };
}

async function chat(provider, { model, body, stream, signal, fetchImpl = fetch, onTokenRefresh } = {}) {
  const mid = model || body.model || cfg.models[0].id;
  const payload = toResponsesBody(body, mid, stream);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.accessToken}`,
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.136.0",
    Accept: "text/event-stream",
  };
  if (provider.accountId) headers["chatgpt-account-id"] = provider.accountId;

  async function once(accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    return fetchImpl(cfg.chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
  }

  let res = await once(provider.accessToken);
  if (res.status === 401 && provider.refreshToken) {
    const tokens = await refreshToken(provider, { fetchImpl });
    if (onTokenRefresh) await onTokenRefresh(tokens);
    Object.assign(provider, tokens);
    res = await once(provider.accessToken);
  }
  return { response: res, model: mid, translate: "responses", clientStream: !!stream };
}

function listModels(provider) {
  return (provider.models || cfg.models).map((m) => ({ ...m }));
}

module.exports = {
  chat,
  listModels,
  refreshToken,
  toResponsesBody,
  fromResponsesJson,
  pipeResponsesSse,
  normalizeResponsesUsage,
  cfg,
};
