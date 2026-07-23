"use strict";

const crypto = require("node:crypto");
const { createSseParser } = require("./sse");
const ANTHROPIC_METADATA = Symbol.for("rerouted.anthropic.metadata");

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function invalid(message, param) {
  const error = new Error(message);
  error.status = 400;
  error.error = {
    type: "invalid_request_error",
    message,
    ...(param ? { param } : {}),
  };
  return error;
}

function validateAnthropicRequest(body) {
  if (!isObject(body)) throw invalid("Request body must be a JSON object");
  if (typeof body.model !== "string" || !body.model.trim()) {
    throw invalid("model is required", "model");
  }
  if (!Array.isArray(body.messages)) throw invalid("messages must be an array", "messages");
  if (body.stream != null && typeof body.stream !== "boolean") {
    throw invalid("stream must be a boolean", "stream");
  }
  if (body.max_tokens != null && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) {
    throw invalid("max_tokens must be a positive integer", "max_tokens");
  }
  if (body.tools != null && !Array.isArray(body.tools)) {
    throw invalid("tools must be an array", "tools");
  }
  for (const [index, message] of body.messages.entries()) {
    if (!isObject(message) || !["user", "assistant", "system"].includes(message.role)) {
      throw invalid("messages must use user, assistant, or system roles", `messages[${index}].role`);
    }
    if (!(typeof message.content === "string" || Array.isArray(message.content))) {
      throw invalid("message content must be a string or an array", `messages[${index}].content`);
    }
  }
  return body;
}

function dataUrl(source) {
  if (!isObject(source)) return null;
  if (source.type === "url" && typeof source.url === "string") return source.url;
  if (
    source.type === "base64" &&
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" || part?.type === "thinking") return part.text || part.thinking || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function openAiContentFromAnthropic(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromAnthropicContent(content);
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push({ type: "text", text: block });
    } else if (block?.type === "text") {
      parts.push({ type: "text", text: String(block.text || "") });
    } else if (block?.type === "image") {
      const url = dataUrl(block.source);
      if (url) {
        parts.push({ type: "image_url", image_url: { url } });
      }
    } else if (block?.type === "document") {
      const source = block.source || {};
      if (source.type === "text" && typeof source.data === "string") {
        parts.push({ type: "text", text: source.data });
      }
    }
  }
  if (!parts.length) return "";
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function assistantMessage(message) {
  const blocks = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
  const textParts = [];
  const toolCalls = [];
  for (const block of blocks) {
    if (block?.type === "text") {
      textParts.push({ type: "text", text: String(block.text || "") });
    } else if (block?.type === "tool_use" && block.name) {
      toolCalls.push({
        id: block.id || `toolu_${crypto.randomBytes(12).toString("hex")}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(isObject(block.input) ? block.input : {}),
        },
      });
    }
  }
  const content = textParts.length === 0
    ? null
    : textParts.length === 1
      ? textParts[0].text
      : textParts;
  const out = {
    role: "assistant",
    content,
  };
  out[ANTHROPIC_METADATA] = { content: clone(blocks) };
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

function userMessages(message) {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }];
  }
  const toolResults = [];
  const userBlocks = [];
  for (const block of message.content) {
    if (block?.type === "tool_result" && block.tool_use_id) {
      const toolResult = {
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: openAiContentFromAnthropic(block.content),
      };
      toolResult[ANTHROPIC_METADATA] = { tool_result: clone(block) };
      toolResults.push(toolResult);
    } else {
      userBlocks.push(block);
    }
  }
  const out = [...toolResults];
  if (userBlocks.length || !toolResults.length) {
    const user = { role: "user", content: openAiContentFromAnthropic(userBlocks) };
    user[ANTHROPIC_METADATA] = { content: clone(userBlocks) };
    out.push(user);
  }
  return out;
}

function systemReminderMessage(message) {
  const text = textFromAnthropicContent(message.content);
  const user = {
    role: "user",
    content: text ? `<instructions>\n${text}\n</instructions>` : "",
  };
  user[ANTHROPIC_METADATA] = {
    content: [{ type: "text", text: user.content }],
  };
  return user;
}

function openAiTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!isObject(tool)) continue;
    if (tool.type && tool.type !== "custom" && !tool.input_schema) {
      out.push(clone(tool));
      continue;
    }
    if (!tool.name) continue;
    out.push({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.input_schema || { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function openAiToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === "string") return choice;
  if (!isObject(choice)) return undefined;
  if (choice.type === "any") return "required";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  if (["auto", "none", "required"].includes(choice.type)) return choice.type;
  return undefined;
}

function toChatCompletionsBody(body) {
  validateAnthropicRequest(body);
  const messages = [];
  const systemBlocks = Array.isArray(body.system)
    ? body.system
        .filter((block) => block?.type === "text")
        .map((block) => ({
          type: "text",
          text: String(block.text || ""),
          ...(block.cache_control ? { cache_control: clone(block.cache_control) } : {}),
        }))
    : null;
  const system = systemBlocks
    ? systemBlocks.map((block) => block.text).join("\n")
    : textFromAnthropicContent(body.system);
  if ((typeof system === "string" && system) || (Array.isArray(system) && system.length)) {
    const systemMessage = { role: "system", content: system };
    systemMessage[ANTHROPIC_METADATA] = { content: clone(body.system) };
    messages.push(systemMessage);
  }
  for (const message of body.messages) {
    if (message.role === "assistant") messages.push(assistantMessage(message));
    else if (message.role === "system") messages.push(systemReminderMessage(message));
    else messages.push(...userMessages(message));
  }
  const out = {
    model: body.model,
    messages,
    stream: !!body.stream,
    max_tokens: body.max_tokens || 4096,
  };
  out[ANTHROPIC_METADATA] = {
    system: clone(body.system),
    tools: clone(body.tools),
    options: Object.fromEntries(
      ["top_k", "service_tier", "context_management", "mcp_servers"]
        .filter((key) => body[key] !== undefined)
        .map((key) => [key, clone(body[key])])
    ),
  };
  const tools = openAiTools(body.tools);
  if (tools) out.tools = tools;
  const toolChoice = openAiToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (body.tool_choice?.disable_parallel_tool_use !== undefined) {
    out.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
  }
  if (body.stop_sequences !== undefined) out.stop = clone(body.stop_sequences);
  for (const key of [
    "temperature",
    "top_p",
    "metadata",
    "thinking",
    "output_config",
  ]) {
    if (body[key] !== undefined) out[key] = clone(body[key]);
  }
  return out;
}

function parseToolInput(value) {
  if (isObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function anthropicStopReason(reason) {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  if (["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"].includes(reason)) {
    return reason;
  }
  return "end_turn";
}

function anthropicUsage(usage) {
  const source = isObject(usage) ? usage : {};
  const details = source.prompt_tokens_details || source.input_tokens_details || {};
  const inputTokens = Number(source.input_tokens ?? source.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(source.output_tokens ?? source.completion_tokens ?? 0) || 0;
  const cacheRead = Number(
    source.cache_read_input_tokens ?? details.cached_tokens ?? source.cached_tokens ?? 0
  ) || 0;
  const cacheCreation = Number(
    source.cache_creation_input_tokens ?? details.cache_creation_tokens ?? 0
  ) || 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation ? { cache_creation_input_tokens: cacheCreation } : {}),
  };
}

function messageId(value) {
  const source = String(value || crypto.randomUUID()).replace(/^chatcmpl[-_]?/, "");
  return source.startsWith("msg_") ? source : `msg_${source.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function fromChatCompletion(data, requestedModel) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  const preserved = message[ANTHROPIC_METADATA] || message.extra_content?.anthropic;
  let content = Array.isArray(preserved?.content) ? clone(preserved.content) : [];
  if (!content.length) {
    if (typeof message.content === "string" && message.content) {
      content.push({ type: "text", text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === "text" && part.text != null) {
          content.push({ type: "text", text: String(part.text) });
        }
      }
    }
    for (const call of message.tool_calls || []) {
      const fn = call.function || call.custom || {};
      if (!fn.name) continue;
      content.push({
        type: "tool_use",
        id: call.id || `toolu_${crypto.randomBytes(12).toString("hex")}`,
        name: fn.name,
        input: parseToolInput(fn.arguments ?? fn.input),
      });
    }
  }
  return {
    id: messageId(data?.id),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: preserved?.stop_reason || anthropicStopReason(choice.finish_reason),
    stop_sequence: preserved?.stop_sequence ?? null,
    usage: anthropicUsage(data?.usage),
  };
}

function toAnthropicError(error, fallbackMessage = "Request failed", status) {
  const source = isObject(error?.error) ? error.error : isObject(error) ? error : {};
  const type = status === 404 || source.code === "model_not_found" || source.type === "not_found_error"
    ? "not_found_error"
    : status === 401 || source.type === "authentication_error" || source.code === "invalid_api_key"
      ? "authentication_error"
      : status === 403 || source.type === "permission_error"
        ? "permission_error"
        : status === 429 || source.type === "rate_limit_error"
            ? "rate_limit_error"
            : source.type === "invalid_request_error"
              ? "invalid_request_error"
              : "api_error";
  return {
    type: "error",
    error: {
      type,
      message: source.message || (typeof error === "string" ? error : fallbackMessage),
    },
  };
}

function writeEvent(sink, type, data) {
  sink.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Claude Code filters SSE comments and ping events before its stream-event
// watchdog. This zero-impact delta reaches that watchdog without adding content
// or completing the response; the real final delta remains authoritative.
const ANTHROPIC_SSE_HEARTBEAT =
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":null,"stop_sequence":null},"usage":{"output_tokens":0}}\n\n';

async function pipeChatCompletionsSseToAnthropic(streamPipe, sink, requestedModel) {
  const parser = createSseParser();
  const id = messageId();
  let nextBlockIndex = 0;
  let textBlock = null;
  let finishReason = null;
  let stopSequence = null;
  let usage = null;
  let errorSent = false;
  const tools = new Map();
  const opaqueBlocks = new Map();

  writeEvent(sink, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const closeText = () => {
    if (textBlock == null) return;
    writeEvent(sink, "content_block_stop", {
      type: "content_block_stop",
      index: textBlock,
    });
    textBlock = null;
  };

  const ensureText = () => {
    if (textBlock != null) return textBlock;
    textBlock = nextBlockIndex++;
    writeEvent(sink, "content_block_start", {
      type: "content_block_start",
      index: textBlock,
      content_block: { type: "text", text: "" },
    });
    return textBlock;
  };

  const processOpaqueEvent = (event) => {
    if (!isObject(event)) return;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (!block || !["thinking", "redacted_thinking"].includes(block.type)) return;
      closeText();
      const localIndex = nextBlockIndex++;
      opaqueBlocks.set(event.index, localIndex);
      writeEvent(sink, "content_block_start", {
        ...clone(event),
        index: localIndex,
      });
      return;
    }
    const localIndex = opaqueBlocks.get(event.index);
    if (localIndex == null) return;
    if (event.type === "content_block_delta") {
      writeEvent(sink, "content_block_delta", { ...clone(event), index: localIndex });
    } else if (event.type === "content_block_stop") {
      writeEvent(sink, "content_block_stop", { ...clone(event), index: localIndex });
      opaqueBlocks.delete(event.index);
    }
  };

  const adapterSink = {
    write(chunk) {
      for (const event of parser.push(chunk)) {
        if (event.data === "[DONE]") continue;
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          throw new Error("Upstream sent malformed SSE JSON");
        }
        if (data.error) throw new Error(data.error.message || "Upstream stream failed");
        if (data.usage) usage = data.usage;
        const choice = data.choices?.[0] || {};
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        const opaqueEvent = delta.extra_content?.anthropic?.event;
        if (opaqueEvent) processOpaqueEvent(opaqueEvent);
        if (delta.extra_content?.anthropic?.stop_sequence !== undefined) {
          stopSequence = delta.extra_content.anthropic.stop_sequence;
        }
        if (typeof delta.content === "string" && delta.content) {
          const index = ensureText();
          writeEvent(sink, "content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: delta.content },
          });
        }
        for (const callDelta of delta.tool_calls || []) {
          const key = callDelta.index ?? callDelta.id ?? 0;
          let tool = tools.get(key);
          if (!tool) {
            tool = {
              id: callDelta.id || `toolu_${crypto.randomBytes(12).toString("hex")}`,
              name: callDelta.function?.name || callDelta.custom?.name || "",
              arguments: "",
            };
            tools.set(key, tool);
          }
          if (callDelta.id) tool.id = callDelta.id;
          if (callDelta.function?.name) tool.name = callDelta.function.name;
          if (callDelta.custom?.name) tool.name = callDelta.custom.name;
          const argumentDelta = callDelta.function?.arguments ?? callDelta.custom?.input;
          if (argumentDelta) tool.arguments += argumentDelta;
        }
      }
      return true;
    },
  };

  try {
    const streamUsage = await streamPipe(adapterSink);
    if (streamUsage) usage = streamUsage;
    closeText();
    for (const tool of tools.values()) {
      if (!tool.name) continue;
      const index = nextBlockIndex++;
      writeEvent(sink, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
      });
      if (tool.arguments) {
        writeEvent(sink, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: tool.arguments },
        });
      }
      writeEvent(sink, "content_block_stop", {
        type: "content_block_stop",
        index,
      });
    }
    const convertedUsage = anthropicUsage(usage);
    writeEvent(sink, "message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: anthropicStopReason(finishReason),
        stop_sequence: stopSequence,
      },
      usage: { output_tokens: convertedUsage.output_tokens },
    });
    writeEvent(sink, "message_stop", { type: "message_stop" });
    return usage;
  } catch (error) {
    writeEvent(sink, "error", toAnthropicError(error, "Stream failed"));
    errorSent = true;
    error.anthropicStreamErrorSent = true;
    throw error;
  } finally {
    if (errorSent) {
      for (const tool of tools.values()) tool.arguments = "";
    }
  }
}

function countValueChars(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countValueChars(item), 0);
  if (isObject(value)) {
    return Object.entries(value).reduce(
      (total, [key, item]) => total + key.length + countValueChars(item),
      0
    );
  }
  return 0;
}

function estimateInputTokens(body = {}) {
  const chars = countValueChars(body.system) +
    countValueChars(body.messages) +
    countValueChars(body.tools);
  return Math.max(0, Math.ceil(chars / 4));
}

module.exports = {
  validateAnthropicRequest,
  toChatCompletionsBody,
  fromChatCompletion,
  pipeChatCompletionsSseToAnthropic,
  ANTHROPIC_SSE_HEARTBEAT,
  toAnthropicError,
  estimateInputTokens,
  anthropicUsage,
  anthropicStopReason,
};
