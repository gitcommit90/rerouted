"use strict";

const { OAUTH } = require("../constants");
const { openaiChunk, formatSseData, SSE_DONE, createSseParser } = require("../sse");
const { applyGeminiEffort } = require("./effort");
const { textFromOpenAiContent, toGeminiParts } = require("./content");

const cfg = OAUTH.antigravity;

function toGeminiBody(body, model) {
  const systemParts = [];
  const contents = [];
  for (const m of body.messages || []) {
    if (m.role === "system") {
      systemParts.push(textFromOpenAiContent(m.content));
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    const parts = toGeminiParts(m.content);
    if (contents.length && contents[contents.length - 1].role === role) {
      const prior = contents[contents.length - 1].parts;
      if (prior.at(-1)?.text != null && parts[0]?.text != null) {
        prior[prior.length - 1].text += `\n${parts.shift().text}`;
      }
      prior.push(...parts);
    } else {
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
      if (p.text) text += p.text;
    }
  }
  // Antigravity wraps response
  if (!text && data.response) return extractTextFromGemini(data.response);
  return text;
}

function fromGeminiJson(data, model) {
  const text = extractTextFromGemini(data);
  const usage = data.usageMetadata || data.response?.usageMetadata;
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
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
      const text = extractTextFromGemini(data);
      // For incremental SSE, parts may only contain the delta in some APIs;
      // Antigravity often re-sends full — we treat each event's text as delta if short path.
      const delta = text; // best-effort; may accumulate for some backends
      if (delta) {
        if (!roleSent) {
          res.write(formatSseData(openaiChunk({ id, model, role: "assistant", content: "" })));
          roleSent = true;
        }
        res.write(formatSseData(openaiChunk({ id, model, content: delta })));
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
  res.write(formatSseData(openaiChunk({ id, model, finishReason: "stop" })));
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
