"use strict";

const crypto = require("node:crypto");
const { createSseParser } = require("./sse");

function invalid(message, param) {
  const error = new Error(message);
  error.status = 400;
  error.error = { message, type: "invalid_request_error", code: "invalid_request", param };
  return error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value);
  return value.map((part) => typeof part === "string" ? part : part?.text || "").join("");
}

function validateResponsesRequest(body) {
  if (!isObject(body)) throw invalid("Request body must be a JSON object", null);
  if (typeof body.model !== "string" || !body.model.trim()) throw invalid("model is required", "model");
  if (body.previous_response_id != null) {
    throw invalid("previous_response_id is not supported by this stateless gateway; send prior items in input", "previous_response_id");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    throw invalid("input must be a string or an array of input items", "input");
  }
  if (body.instructions != null && typeof body.instructions !== "string") {
    throw invalid("instructions must be a string", "instructions");
  }
  if (body.stream != null && typeof body.stream !== "boolean") throw invalid("stream must be a boolean", "stream");
  if (body.tools != null && !Array.isArray(body.tools)) throw invalid("tools must be an array", "tools");
  if (body.reasoning != null && !isObject(body.reasoning)) throw invalid("reasoning must be an object", "reasoning");
  if (body.max_output_tokens != null && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1)) {
    throw invalid("max_output_tokens must be a positive integer", "max_output_tokens");
  }
  if (Array.isArray(body.tools)) validateTools(body.tools, "tools");
  if (Array.isArray(body.input)) {
    body.input.forEach((item, index) => validateInputItem(item, `input[${index}]`));
  }
  return body;
}

function validateContentPart(part, param) {
  if (!isObject(part) || typeof part.type !== "string") throw invalid("Content parts must be objects with a type", param);
  if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text !== "string") {
    throw invalid("Text content requires a string text field", `${param}.text`);
  }
  if (part.type === "input_image") {
    const image = part.image_url ?? part.file_id;
    if (typeof image !== "string" || !image) throw invalid("input_image requires image_url or file_id", param);
  } else if (!["input_text", "output_text", "text"].includes(part.type)) {
    throw invalid(`Unsupported content type: ${part.type}`, `${param}.type`);
  }
}

function normalizeContentParts(value, param) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return value;
  validateContentPart(value, param);
  return [value];
}

function encryptedReasoningItem(item) {
  if (!isObject(item) || item.type !== "reasoning" || typeof item.encrypted_content !== "string") return null;
  const copy = { type: "reasoning" };
  for (const key of ["id", "status", "encrypted_content"]) {
    if (item[key] !== undefined) copy[key] = JSON.parse(JSON.stringify(item[key]));
  }
  if (Array.isArray(item.summary) && item.summary.length === 0) copy.summary = [];
  if (Array.isArray(item.content) && item.content.length === 0) copy.content = [];
  return copy;
}

function reasoningItemsFromCall(call) {
  const items = call?.extra_content?.openai?.reasoning_items;
  return Array.isArray(items) ? items.map(encryptedReasoningItem).filter(Boolean) : [];
}

function validateTools(tools, param) {
  tools.forEach((tool, index) => {
    if (!isObject(tool) || typeof tool.type !== "string") throw invalid("Each tool must be an object with a type", `${param}[${index}]`);
    if (tool.type === "function" && (typeof tool.name !== "string" || !tool.name)) {
      throw invalid("Function tools require a name", `${param}[${index}].name`);
    }
  });
}

function validateInputItem(item, param) {
  if (!isObject(item)) throw invalid("Input items must be objects", param);
  if (item.type === "additional_tools") {
    if (!Array.isArray(item.tools)) throw invalid("additional_tools tools must be an array", `${param}.tools`);
    validateTools(item.tools, `${param}.tools`);
    return;
  }
  if (item.type === "reasoning") {
    if (item.encrypted_content != null && typeof item.encrypted_content !== "string") {
      throw invalid("reasoning encrypted_content must be a string or null", `${param}.encrypted_content`);
    }
    return;
  }
  if (item.type === "item_reference") {
    throw invalid("item_reference is not supported by this stateless gateway; send the referenced item in input", param);
  }
  if (item.type === "function_call") {
    if (typeof item.call_id !== "string" || !item.call_id) throw invalid("function_call requires call_id", `${param}.call_id`);
    if (typeof item.name !== "string" || !item.name) throw invalid("function_call requires name", `${param}.name`);
    if (typeof item.arguments !== "string") throw invalid("function_call arguments must be a string", `${param}.arguments`);
    return;
  }
  if (item.type === "function_call_output") {
    if (typeof item.call_id !== "string" || !item.call_id) throw invalid("function_call_output requires call_id", `${param}.call_id`);
    if (!(typeof item.output === "string" || Array.isArray(item.output))) throw invalid("function_call_output requires string or array output", `${param}.output`);
    return;
  }
  if (item.type === "custom_tool_call") {
    if (typeof item.call_id !== "string" || !item.call_id) throw invalid("custom_tool_call requires call_id", `${param}.call_id`);
    if (typeof item.name !== "string" || !item.name) throw invalid("custom_tool_call requires name", `${param}.name`);
    if (typeof item.input !== "string") throw invalid("custom_tool_call input must be a string", `${param}.input`);
    return;
  }
  if (item.type === "custom_tool_call_output") {
    if (typeof item.call_id !== "string" || !item.call_id) throw invalid("custom_tool_call_output requires call_id", `${param}.call_id`);
    if (typeof item.output !== "string") throw invalid("custom_tool_call_output output must be a string", `${param}.output`);
    return;
  }
  if (item.type !== undefined && item.type !== "message") throw invalid("Unsupported input item", `${param}.type`);
  if (!["user", "assistant", "system", "developer"].includes(item.role)) throw invalid("Invalid message role", `${param}.role`);
  if (item.content == null) {
    if (item.role !== "assistant") throw invalid("Message content must be a string, content part, or array", `${param}.content`);
    return;
  }
  item.content = normalizeContentParts(item.content, `${param}.content`);
  if (!(typeof item.content === "string" || Array.isArray(item.content))) {
    throw invalid("Message content must be a string, content part, or array", `${param}.content`);
  }
  if (Array.isArray(item.content)) item.content.forEach((part, index) => validateContentPart(part, `${param}.content[${index}]`));
}

function inputMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const messages = [];
  let pendingAssistant = null;
  let pendingReasoning = [];
  for (const item of input) {
    if (item.type === "additional_tools") continue;
    if (item.type === "reasoning") {
      const reasoning = encryptedReasoningItem(item);
      if (reasoning) pendingReasoning.push(reasoning);
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (!pendingAssistant) {
        pendingAssistant = { role: "assistant", content: null, tool_calls: [] };
        messages.push(pendingAssistant);
      }
      const custom = item.type === "custom_tool_call";
      const call = {
        id: item.call_id,
        type: custom ? "custom" : "function",
        ...(custom
          ? { custom: { name: item.name, input: item.input } }
          : { function: { name: item.name, arguments: item.arguments } }),
      };
      if (pendingReasoning.length) {
        call.extra_content = { openai: { reasoning_items: pendingReasoning.map((reasoning) => ({ ...reasoning })) } };
      }
      pendingAssistant.tool_calls.push(call);
      continue;
    }
    pendingAssistant = null;
    pendingReasoning = [];
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: textContent(item.output),
        ...(item.type === "custom_tool_call_output" ? { extra_content: { openai: { custom_tool_call_output: true } } } : {}),
      });
      continue;
    }
    messages.push({
      role: item.role === "developer" ? "system" : item.role,
      content: Array.isArray(item.content)
        ? item.content.map((part) => part.type === "input_image"
          ? { type: "image_url", image_url: { url: part.image_url || part.file_id, ...(part.detail ? { detail: part.detail } : {}) } }
          : { type: "text", text: part.text })
        : item.content,
    });
  }
  return messages;
}

function toChatTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((tool) => tool.type !== "function" || tool.function ? tool : {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.parameters || { type: "object", properties: {} },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  });
}

function toChatToolChoice(choice) {
  if (!isObject(choice) || choice.type !== "function" || choice.function) return choice;
  return { type: "function", function: { name: choice.name } };
}

function toChatCompletionsBody(body) {
  validateResponsesRequest(body);
  const messages = inputMessages(body.input);
  if (body.instructions != null) messages.unshift({ role: "system", content: body.instructions });
  const out = { model: body.model, messages, stream: !!body.stream };
  const declaredTools = [
    ...(body.tools || []),
    ...(Array.isArray(body.input) ? body.input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools) : []),
  ];
  const tools = toChatTools(declaredTools);
  if (tools) out.tools = tools;
  if (body.tool_choice !== undefined) out.tool_choice = toChatToolChoice(body.tool_choice);
  if (body.reasoning !== undefined) out.reasoning = { ...body.reasoning };
  if (body.reasoning?.effort !== undefined) out.reasoning_effort = body.reasoning.effort;
  for (const key of ["parallel_tool_calls", "temperature", "top_p", "metadata", "include", "prompt_cache_key", "text", "truncation"]) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (body.max_output_tokens !== undefined) {
    out.max_tokens = body.max_output_tokens;
    out.max_completion_tokens = body.max_output_tokens;
    out.max_output_tokens = body.max_output_tokens;
  }
  return out;
}

function responseUsage(usage) {
  if (!isObject(usage)) return undefined;
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
    ...(usage.prompt_tokens_details ? { input_tokens_details: { ...usage.prompt_tokens_details } } : {}),
    ...(usage.completion_tokens_details ? { output_tokens_details: { ...usage.completion_tokens_details } } : {}),
  };
}

function requestShape(request = {}) {
  return {
    instructions: request.instructions ?? null,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    ...(request.text !== undefined ? { text: request.text } : {}),
    ...(request.truncation !== undefined ? { truncation: request.truncation } : {}),
    ...(request.max_output_tokens !== undefined ? { max_output_tokens: request.max_output_tokens } : {}),
  };
}

function responseEnvelope({ id, model, request, output = [], usage, status = "completed", error = null, incompleteDetails = null }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error,
    incomplete_details: incompleteDetails,
    ...requestShape(request),
    model,
    output,
    ...(usage ? { usage: responseUsage(usage) } : {}),
  };
}

function outputFromMessage(message, responseId, request) {
  const output = [];
  const text = textContent(message?.content);
  const includeReasoning = request?.include?.includes("reasoning.encrypted_content");
  if (text) output.push({ id: `msg_${responseId.slice(5)}_0`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
  const emittedReasoning = new Set();
  for (const [index, call] of (message?.tool_calls || []).entries()) {
    if (includeReasoning) {
      for (const reasoning of reasoningItemsFromCall(call)) {
        const identity = reasoning.id || reasoning.encrypted_content;
        if (emittedReasoning.has(identity)) continue;
        emittedReasoning.add(identity);
        output.push(reasoning);
      }
    }
    const callId = call.id || `call_${crypto.randomUUID().replaceAll("-", "")}`;
    const custom = call.type === "custom" && call.custom;
    output.push(custom
      ? { id: `ctc_${responseId.slice(5)}_${index}`, type: "custom_tool_call", status: "completed", call_id: callId, name: call.custom.name, input: call.custom.input || "" }
      : { id: `fc_${responseId.slice(5)}_${index}`, type: "function_call", status: "completed", call_id: callId, name: call.function?.name, arguments: call.function?.arguments || "" });
  }
  return output;
}

function fromChatCompletion(data, requestedModel, request = {}) {
  const id = String(data?.id || `resp_${crypto.randomUUID().replaceAll("-", "")}`).replace(/^chatcmpl[-_]/, "resp_");
  const choice = data?.choices?.[0] || {};
  const incomplete = choice.finish_reason === "length";
  return responseEnvelope({
    id,
    model: requestedModel,
    request,
    output: outputFromMessage(choice.message || {}, id, request),
    usage: data?.usage,
    status: incomplete ? "incomplete" : "completed",
    incompleteDetails: incomplete ? { reason: "max_output_tokens" } : null,
  });
}

function writeEvent(sink, type, data, sequence) {
  sink.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...data })}\n\n`);
}

async function pipeChatCompletionsSseToResponses(streamPipe, sink, model, request = {}) {
  const parser = createSseParser();
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const entries = [];
  const calls = new Map();
  let message;
  let usage;
  let sequence = 0;
  let finishReason;
  let terminal = false;
  const deferForReasoning = request.include?.includes("reasoning.encrypted_content");
  const slot = () => entries.length;
  const initial = responseEnvelope({ id: responseId, model, request, status: "in_progress" });
  writeEvent(sink, "response.created", { response: initial }, sequence++);
  writeEvent(sink, "response.in_progress", { response: initial }, sequence++);

  const ensureMessage = () => {
    if (message) return message;
    const outputIndex = slot();
    message = { id: `msg_${responseId.slice(5)}_0`, type: "message", status: "in_progress", role: "assistant", content: [], text: "", textDeltas: [], outputIndex, emitted: false };
    entries.push(message);
    if (!deferForReasoning) {
      const pending = { id: message.id, type: "message", status: "in_progress", role: "assistant", content: [] };
      writeEvent(sink, "response.output_item.added", { output_index: outputIndex, item: pending }, sequence++);
      writeEvent(sink, "response.content_part.added", { item_id: message.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, sequence++);
      message.emitted = true;
    }
    return message;
  };

  const adapterSink = { write(chunk) {
    for (const event of parser.push(chunk)) {
      if (event.data === "[DONE]") continue;
      let data;
      try { data = JSON.parse(event.data); } catch { throw new Error("Upstream sent malformed SSE JSON"); }
      if (data.error) throw new Error(data.error.message || "Upstream stream failed");
      if (data.usage) usage = data.usage;
      const choice = data.choices?.[0] || {};
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        const current = ensureMessage();
        current.text += delta.content;
        current.textDeltas.push(delta.content);
        if (current.emitted) writeEvent(sink, "response.output_text.delta", { item_id: current.id, output_index: current.outputIndex, content_index: 0, delta: delta.content }, sequence++);
      }
      for (const callDelta of delta.tool_calls || []) {
        const key = callDelta.index ?? callDelta.id ?? 0;
        let call = calls.get(key);
        if (!call) {
          const outputIndex = slot();
          const callId = callDelta.id || `call_${crypto.randomUUID().replaceAll("-", "")}`;
          const custom = callDelta.type === "custom" || !!callDelta.custom;
          call = { id: `${custom ? "ctc" : "fc"}_${responseId.slice(5)}_${calls.size}`, call_id: callId, type: custom ? "custom_tool_call" : "function_call", status: "in_progress", name: custom ? callDelta.custom?.name || "" : callDelta.function?.name || "", input: "", arguments: "", argumentDeltas: [], outputIndex, emitted: false };
          calls.set(key, call);
          entries.push(call);
          if (!deferForReasoning) {
            const pending = call.type === "custom_tool_call"
              ? { id: call.id, type: call.type, status: "in_progress", call_id: call.call_id, name: call.name, input: "" }
              : { id: call.id, type: call.type, status: "in_progress", call_id: call.call_id, name: call.name, arguments: "" };
            writeEvent(sink, "response.output_item.added", { output_index: outputIndex, item: pending }, sequence++);
            call.emitted = true;
          }
        }
        if (callDelta.id) call.call_id = callDelta.id;
        if (callDelta.function?.name) call.name = callDelta.function.name;
        if (callDelta.custom?.name) call.name = callDelta.custom.name;
        if (callDelta.custom?.input) {
          call.input += callDelta.custom.input;
          call.argumentDeltas.push(callDelta.custom.input);
          if (call.emitted) writeEvent(sink, "response.custom_tool_call_input.delta", { item_id: call.id, output_index: call.outputIndex, delta: callDelta.custom.input }, sequence++);
        }
        if (callDelta.function?.arguments) {
          call.arguments += callDelta.function.arguments;
          call.argumentDeltas.push(callDelta.function.arguments);
          if (call.emitted) writeEvent(sink, "response.function_call_arguments.delta", { item_id: call.id, output_index: call.outputIndex, delta: callDelta.function.arguments }, sequence++);
        }
        const reasoningItems = reasoningItemsFromCall(callDelta);
        if (reasoningItems.length) call.reasoningItems = reasoningItems;
      }
    }
    return true;
  } };

  try {
    const streamUsage = await streamPipe(adapterSink);
    if (streamUsage) usage = streamUsage;
    const output = [];
    const emittedReasoning = new Set();
    for (const entry of entries) {
      if (entry.type === "function_call" && request.include?.includes("reasoning.encrypted_content")) {
        for (const reasoning of entry.reasoningItems || []) {
          const identity = reasoning.id || reasoning.encrypted_content;
          if (emittedReasoning.has(identity)) continue;
          emittedReasoning.add(identity);
          const outputIndex = output.length;
          output.push(reasoning);
          writeEvent(sink, "response.output_item.added", { output_index: outputIndex, item: reasoning }, sequence++);
          writeEvent(sink, "response.output_item.done", { output_index: outputIndex, item: reasoning }, sequence++);
        }
      }
      const outputIndex = output.length;
      if (entry.type === "message") {
        if (!entry.emitted) {
          const pending = { id: entry.id, type: "message", status: "in_progress", role: "assistant", content: [] };
          writeEvent(sink, "response.output_item.added", { output_index: outputIndex, item: pending }, sequence++);
          writeEvent(sink, "response.content_part.added", { item_id: entry.id, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }, sequence++);
          for (const delta of entry.textDeltas) writeEvent(sink, "response.output_text.delta", { item_id: entry.id, output_index: outputIndex, content_index: 0, delta }, sequence++);
        }
        const item = { id: entry.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: entry.text, annotations: [] }] };
        output.push(item);
        writeEvent(sink, "response.output_text.done", { item_id: item.id, output_index: outputIndex, content_index: 0, text: entry.text }, sequence++);
        writeEvent(sink, "response.content_part.done", { item_id: item.id, output_index: outputIndex, content_index: 0, part: item.content[0] }, sequence++);
        writeEvent(sink, "response.output_item.done", { output_index: outputIndex, item }, sequence++);
      } else {
        if (!entry.emitted) {
          const custom = entry.type === "custom_tool_call";
          const pending = custom
            ? { id: entry.id, type: entry.type, status: "in_progress", call_id: entry.call_id, name: entry.name, input: "" }
            : { id: entry.id, type: entry.type, status: "in_progress", call_id: entry.call_id, name: entry.name, arguments: "" };
          writeEvent(sink, "response.output_item.added", { output_index: outputIndex, item: pending }, sequence++);
          for (const delta of entry.argumentDeltas) writeEvent(sink, custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", { item_id: entry.id, output_index: outputIndex, delta }, sequence++);
        }
        const custom = entry.type === "custom_tool_call";
        const item = custom
          ? { id: entry.id, type: entry.type, status: "completed", call_id: entry.call_id, name: entry.name, input: entry.input }
          : { id: entry.id, type: entry.type, status: "completed", call_id: entry.call_id, name: entry.name, arguments: entry.arguments };
        output.push(item);
        writeEvent(sink, custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done", custom
          ? { item_id: item.id, output_index: outputIndex, input: item.input }
          : { item_id: item.id, output_index: outputIndex, arguments: item.arguments }, sequence++);
        writeEvent(sink, "response.output_item.done", { output_index: outputIndex, item }, sequence++);
      }
    }
    const incomplete = finishReason === "length";
    const response = responseEnvelope({ id: responseId, model, request, output, usage, status: incomplete ? "incomplete" : "completed", incompleteDetails: incomplete ? { reason: "max_output_tokens" } : null });
    writeEvent(sink, incomplete ? "response.incomplete" : "response.completed", { response }, sequence++);
    terminal = true;
    return responseUsage(usage) || null;
  } catch (error) {
    if (!terminal) {
      writeEvent(sink, "error", { code: error.code || "stream_error", message: error.message || "Stream failed", ...(error.param != null ? { param: error.param } : {}) }, sequence++);
      terminal = true;
    }
    throw error;
  }
}

function toResponsesError(error) {
  const source = error?.error && isObject(error.error) ? error.error : error || {};
  return { error: { message: source.message || "Request failed", type: source.type || "api_error", ...(source.code != null ? { code: source.code } : {}), ...(source.param != null ? { param: source.param } : {}) } };
}

module.exports = { validateResponsesRequest, toChatCompletionsBody, fromChatCompletion, pipeChatCompletionsSseToResponses, toResponsesError, responseUsage };
