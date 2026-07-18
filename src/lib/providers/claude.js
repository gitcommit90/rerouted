"use strict";

const crypto = require("node:crypto");
const { OAUTH } = require("../constants");
const { openaiChunk, formatSseData, SSE_DONE, createSseParser } = require("../sse");
const { applyClaudeEffort } = require("./effort");

const cfg = OAUTH.claude;
const ANTHROPIC_METADATA = Symbol.for("rerouted.anthropic.metadata");

/** Provider-compatible request metadata and system-block shaping. */
const CLAUDE_CLI_VERSION = "2.1.92";
const CC_ENTRYPOINT = "cli";

const ANTHROPIC_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14," +
  "context-management-2025-06-27,prompt-caching-scope-2026-01-05," +
  "advanced-tool-use-2025-11-20,effort-2025-11-24,structured-outputs-2025-12-15," +
  "fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28";

/** Minimal provider-compatible system prompt. */
const CLAUDE_CODE_AGENT = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_STATIC = [
  "You are an interactive agent that helps users with software engineering tasks.",
  "Use the tools and instructions available to assist the user.",
  "Go straight to the point. Be extra concise. Prefer short, direct sentences.",
  "Do not create files unless absolutely necessary. Prefer editing existing files.",
].join("\n");

/** Stable session id per access token with a one-hour cache lifetime. */
const sessionCache = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;

function stableSessionId(accessToken) {
  const key = String(accessToken || "");
  if (!key) return crypto.randomUUID();
  const now = Date.now();
  const hit = sessionCache.get(key);
  if (hit && hit.expire > now) return hit.id;
  // Prefer deterministic UUID-shaped id from token so restarts still stable
  const id = deriveUuid(`session:${key}`);
  sessionCache.set(key, { id, expire: now + SESSION_TTL_MS });
  if (sessionCache.size > 200) {
    for (const [k, v] of sessionCache) {
      if (v.expire <= now) sessionCache.delete(k);
    }
  }
  return id;
}

function mapStainlessOs() {
  switch (process.platform) {
    case "darwin":
      return "MacOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return `Other::${process.platform}`;
  }
}

function mapStainlessArch() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "ia32":
      return "x86";
    default:
      return `other::${process.arch}`;
  }
}

function deriveUuid(seed) {
  const h = crypto.createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Stable metadata.user_id JSON shape for each credential. */
function generateFakeUserId(sessionId, accessToken) {
  const deviceId = accessToken
    ? crypto.createHash("sha256").update(`device:${accessToken}`).digest("hex")
    : crypto.randomBytes(32).toString("hex");
  const accountUuid = accessToken
    ? deriveUuid(`account:${accessToken}`)
    : crypto.randomUUID();
  const sessionUuid = sessionId || crypto.randomUUID();
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUuid,
    session_id: sessionUuid,
  });
}

/**
 * Generate the x-anthropic-billing-header text block.
 * Format: cc_version=<ver>.<build>; cc_entrypoint=<ep>; cch=<hash>;
 */
function generateBillingHeader(payload) {
  const content = JSON.stringify(payload);
  const cch = crypto.createHash("sha256").update(content).digest("hex").slice(0, 5);
  // Derive a deterministic short build fingerprint from the payload.
  const buildHash = crypto.createHash("sha256").update(content + CLAUDE_CLI_VERSION).digest("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${buildHash}; cc_entrypoint=${CC_ENTRYPOINT}; cch=${cch};`;
}

/**
 * Strip third-party agent structure that can trigger extra-usage or proxy
 * detection on OAuth traffic.
 */
function sanitizeForwardedSystemPrompt(text) {
  if (!String(text || "").trim()) return "";
  // Keep a short neutral reminder; full client system prompts look like non-CLI agents.
  return [
    "Use the available tools when needed to help with software engineering tasks.",
    "Keep responses concise and focused on the user's request.",
    "Prefer acting on the user's task over describing product-specific workflows.",
    // Preserve a short slice of original context if useful
    String(text).trim().slice(0, 400),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Wrap forwarded system context in provider-compatible reminder blocks. */
function wrapSystemReminder(text) {
  return (
    `<system-reminder>\n` +
    `As you answer the user's questions, you can use the following context from the system:\n` +
    `${text}\n\n` +
    `IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n` +
    `</system-reminder>\n`
  );
}

function prependToFirstUserMessage(messages, text) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.map((m) => ({
    ...m,
    content: Array.isArray(m.content) ? m.content.map((b) => ({ ...b })) : m.content,
  }));
  const idx = out.findIndex((m) => m.role === "user");
  if (idx < 0) return out;
  const m = out[idx];
  if (typeof m.content === "string") {
    out[idx] = { ...m, content: text + m.content };
  } else if (Array.isArray(m.content)) {
    out[idx] = {
      ...m,
      content: [{ type: "text", text }, ...m.content],
    };
  } else {
    out[idx] = { ...m, content: [{ type: "text", text: text + String(m.content ?? "") }] };
  }
  return out;
}

/**
 * Shape Claude OAuth requests to match the upstream client contract:
 * - system[0] billing header
 * - system[1] upstream client identity
 * - system[2] short CC static prompt
 * - original client system moved into first user message as <system-reminder>
 * - metadata.user_id JSON aligned with X-Claude-Code-Session-Id
 *
 * Without this Anthropic often returns 429 rate_limit_error { message: "Error" }
 * for non-haiku models on sk-ant-oat tokens.
 */
function applyCloaking(body, accessToken, sessionId) {
  if (!accessToken || !String(accessToken).includes("sk-ant-oat")) return body;
  const result = { ...body, messages: Array.isArray(body.messages) ? body.messages.map((m) => ({ ...m })) : body.messages };

  // Already cloaked?
  if (Array.isArray(result.system) && result.system[0]?.text?.startsWith("x-anthropic-billing-header:")) {
    return result;
  }

  // Capture original client system for move to user message
  let userSystemText = "";
  if (Array.isArray(result.system)) {
    userSystemText = result.system
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .filter(Boolean)
      .join("\n\n");
  } else if (typeof result.system === "string") {
    userSystemText = result.system;
  }

  const billingBlock = { type: "text", text: generateBillingHeader(body) };
  const agentBlock = { type: "text", text: CLAUDE_CODE_AGENT };
  const staticBlock = { type: "text", text: CLAUDE_CODE_STATIC };
  result.system = [billingBlock, agentBlock, staticBlock];

  if (userSystemText.trim()) {
    const sanitized = sanitizeForwardedSystemPrompt(userSystemText);
    if (sanitized) {
      result.messages = prependToFirstUserMessage(
        result.messages || [],
        wrapSystemReminder(sanitized)
      );
    }
  }

  if (!result.metadata?.user_id) {
    result.metadata = {
      ...result.metadata,
      user_id: generateFakeUserId(sessionId, accessToken),
    };
  }
  return result;
}

function anthropicHeaders(accessToken, sessionId) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "Anthropic-Version": "2023-06-01",
    "Anthropic-Beta": ANTHROPIC_BETA,
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
    // Identify the request as external CLI traffic.
    "User-Agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
    "X-App": "cli",
    "X-Stainless-Helper-Method": "stream",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime-Version": "v24.14.0",
    "X-Stainless-Package-Version": "0.80.0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Lang": "js",
    "X-Stainless-Arch": mapStainlessArch(),
    "X-Stainless-Os": mapStainlessOs(),
    "X-Stainless-Timeout": "600",
    "X-Claude-Code-Session-Id": sessionId || crypto.randomUUID(),
  };
}

function safeParseJson(value, fallback = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return typeof fallback === "string" ? value : fallback;
  }
}

function convertOpenAIToolChoice(choice) {
  if (!choice) return { type: "auto" };
  if (typeof choice === "string") {
    if (choice === "required") return { type: "any" };
    if (choice === "none") return { type: "none" };
    return { type: "auto" };
  }
  if (typeof choice === "object") {
    if (choice.function?.name) return { type: "tool", name: choice.function.name };
    if (choice.type === "function" && choice.function?.name) {
      return { type: "tool", name: choice.function.name };
    }
    if (["auto", "any", "tool", "none"].includes(choice.type)) return choice;
  }
  return { type: "auto" };
}

function convertOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const out = [];
  for (const tool of tools) {
    // Pass through Anthropic built-ins (web_search_*, etc.)
    if (tool?.type && tool.type !== "function") {
      out.push(tool);
      continue;
    }
    const fn = tool?.type === "function" && tool.function ? tool.function : tool;
    if (!fn?.name) continue;
    out.push({
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || fn.input_schema || { type: "object", properties: {} },
    });
  }
  return out.length ? out : undefined;
}

/**
 * Convert a single OpenAI message into Claude content blocks.
 * tool_result blocks must be role=user; tool_use only on assistant.
 */
function contentBlocksFromMessage(msg) {
  const blocks = [];
  if (msg.role === "tool") {
    const nativeResult = msg[ANTHROPIC_METADATA]?.tool_result || msg.extra_content?.anthropic?.tool_result;
    if (nativeResult?.type === "tool_result") {
      return [JSON.parse(JSON.stringify(nativeResult))];
    }
    let content = msg.content;
    if (content != null && typeof content !== "string") {
      content = JSON.stringify(content);
    }
    blocks.push({
      type: "tool_result",
      tool_use_id: msg.tool_call_id || msg.id || "",
      content: content ?? "",
    });
    return blocks;
  }

  if (msg.role === "assistant") {
    const nativeContent = msg[ANTHROPIC_METADATA]?.content || msg.extra_content?.anthropic?.content;
    if (Array.isArray(nativeContent)) {
      return JSON.parse(JSON.stringify(nativeContent));
    }
    if (typeof msg.content === "string" && msg.content) {
      blocks.push({ type: "text", text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === "text" && part.text) {
          blocks.push({
            type: "text",
            text: part.text,
            ...(part.cache_control ? { cache_control: part.cache_control } : {}),
          });
        }
        if (part?.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input || {},
          });
        }
      }
    }
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc.function || {};
        blocks.push({
          type: "tool_use",
          id: tc.id || `toolu_${crypto.randomBytes(8).toString("hex")}`,
          name: fn.name || tc.name,
          input: safeParseJson(fn.arguments, {}),
        });
      }
    }
    return blocks;
  }

  // user (and anything else treated as user)
  const nativeContent = msg[ANTHROPIC_METADATA]?.content || msg.extra_content?.anthropic?.content;
  if (Array.isArray(nativeContent)) {
    return JSON.parse(JSON.stringify(nativeContent));
  }
  if (typeof msg.content === "string") {
    if (msg.content) blocks.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === "text" && part.text) {
        blocks.push({
          type: "text",
          text: part.text,
          ...(part.cache_control ? { cache_control: part.cache_control } : {}),
        });
      }
      else if (part?.type === "tool_result") {
        blocks.push({
          type: "tool_result",
          tool_use_id: part.tool_use_id,
          content: part.content,
          ...(part.is_error ? { is_error: true } : {}),
        });
      } else if (part?.type === "image_url" && part.image_url?.url) {
        const url = part.image_url.url;
        const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
        if (m) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: m[1], data: m[2] },
            ...(part.cache_control ? { cache_control: part.cache_control } : {}),
          });
        } else if (/^https?:\/\//i.test(url)) {
          blocks.push({
            type: "image",
            source: { type: "url", url },
            ...(part.cache_control ? { cache_control: part.cache_control } : {}),
          });
        }
      }
    }
  } else if (msg.content != null) {
    blocks.push({ type: "text", text: String(msg.content) });
  }
  return blocks;
}

/**
 * Convert OpenAI chat messages → Anthropic messages + system + tools.
 * Critical: tool_result must be in a user message; tool_use only on assistant.
 * Do not blindly merge consecutive same-role messages when tools are involved.
 */
function toAnthropicBody(body, model, stream) {
  const systemParts = [];
  const messages = [];

  const pushMessage = (role, blocks) => {
    if (!blocks.length) return;
    // Merge consecutive same-role messages only when no tool blocks (simple text chats)
    const hasTool =
      blocks.some((b) => b.type === "tool_use" || b.type === "tool_result");
    const last = messages[messages.length - 1];
    if (
      last &&
      last.role === role &&
      !hasTool &&
      Array.isArray(last.content) &&
      !last.content.some((b) => b.type === "tool_use" || b.type === "tool_result")
    ) {
      last.content.push(...blocks);
      return;
    }
    messages.push({ role, content: blocks });
  };

  for (const m of body.messages || []) {
    if (m.role === "system") {
      const nativeSystem = m[ANTHROPIC_METADATA]?.content;
      if (Array.isArray(nativeSystem)) {
        systemParts.push(...JSON.parse(JSON.stringify(nativeSystem)));
        continue;
      }
      if (typeof nativeSystem === "string") {
        systemParts.push({ type: "text", text: nativeSystem });
        continue;
      }
      if (typeof m.content === "string") {
        systemParts.push({ type: "text", text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part?.type === "text" && part.text != null) {
            systemParts.push({
              type: "text",
              text: String(part.text),
              ...(part.cache_control ? { cache_control: part.cache_control } : {}),
            });
          }
        }
      } else if (m.content != null) {
        systemParts.push({ type: "text", text: String(m.content) });
      }
      continue;
    }
    const blocks = contentBlocksFromMessage(m);
    if (m.role === "tool") {
      // tool_result always as user; flush as its own message
      pushMessage("user", blocks);
      continue;
    }
    if (m.role === "assistant") {
      pushMessage("assistant", blocks);
      continue;
    }
    pushMessage("user", blocks);
  }

  if (!messages.length) messages.push({ role: "user", content: [{ type: "text", text: "Hello" }] });
  // Anthropic requires starting with user
  if (messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  }

  // Normalize string content messages for simple path compatibility with cloaking
  // (Anthropic accepts string or block array; we keep block arrays when tools present)
  const out = {
    model,
    messages,
    max_tokens: body.max_tokens || body.max_completion_tokens || 4096,
    stream: !!stream,
  };
  if (systemParts.length) {
    out.system = systemParts.some((part) => part.cache_control)
      ? systemParts
      : systemParts.map((part) => part.text).join("\n\n");
  }
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.top_k != null) out.top_k = body.top_k;
  if (body.stop != null) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  for (const key of ["metadata", "service_tier", "context_management", "mcp_servers"]) {
    if (body[key] !== undefined) out[key] = JSON.parse(JSON.stringify(body[key]));
  }

  const tools = convertOpenAITools(body.tools);
  const nativeTools = body[ANTHROPIC_METADATA]?.tools;
  if (Array.isArray(nativeTools) && nativeTools.length) {
    out.tools = JSON.parse(JSON.stringify(nativeTools));
  } else if (tools) {
    out.tools = tools;
  }
  // Functions API compatibility
  if (!tools && Array.isArray(body.functions) && body.functions.length) {
    out.tools = body.functions.map((fn) => ({
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    }));
  }
  if (body.tool_choice != null) {
    out.tool_choice = convertOpenAIToolChoice(body.tool_choice);
  } else if (body.function_call != null) {
    if (body.function_call === "auto") out.tool_choice = { type: "auto" };
    else if (body.function_call === "none") out.tool_choice = { type: "none" };
    else if (typeof body.function_call === "object" && body.function_call.name) {
      out.tool_choice = { type: "tool", name: body.function_call.name };
    }
  }
  if (body.parallel_tool_calls === false && out.tool_choice?.type !== "none") {
    out.tool_choice = {
      ...(out.tool_choice || { type: "auto" }),
      disable_parallel_tool_use: true,
    };
  }
  for (const [key, value] of Object.entries(body[ANTHROPIC_METADATA]?.options || {})) {
    out[key] = JSON.parse(JSON.stringify(value));
  }
  return applyClaudeEffort(out, body, model);
}

function mapStopReason(stopReason) {
  if (stopReason === "end_turn") return "stop";
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "stop_sequence") return "stop";
  return stopReason || "stop";
}

function fromAnthropicJson(data, model) {
  const blocks = data.content || [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: {
        name: b.name,
        arguments: JSON.stringify(b.input != null ? b.input : {}),
      },
    }));

  const message = {
    role: "assistant",
    content: text || (toolCalls.length ? null : ""),
  };
  message[ANTHROPIC_METADATA] = {
    content: JSON.parse(JSON.stringify(blocks)),
    stop_reason: data.stop_reason || null,
    stop_sequence: data.stop_sequence ?? null,
  };
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
        finish_reason: mapStopReason(data.stop_reason),
      },
    ],
    usage: data.usage
      ? {
          prompt_tokens: data.usage.input_tokens || 0,
          completion_tokens: data.usage.output_tokens || 0,
          total_tokens:
            (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
          ...(data.usage.cache_read_input_tokens != null
            ? { cache_read_input_tokens: data.usage.cache_read_input_tokens }
            : {}),
          ...(data.usage.cache_creation_input_tokens != null
            ? { cache_creation_input_tokens: data.usage.cache_creation_input_tokens }
            : {}),
        }
      : undefined,
  };
}

/**
 * Translate Anthropic SSE → OpenAI SSE chunks written to res (incl. tool_calls).
 */
async function pipeAnthropicSseToOpenAi(
  upstreamBody,
  res,
  model,
  { preserveAnthropic = false } = {}
) {
  const parser = createSseParser();
  const id = `chatcmpl-${Date.now()}`;
  let roleSent = false;
  /** @type {Map<number, { index: number, id: string, name: string }>} */
  const toolByBlockIndex = new Map();
  const opaqueBlockIndexes = new Set();
  let nextToolIndex = 0;
  let streamUsage = null;

  function captureUsage(usage) {
    if (!usage || typeof usage !== "object") return;
    const current = streamUsage || {
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      total_tokens: 0,
    };
    if (usage.input_tokens != null) current.prompt_tokens = Number(usage.input_tokens) || 0;
    if (usage.output_tokens != null) {
      current.completion_tokens = Number(usage.output_tokens) || 0;
    }
    if (usage.cache_read_input_tokens != null) {
      current.cached_tokens = Number(usage.cache_read_input_tokens) || 0;
    }
    current.total_tokens = current.prompt_tokens + current.completion_tokens;
    streamUsage = current;
  }

  async function handleEvents(events) {
    for (const ev of events) {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (data.type === "error" || data.error) {
        const upstream = data.error && typeof data.error === "object" ? data.error : data;
        throw new Error(
          upstream.message || upstream.code || upstream.type || "Claude stream failed"
        );
      }
      captureUsage(data.message?.usage || data.usage);
      if (data.type === "message_start" && !roleSent) {
        res.write(formatSseData(openaiChunk({ id, model, role: "assistant" })));
        roleSent = true;
      }
      if (data.type === "content_block_start") {
        const block = data.content_block;
        if (
          preserveAnthropic &&
          (block?.type === "thinking" || block?.type === "redacted_thinking")
        ) {
          opaqueBlockIndexes.add(data.index);
          res.write(formatSseData(openaiChunk({
            id,
            model,
            extra_content: { anthropic: { event: data } },
          })));
          continue;
        }
        if (block?.type === "tool_use") {
          if (!roleSent) {
            res.write(formatSseData(openaiChunk({ id, model, role: "assistant" })));
            roleSent = true;
          }
          const toolIndex = nextToolIndex++;
          toolByBlockIndex.set(data.index, {
            index: toolIndex,
            id: block.id,
            name: block.name,
          });
          res.write(
            formatSseData(
              openaiChunk({
                id,
                model,
                tool_calls: [
                  {
                    index: toolIndex,
                    id: block.id,
                    type: "function",
                    function: { name: block.name, arguments: "" },
                  },
                ],
              })
            )
          );
        }
      }
      if (data.type === "content_block_delta") {
        const delta = data.delta;
        if (preserveAnthropic && opaqueBlockIndexes.has(data.index)) {
          res.write(formatSseData(openaiChunk({
            id,
            model,
            extra_content: { anthropic: { event: data } },
          })));
          continue;
        }
        if (delta?.type === "text_delta" && delta.text) {
          if (!roleSent) {
            res.write(formatSseData(openaiChunk({ id, model, role: "assistant", content: "" })));
            roleSent = true;
          }
          res.write(formatSseData(openaiChunk({ id, model, content: delta.text })));
        } else if (delta?.type === "input_json_delta" && delta.partial_json != null) {
          const tc = toolByBlockIndex.get(data.index);
          if (tc) {
            res.write(
              formatSseData(
                openaiChunk({
                  id,
                  model,
                  tool_calls: [
                    {
                      index: tc.index,
                      id: tc.id,
                      type: "function",
                      function: { arguments: delta.partial_json },
                    },
                  ],
                })
              )
            );
          }
        }
      }
      if (
        preserveAnthropic &&
        data.type === "content_block_stop" &&
        opaqueBlockIndexes.has(data.index)
      ) {
        res.write(formatSseData(openaiChunk({
          id,
          model,
          extra_content: { anthropic: { event: data } },
        })));
        opaqueBlockIndexes.delete(data.index);
      }
      if (data.type === "message_delta" && data.delta?.stop_reason) {
        const fr = mapStopReason(data.delta.stop_reason);
        res.write(formatSseData(openaiChunk({
          id,
          model,
          finishReason: fr,
          ...(preserveAnthropic
            ? {
                extra_content: {
                  anthropic: { stop_sequence: data.delta.stop_sequence ?? null },
                },
              }
            : {}),
        })));
      }
    }
  }

  if (upstreamBody[Symbol.asyncIterator]) {
    for await (const chunk of upstreamBody) {
      await handleEvents(parser.push(chunk));
    }
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
  res.write(SSE_DONE);
  return streamUsage;
}
async function refreshToken(provider, { fetchImpl = fetch } = {}) {
  if (!provider.refreshToken) throw new Error("No Claude refresh token");
  const urls = [cfg.tokenUrl, ...(cfg.tokenUrlFallbacks || [])].filter(Boolean);
  let lastErr = "";
  // Token calls use JSON headers without the Claude CLI user-agent fingerprint.
  const tokenHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (cfg.userAgent) tokenHeaders["User-Agent"] = cfg.userAgent;
  for (const tokenUrl of urls) {
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: tokenHeaders,
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: provider.refreshToken,
        client_id: cfg.clientId,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || provider.refreshToken,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
    }
    lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 200);
  }
  const err = new Error(`Claude refresh failed: ${lastErr}`);
  err.status = 401;
  throw err;
}

async function chat(provider, { model, body, stream, signal, fetchImpl = fetch, onTokenRefresh } = {}) {
  const mid = model || body.model || cfg.models[0].id;
  // Keep a stable session id for each access token.
  const sessionId = stableSessionId(provider.accessToken);
  let payload = toAnthropicBody(body, mid, stream);
  payload = applyCloaking(payload, provider.accessToken, sessionId);
  const url = `${cfg.chatUrl}?beta=true`;

  async function once(accessToken) {
    const sid = stableSessionId(accessToken);
    // Re-cloak if token rotated so billing/user_id stay consistent
    const bodyToSend =
      accessToken === provider.accessToken
        ? payload
        : applyCloaking(toAnthropicBody(body, mid, stream), accessToken, sid);
    return fetchImpl(url, {
      method: "POST",
      headers: anthropicHeaders(accessToken, sid),
      body: JSON.stringify(bodyToSend),
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
  return { response: res, model: mid, translate: true };
}

function listModels(provider) {
  return (provider.models || cfg.models).map((m) => ({ ...m }));
}

module.exports = {
  chat,
  listModels,
  refreshToken,
  toAnthropicBody,
  fromAnthropicJson,
  pipeAnthropicSseToOpenAi,
  applyCloaking,
  generateBillingHeader,
  generateFakeUserId,
  anthropicHeaders,
  stableSessionId,
  cfg,
};
