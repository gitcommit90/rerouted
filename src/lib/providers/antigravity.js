"use strict";

const crypto = require("node:crypto");
const { OAUTH } = require("../constants");
const { openaiChunk, formatSseData, SSE_DONE, createSseParser } = require("../sse");
const { applyGeminiEffort } = require("./effort");
const { textFromOpenAiContent, toGeminiParts } = require("./content");

const cfg = OAUTH.antigravity;
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function safeParseJson(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toGeminiTools(body) {
  const tools = Array.isArray(body.tools)
    ? body.tools
    : Array.isArray(body.functions)
      ? body.functions.map((fn) => ({ type: "function", function: fn }))
      : [];
  const declarations = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || (tool.type && tool.type !== "function")) continue;
    const fn = tool.function || tool;
    if (!fn.name) continue;
    declarations.push({
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      parametersJsonSchema: fn.parameters || { type: "object", properties: {} },
    });
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

function toGeminiToolConfig(body) {
  const choice = body.tool_choice ?? body.function_call;
  if (choice == null) return undefined;
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (choice === "auto") return { functionCallingConfig: { mode: "AUTO" } };
  if (choice && typeof choice === "object") {
    const name = choice.function?.name || choice.name;
    if (name) {
      return {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] },
      };
    }
  }
  return undefined;
}

function thoughtSignatureFromToolCall(call) {
  return (
    call?.extra_content?.google?.thought_signature || call?.thought_signature || call?.thoughtSignature
  );
}

function nativeFunctionCallId(call) {
  return call?.extra_content?.google?.function_call_id || call?.id;
}

function functionResponseBody(content) {
  const text = textFromOpenAiContent(content);
  const parsed = safeParseJson(text, text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : { output: parsed };
}

function pushContent(contents, role, parts) {
  if (!parts.length) return;
  const prior = contents.at(-1);
  if (prior?.role === role) prior.parts.push(...parts);
  else contents.push({ role, parts });
}

function toGeminiBody(body, model) {
  const systemParts = [];
  const contents = [];
  const toolNamesById = new Map();
  for (const m of body.messages || []) {
    if (m.role === "system") {
      systemParts.push(textFromOpenAiContent(m.content));
      continue;
    }
    if (m.role === "tool") {
      const priorCall = toolNamesById.get(m.tool_call_id);
      const name = m.name || priorCall?.name;
      if (!name) continue;
      pushContent(contents, "user", [
        {
          functionResponse: {
            ...(priorCall?.nativeId ? { id: priorCall.nativeId } : {}),
            name,
            response: functionResponseBody(m.content),
          },
        },
      ]);
      continue;
    }

    const role = m.role === "assistant" ? "model" : "user";
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    const parts = m.content == null && calls.length ? [] : toGeminiParts(m.content);
    const validCalls = calls.filter((call) => call?.function?.name);
    const signatures = validCalls.map(thoughtSignatureFromToolCall);
    const hasSignedCall = signatures.some(Boolean);
    for (const [callIndex, call] of validCalls.entries()) {
      const fn = call.function;
      const nativeId = nativeFunctionCallId(call);
      if (call.id) toolNamesById.set(call.id, { name: fn.name, nativeId });
      const part = {
        functionCall: {
          ...(nativeId ? { id: nativeId } : {}),
          name: fn.name,
          args: safeParseJson(fn.arguments, {}),
        },
      };
      const signature =
        signatures[callIndex] ||
        (!hasSignedCall && callIndex === 0 ? SKIP_THOUGHT_SIGNATURE : undefined);
      if (signature) part.thoughtSignature = signature;
      parts.push(part);
    }
    const prior = contents.at(-1);
    if (prior?.role === role && !parts.some((part) => part.functionCall)) {
      if (prior.parts.at(-1)?.text != null && parts[0]?.text != null) {
        prior.parts[prior.parts.length - 1].text += `\n${parts.shift().text}`;
      }
      prior.parts.push(...parts);
    } else if (parts.length) {
      contents.push({ role, parts });
    }
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "Hello" }] });
  const request = {
    contents,
    generationConfig: {
      temperature: body.temperature ?? 1,
      maxOutputTokens: body.max_tokens || body.max_completion_tokens || 8192,
    },
  };
  if (systemParts.length) {
    request.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }
  const tools = toGeminiTools(body);
  if (tools) request.tools = tools;
  const toolConfig = toGeminiToolConfig(body);
  if (toolConfig) request.toolConfig = toolConfig;
  applyGeminiEffort(request.generationConfig, body);
  return {
    project: cfg.projectId || undefined,
    model,
    userAgent: "antigravity",
    request,
  };
}

function extractTextFromGemini(data) {
  const cands = data.candidates || data.response?.candidates || [];
  let text = "";
  for (const c of cands) {
    for (const p of c.content?.parts || []) {
      if (p.text && !p.thought) text += p.text;
    }
  }
  // Antigravity wraps response
  if (!text && data.response) return extractTextFromGemini(data.response);
  return text;
}

function toolCallFromGeminiPart(part) {
  const call = part?.functionCall;
  if (!call?.name) return null;
  const signature =
    part.thoughtSignature ||
    part.thought_signature ||
    part.metadata?.google?.thoughtSignature ||
    part.metadata?.google?.thought_signature;
  const google = {
    ...(signature ? { thought_signature: signature } : {}),
    ...(call.id ? { function_call_id: call.id } : {}),
  };
  return {
    id: call.id || `call_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.args || {}),
    },
    ...(Object.keys(google).length ? { extra_content: { google } } : {}),
  };
}

function mapFinishReason(reason, hasToolCalls) {
  if (hasToolCalls) return "tool_calls";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT") return "content_filter";
  return "stop";
}

function fromGeminiJson(data, model) {
  const candidates = data.candidates || data.response?.candidates || [];
  const usage = data.usageMetadata || data.response?.usageMetadata;
  return {
    id: data.responseId || data.response?.responseId || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: candidates.map((candidate, index) => {
      const parts = candidate.content?.parts || [];
      const text = parts
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text)
        .join("");
      const toolCalls = parts.map(toolCallFromGeminiPart).filter(Boolean);
      const message = {
        role: "assistant",
        content: text || (toolCalls.length ? null : ""),
      };
      if (toolCalls.length) message.tool_calls = toolCalls;
      return {
        index: candidate.index ?? index,
        message,
        finish_reason: mapFinishReason(candidate.finishReason, toolCalls.length > 0),
      };
    }),
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens:
              usage.totalTokenCount ||
              (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
            prompt_tokens_details: {
              cached_tokens: usage.cachedContentTokenCount || 0,
            },
          },
        }
      : {}),
  };
}

async function pipeGeminiSse(upstreamBody, res, model) {
  const parser = createSseParser();
  const id = `chatcmpl-${Date.now()}`;
  let roleSent = false;
  let streamUsage = null;
  let sawToolCall = false;
  let finishReason = null;
  let emittedText = "";
  const pendingCalls = new Map();
  const anonymousSlots = new Map();
  let nextCallOrder = 0;
  let nextAnonymousId = 0;

  function compatibleCallValue(prior, current) {
    if (prior == null || current == null) return true;
    if (typeof prior === "string" && typeof current === "string") {
      return prior.startsWith(current) || current.startsWith(prior);
    }
    if (typeof prior !== "object" || typeof current !== "object") return prior === current;
    if (Array.isArray(prior) || Array.isArray(current)) {
      return JSON.stringify(prior) === JSON.stringify(current);
    }
    const sharedKeys = Object.keys(prior).filter((key) => key in current);
    if (!sharedKeys.length) return !Object.keys(prior).length || !Object.keys(current).length;
    return sharedKeys.every((key) => compatibleCallValue(prior[key], current[key]));
  }

  function compatibleFunctionCall(prior, current) {
    return (
      prior?.functionCall?.name === current?.functionCall?.name &&
      compatibleCallValue(prior.functionCall.args, current.functionCall.args)
    );
  }

  function mergeFunctionCallPart(prior, current) {
    return {
      ...prior,
      ...current,
      functionCall: { ...prior?.functionCall, ...current.functionCall },
      thoughtSignature:
        current.thoughtSignature || current.thought_signature || prior?.thoughtSignature,
    };
  }

  function recordFunctionCall(candidateId, functionIndex, part, claimedKeys) {
    let slots = anonymousSlots.get(candidateId);
    if (!slots) {
      slots = [];
      anonymousSlots.set(candidateId, slots);
    }

    const nativeId = part.functionCall.id;
    let key = nativeId ? `${candidateId}:id:${nativeId}` : null;
    if (key && !pendingCalls.has(key)) {
      const anonymousMatch = slots.find(
        (slot) =>
          !claimedKeys.has(slot.key) &&
          compatibleFunctionCall(pendingCalls.get(slot.key)?.part, part)
      );
      if (anonymousMatch) {
        const priorEntry = pendingCalls.get(anonymousMatch.key);
        pendingCalls.delete(anonymousMatch.key);
        anonymousMatch.key = key;
        pendingCalls.set(key, priorEntry);
      }
    }

    if (!key) {
      const ordinalSlot = slots[functionIndex];
      const matchingSlot =
        ordinalSlot &&
        !claimedKeys.has(ordinalSlot.key) &&
        compatibleFunctionCall(pendingCalls.get(ordinalSlot.key)?.part, part)
          ? ordinalSlot
          : slots.find(
              (slot) =>
                !claimedKeys.has(slot.key) &&
                compatibleFunctionCall(pendingCalls.get(slot.key)?.part, part)
            );
      if (matchingSlot) {
        key = matchingSlot.key;
      } else {
        key = `${candidateId}:anonymous:${nextAnonymousId++}`;
        slots.push({ key });
      }
    }

    const priorEntry = pendingCalls.get(key);
    pendingCalls.set(key, {
      order: priorEntry?.order ?? nextCallOrder++,
      part: mergeFunctionCallPart(priorEntry?.part, part),
    });
    claimedKeys.add(key);
  }

  async function handleEvents(events) {
    for (const ev of events) {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (data.error || data.response?.error) {
        const upstream = data.error || data.response.error;
        throw new Error(
          upstream.message || upstream.code || upstream.status || "Antigravity stream failed"
        );
      }
      const usage = data.usageMetadata || data.response?.usageMetadata;
      if (usage) {
        streamUsage = {
          prompt_tokens: usage.promptTokenCount || 0,
          completion_tokens: usage.candidatesTokenCount || 0,
          total_tokens:
            usage.totalTokenCount ||
            (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0),
          prompt_tokens_details: {
            cached_tokens: usage.cachedContentTokenCount || 0,
          },
        };
      }
      const candidates = data.candidates || data.response?.candidates || [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        if (candidate.finishReason) finishReason = candidate.finishReason;
        const candidateId = candidate.index ?? candidateIndex;
        const claimedKeys = new Set();
        let functionIndex = 0;
        for (const part of candidate.content?.parts || []) {
          if (!part.functionCall?.name) continue;
          recordFunctionCall(candidateId, functionIndex++, part, claimedKeys);
        }
      }
      const text = extractTextFromGemini(data);
      const delta = text.startsWith(emittedText) ? text.slice(emittedText.length) : text;
      if (delta) {
        if (!roleSent) {
          res.write(formatSseData(openaiChunk({ id, model, role: "assistant", content: "" })));
          roleSent = true;
        }
        res.write(formatSseData(openaiChunk({ id, model, content: delta })));
        emittedText += delta;
      }
    }
  }

  if (upstreamBody[Symbol.asyncIterator]) {
    for await (const chunk of upstreamBody) await handleEvents(parser.push(chunk));
  } else if (typeof upstreamBody.on === "function") {
    await new Promise((resolve, reject) => {
      upstreamBody.on("data", (c) => handleEvents(parser.push(c)).catch(reject));
      upstreamBody.on("end", resolve);
      upstreamBody.on("error", reject);
    });
  } else if (upstreamBody.getReader) {
    const reader = upstreamBody.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await handleEvents(parser.push(value));
    }
  }
  let nextToolIndex = 0;
  const orderedCalls = [...pendingCalls.values()].sort((left, right) => left.order - right.order);
  for (const { part } of orderedCalls) {
    const toolCall = toolCallFromGeminiPart(part);
    if (!toolCall) continue;
    if (!roleSent) {
      res.write(formatSseData(openaiChunk({ id, model, role: "assistant" })));
      roleSent = true;
    }
    res.write(
      formatSseData(
        openaiChunk({
          id,
          model,
          tool_calls: [{ index: nextToolIndex++, ...toolCall }],
        })
      )
    );
    sawToolCall = true;
  }
  res.write(
    formatSseData(
      openaiChunk({
        id,
        model,
        finishReason: mapFinishReason(finishReason, sawToolCall),
      })
    )
  );
  res.write(SSE_DONE);
  return streamUsage;
}

async function refreshToken(provider, { fetchImpl = fetch } = {}) {
  if (!provider.refreshToken) throw new Error("No Antigravity refresh token");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: provider.refreshToken,
    client_id: provider.clientId || cfg.clientId,
    client_secret: provider.clientSecret || cfg.clientSecret,
  });
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`Antigravity refresh failed: ${res.status} ${t.slice(0, 200)}`);
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

async function chat(provider, { model, body, stream, signal, fetchImpl = fetch, onTokenRefresh } = {}) {
  const mid = model || body.model || cfg.models[0].id;
  const payload = toGeminiBody(body, mid);
  if (provider.projectId) payload.project = provider.projectId;
  const base = cfg.baseUrls[0];
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${base}/v1internal:${action}`;

  async function once(accessToken) {
    return fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "antigravity/1.107.0 darwin/arm64",
        Accept: stream ? "text/event-stream" : "application/json",
      },
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
  return { response: res, model: mid, translate: "gemini" };
}

function listModels(provider) {
  return (provider.models || cfg.models).map((m) => ({ ...m }));
}

module.exports = {
  chat,
  listModels,
  refreshToken,
  toGeminiBody,
  fromGeminiJson,
  pipeGeminiSse,
  cfg,
};
