"use strict";

const { OAUTH } = require("../constants");
const { identityFromTokens } = require("../oauth-identity");
const { openaiChunk, formatSseData, SSE_DONE, createSseParser } = require("../sse");
const { applyResponsesEffort } = require("./effort");
const { textFromOpenAiContent, toResponsesContent } = require("./content");

const cfg = OAUTH.chatgpt;
const REASONING_CACHE_TTL_MS = 30 * 60 * 1000;
const REASONING_CACHE_MAX_ENTRIES = 256;
const REASONING_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const reasoningCache = new Map();
let reasoningCacheBytes = 0;

function reasoningCacheKey(scope, model, callId) {
  return `${String(scope || "unscoped")}\0${String(model || "")}\0${String(callId || "")}`;
}

function deleteReasoningCacheEntry(key) {
  const existing = reasoningCache.get(key);
  if (!existing) return;
  reasoningCacheBytes -= existing.size;
  reasoningCache.delete(key);
}

function pruneReasoningCache(now = Date.now()) {
  for (const [key, entry] of reasoningCache) {
    if (entry.expiresAt <= now) deleteReasoningCacheEntry(key);
  }
  while (
    reasoningCache.size > REASONING_CACHE_MAX_ENTRIES ||
    reasoningCacheBytes > REASONING_CACHE_MAX_BYTES
  ) {
    const oldest = reasoningCache.keys().next().value;
    if (oldest === undefined) break;
    deleteReasoningCacheEntry(oldest);
  }
}

function cloneReasoningItem(item) {
  if (item?.type !== "reasoning" || typeof item.encrypted_content !== "string") return null;
  // Keep only documented replay fields; unknown plaintext reasoning fields never cross the adapter.
  const copy = { type: "reasoning" };
  for (const key of ["id", "summary", "content", "encrypted_content", "status"]) {
    if (item[key] !== undefined) copy[key] = JSON.parse(JSON.stringify(item[key]));
  }
  return copy;
}

function cacheReasoningItems(scope, model, callId, items) {
  if (!callId) return;
  const copies = items.map(cloneReasoningItem).filter(Boolean);
  if (!copies.length) return;
  const size = Buffer.byteLength(JSON.stringify(copies), "utf8");
  if (size > REASONING_CACHE_MAX_BYTES) return;
  const key = reasoningCacheKey(scope, model, callId);
  deleteReasoningCacheEntry(key);
  reasoningCache.set(key, {
    items: copies,
    size,
    expiresAt: Date.now() + REASONING_CACHE_TTL_MS,
  });
  reasoningCacheBytes += size;
  pruneReasoningCache();
}

function cachedReasoningItems(scope, model, callId) {
  pruneReasoningCache();
  const key = reasoningCacheKey(scope, model, callId);
  const entry = reasoningCache.get(key);
  if (!entry) return [];
  reasoningCache.delete(key);
  reasoningCache.set(key, entry);
  return entry.items.map(cloneReasoningItem).filter(Boolean);
}

function cacheResponseReasoning(output, model, scope) {
  const snapshots = new Map();
  if (!Array.isArray(output)) return snapshots;
  const reasoning = [];
  for (const item of output) {
    const reasoningItem = cloneReasoningItem(item);
    if (reasoningItem) {
      reasoning.push(reasoningItem);
      continue;
    }
    if (item?.type === "function_call") {
      const callId = item.call_id || item.id;
      const snapshot = reasoning.map(cloneReasoningItem).filter(Boolean);
      if (callId && snapshot.length) {
        snapshots.set(callId, snapshot);
        cacheReasoningItems(scope, model, callId, snapshot);
      }
    }
  }
  return snapshots;
}

function reasoningItemsFromToolCall(call) {
  const items = call?.extra_content?.openai?.reasoning_items;
  return Array.isArray(items) ? items.map(cloneReasoningItem).filter(Boolean) : [];
}

function attachReasoningItems(call, items) {
  const snapshot = items.map(cloneReasoningItem).filter(Boolean);
  if (!snapshot.length) return call;
  call.extra_content = {
    ...(call.extra_content || {}),
    openai: {
      ...(call.extra_content?.openai || {}),
      reasoning_items: snapshot,
    },
  };
  return call;
}

function providerReasoningScope(provider) {
  return JSON.stringify({
    providerId: provider?.id || null,
    accountId: provider?.accountId || null,
    accountAlias: provider?.accountAlias || null,
  });
}

function toolArguments(value) {
  return typeof value === "string" ? value : JSON.stringify(value || {});
}

function toResponsesInput(messages, model, reasoningScope) {
  const input = [];
  const instructions = [];

  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system") {
      instructions.push(textFromOpenAiContent(message.content));
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: message.extra_content?.openai?.custom_tool_call_output ? "custom_tool_call_output" : "function_call_output",
        call_id: message.tool_call_id,
        output: textFromOpenAiContent(message.content),
      });
      continue;
    }

    const role =
      message.role === "assistant"
        ? "assistant"
        : message.role === "developer"
          ? "developer"
          : "user";
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const hasContent =
      message.content != null &&
      (typeof message.content !== "string" || message.content.length > 0) &&
      (!Array.isArray(message.content) || message.content.length > 0);

    if (hasContent || !calls.length) {
      input.push({
        type: "message",
        role,
        content: toResponsesContent(message.content, role),
      });
    }
    const emittedReasoning = new Set();
    for (const call of calls) {
      const custom = call?.type === "custom" && call.custom?.name;
      if (!custom && !call?.function?.name) continue;
      const echoedReasoning = reasoningItemsFromToolCall(call);
      const reasoningItems = echoedReasoning.length
        ? echoedReasoning
        : cachedReasoningItems(reasoningScope, model, call.id);
      for (const reasoning of reasoningItems) {
        const identity = reasoning.id || reasoning.encrypted_content;
        if (emittedReasoning.has(identity)) continue;
        emittedReasoning.add(identity);
        input.push(reasoning);
      }
      input.push(custom ? {
        type: "custom_tool_call",
        call_id: call.id,
        name: call.custom.name,
        input: typeof call.custom.input === "string" ? call.custom.input : String(call.custom.input ?? ""),
      } : {
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: toolArguments(call.function.arguments),
      });
    }
  }

  return { input, instructions };
}

function toResponsesTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
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
      ...(fn.description !== undefined ? { description: fn.description } : {}),
      parameters: fn.parameters || { type: "object", properties: {} },
      ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
    });
  }
  return converted.length ? converted : undefined;
}

function toResponsesToolChoice(choice) {
  if (!choice || typeof choice !== "object" || choice.type !== "function") return choice;
  const name = choice.name || choice.function?.name;
  return name ? { type: "function", name } : undefined;
}

/**
 * Convert OpenAI chat messages → Codex Responses API input.
 */
function toResponsesBody(body, model, stream, { reasoningScope } = {}) {
  const { input, instructions } = toResponsesInput(body.messages, model, reasoningScope);
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
  const tools = toResponsesTools(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = toResponsesToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (body.parallel_tool_calls !== undefined) {
    out.parallel_tool_calls = body.parallel_tool_calls;
  }
  const include = Array.isArray(body.include) ? [...body.include] : [];
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content");
  }
  out.include = include;
  return applyResponsesEffort(out, body);
}

function fromResponsesJson(data, model, { reasoningScope } = {}) {
  let text = "";
  const toolCalls = [];
  const output = data.output || data.choices || [];
  const reasoningByCall = cacheResponseReasoning(output, model, reasoningScope);
  const hasOutputText = typeof data.output_text === "string";
  if (hasOutputText) text = data.output_text;
  for (const item of output) {
    if (!hasOutputText && item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (c.type === "output_text" || c.type === "text") text += c.text || "";
      }
    } else if ((item.type === "function_call" || item.type === "custom_tool_call") && item.name) {
      const custom = item.type === "custom_tool_call";
      const call = {
        id: item.call_id || item.id,
        type: custom ? "custom" : "function",
        ...(custom
          ? { custom: { name: item.name, input: item.input || "" } }
          : { function: { name: item.name, arguments: item.arguments || "" } }),
      };
      attachReasoningItems(call, reasoningByCall.get(call.id) || []);
      toolCalls.push(call);
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
async function pipeResponsesSse(
  upstreamBody,
  res,
  model,
  { collect = false, reasoningScope } = {}
) {
  const parser = createSseParser();
  const id = `chatcmpl-${Date.now()}`;
  let roleSent = false;
  let collected = "";
  let collectedUsage;
  const toolCalls = [];
  const toolIndexes = new Map();
  const responseItems = new Map();
  const reasoningByCall = new Map();
  let responseItemSequence = 0;
  let reasoningExtensionSent = false;

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

  function recordResponseItem(data, item) {
    if (!item || typeof item !== "object") return;
    const outputIndex = Number.isFinite(data.output_index) ? data.output_index : null;
    const key =
      outputIndex !== null
        ? `output:${outputIndex}`
        : item.id || item.call_id || `sequence:${responseItemSequence}`;
    const existing = responseItems.get(key);
    responseItems.set(key, {
      order: outputIndex ?? existing?.order ?? responseItemSequence++,
      item: { ...(existing?.item || {}), ...item },
    });
  }

  function recordedResponseOutput() {
    return [...responseItems.values()]
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.item);
  }

  function updateReasoningSnapshots(output) {
    for (const [callId, items] of cacheResponseReasoning(output, model, reasoningScope)) {
      reasoningByCall.set(callId, items);
    }
    for (const call of toolCalls) {
      attachReasoningItems(call, reasoningByCall.get(call.id) || []);
    }
  }

  function emitReasoningExtensions() {
    if (collect || reasoningExtensionSent) return;
    const deltas = toolCalls.flatMap((call, index) =>
      call.extra_content
        ? [{ index, id: call.id, extra_content: call.extra_content }]
        : []
    );
    if (!deltas.length) return;
    ensureRole();
    writeChunk(openaiChunk({ id, model, tool_calls: deltas }));
    reasoningExtensionSent = true;
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
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        recordResponseItem(data, item);
      }
      if (
        (type === "response.output_item.added" || type === "response.output_item.done") &&
        (item?.type === "function_call" || item?.type === "custom_tool_call") &&
        item.name
      ) {
        const index = toolIndexFor(data, item);
        const current = toolCalls[index];
        const custom = item.type === "custom_tool_call";
        current.id ||= item.call_id || item.id;
        if (custom) {
          current.type = "custom";
          current.custom = { name: item.name, input: item.input || current.custom?.input || "" };
          delete current.function;
        } else {
          current.function.name ||= item.name;
          if (!current.function.arguments && item.arguments) current.function.arguments = item.arguments;
        }
        if (type === "response.output_item.added") {
          ensureRole();
          writeChunk(openaiChunk({
            id,
            model,
            tool_calls: [{
              index,
              id: current.id,
              type: custom ? "custom" : "function",
              ...(custom
                ? { custom: { name: current.custom.name, input: "" } }
                : { function: { name: current.function.name, arguments: "" } }),
            }],
          }));
        }
      } else if (type === "response.custom_tool_call_input.delta") {
        const index = toolIndexFor(data, item);
        const delta = typeof data.delta === "string" ? data.delta : "";
        const current = toolCalls[index];
        current.type = "custom";
        current.custom ||= { name: "", input: "" };
        current.custom.input += delta;
        delete current.function;
        if (delta) {
          ensureRole();
          writeChunk(openaiChunk({ id, model, tool_calls: [{ index, type: "custom", custom: { input: delta } }] }));
        }
      } else if (type === "response.custom_tool_call_input.done") {
        const index = toolIndexFor(data, item);
        const current = toolCalls[index];
        current.type = "custom";
        current.custom ||= { name: "", input: "" };
        if (!current.custom.input && typeof data.input === "string") current.custom.input = data.input;
        delete current.function;
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
      if (type === "response.output_text.delta") {
        if (typeof data.delta === "string") delta = data.delta;
        else if (data.delta?.text) delta = data.delta.text;
        else if (typeof data.text === "string") delta = data.text;
        else if (Array.isArray(data.delta?.content)) {
          for (const c of data.delta.content) {
            if (c.type === "output_text" || c.type === "text") delta += c.text || "";
          }
        }
      }

      if (delta) {
        collected += delta;
        ensureRole();
        writeChunk(openaiChunk({ id, model, content: delta }));
      }
      if (type === "response.completed" || type === "response.done") {
        updateReasoningSnapshots(data.response?.output || recordedResponseOutput());
        emitReasoningExtensions();
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

  updateReasoningSnapshots(recordedResponseOutput());
  emitReasoningExtensions();

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
  const reasoningScope = providerReasoningScope(provider);
  const payload = toResponsesBody(body, mid, stream, { reasoningScope });
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
  return {
    response: res,
    model: mid,
    translate: "responses",
    clientStream: !!stream,
    reasoningScope,
  };
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
