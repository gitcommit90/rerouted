"use strict";

const { OAUTH } = require("../constants");
const { openaiChunk, formatSseData, SSE_DONE, createSseParser } = require("../sse");
const { applyResponsesEffort } = require("./effort");

const cfg = OAUTH.chatgpt;

/**
 * Convert OpenAI chat messages → Codex Responses API input.
 */
function toResponsesBody(body, model, stream) {
  const instructions = [];
  const input = [];
  for (const m of body.messages || []) {
    if (m.role === "system") {
      instructions.push(typeof m.content === "string" ? m.content : String(m.content ?? ""));
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : m.role === "developer" ? "developer" : "user";
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p) => p.type === "text" || typeof p === "string")
              .map((p) => (typeof p === "string" ? p : p.text))
              .join("\n")
          : String(m.content ?? "");
    input.push({
      type: "message",
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
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
  const output = data.output || data.choices || [];
  if (typeof data.output_text === "string") text = data.output_text;
  else {
    for (const item of output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" || c.type === "text") text += c.text || "";
        }
      }
    }
  }
  return {
    id: data.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
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

  function writeChunk(obj) {
    if (!collect && res) res.write(formatSseData(obj));
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
      if (type === "error" || data.error) {
        const upstream = data.error && typeof data.error === "object" ? data.error : data;
        throw new Error(
          upstream.message || upstream.code || upstream.type || "Codex stream failed"
        );
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
      } else if (typeof data.delta === "string") delta = data.delta;

      if (delta) {
        collected += delta;
        if (!roleSent) {
          writeChunk(openaiChunk({ id, model, role: "assistant", content: "" }));
          roleSent = true;
        }
        writeChunk(openaiChunk({ id, model, content: delta }));
      }
      if (type === "response.completed" || type === "response.done") {
        writeChunk(openaiChunk({ id, model, finishReason: "stop" }));
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
    return {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: collected }, finish_reason: "stop" },
      ],
    };
  }
  if (res) res.write(SSE_DONE);
  return null;
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
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || provider.refreshToken,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    accountId: provider.accountId,
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
  cfg,
};
