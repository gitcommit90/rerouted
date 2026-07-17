"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  toChatCompletionsBody,
  fromChatCompletion,
  pipeChatCompletionsSseToResponses,
  toResponsesError,
} = require("../src/lib/responses-api");

describe("Responses API adapter", () => {
  it("converts instructions, input, tools, calls, results, and tool choice", () => {
    const body = toChatCompletionsBody({
      model: "route",
      instructions: "Be concise",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Weather?" }] },
        { type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"Oslo"}' },
        { type: "function_call_output", call_id: "call_1", output: "Sunny" },
      ],
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Get weather",
          parameters: { type: "object" },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "weather" },
      parallel_tool_calls: false,
      stream: true,
    });

    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[1].content[0].type, "text");
    assert.equal(body.messages[2].tool_calls[0].function.name, "weather");
    assert.equal(body.messages[3].tool_call_id, "call_1");
    assert.equal(body.tools[0].function.strict, true);
    assert.equal(body.tool_choice.function.name, "weather");
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.stream, true);
  });

  it("converts a non-streaming chat completion with tools and usage", () => {
    const response = fromChatCompletion(
      {
        id: "chatcmpl_1",
        model: "upstream",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Checking",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "weather", arguments: "{}" } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      },
      "route"
    );

    assert.equal(response.object, "response");
    assert.equal(response.status, "completed");
    assert.equal(response.output[0].content[0].text, "Checking");
    assert.equal(response.output[1].type, "function_call");
    assert.equal(response.output[1].call_id, "call_1");
    assert.deepEqual(response.usage, { input_tokens: 3, output_tokens: 4, total_tokens: 7 });
  });

  it("translates chat SSE to Responses SSE through a generic sink", async () => {
    const chunks = [];
    const sink = { write: (chunk) => chunks.push(String(chunk)) };
    const streamPipe = async (target) => {
      target.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hi" } }] })}\n\n`
      );
      target.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "weather", arguments: '{"city":' },
                  },
                ],
              },
            },
          ],
        })}\n\n`
      );
      target.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        })}\n\n`
      );
      target.write("data: [DONE]\n\n");
      return { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };
    };

    const usage = await pipeChatCompletionsSseToResponses(streamPipe, sink, "route");
    const text = chunks.join("");
    assert.match(text, /event: response\.created/);
    assert.match(text, /event: response\.output_text\.delta/);
    assert.match(text, /event: response\.function_call_arguments\.delta/);
    assert.match(text, /event: response\.completed/);
    assert.ok(text.includes('"arguments":"{\\"city\\":\\"Oslo\\"}"'));
    assert.deepEqual(usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  });

  it("emits text and tool argument deltas before the upstream stream resolves", async () => {
    const chunks = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let started;
    const firstWrite = new Promise((resolve) => { started = resolve; });
    const pending = pipeChatCompletionsSseToResponses(async (sink) => {
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "shell", arguments: "{\"cmd\":" } }] } }] })}\n\n`);
      started();
      await gate;
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"pwd\"}" } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    }, { write: (chunk) => chunks.push(String(chunk)) }, "route");

    await firstWrite;
    assert.match(chunks.join(""), /event: response\.output_text\.delta/);
    assert.match(chunks.join(""), /event: response\.function_call_arguments\.delta/);
    assert.doesNotMatch(chunks.join(""), /event: response\.completed/);
    release();
    await pending;
    assert.match(chunks.join(""), /event: response\.completed/);
  });

  it("accepts a Codex-shaped request and preserves supported adapter fields", () => {
    const request = {
      model: "coding-route",
      instructions: "You are a coding agent.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this screenshot" },
            { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "high" },
          ],
        },
        { type: "function_call", id: "fc_a", call_id: "call_a", name: "read_file", arguments: '{"path":"a.js"}' },
        { type: "function_call", id: "fc_b", call_id: "call_b", name: "read_file", arguments: '{"path":"b.js"}' },
        { type: "function_call_output", call_id: "call_a", output: "a" },
        { type: "function_call_output", call_id: "call_b", output: [{ type: "input_text", text: "b" }] },
      ],
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" }, strict: false }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "thread-1",
      text: { format: { type: "text" }, verbosity: "low" },
      truncation: "auto",
      max_output_tokens: 4096,
    };
    const body = toChatCompletionsBody(request);
    assert.equal(body.messages[1].content[1].type, "image_url");
    assert.equal(body.messages[1].content[1].image_url.detail, "high");
    assert.equal(body.messages[2].tool_calls.length, 2);
    assert.deepEqual(body.reasoning, request.reasoning);
    assert.equal(body.reasoning_effort, "high");
    assert.deepEqual(body.include, request.include);
    assert.equal(body.prompt_cache_key, "thread-1");
    assert.deepEqual(body.text, request.text);
    assert.equal(body.truncation, "auto");
    assert.equal(body.max_tokens, 4096);
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal(body.max_output_tokens, 4096);
  });

  it("rejects malformed input and stateless continuation IDs", () => {
    assert.throws(
      () => toChatCompletionsBody({ model: "route", input: [{ type: "function_call", name: "x", arguments: "{}" }] }),
      (error) => error.status === 400 && error.error.param === "input[0].call_id"
    );
    assert.throws(
      () => toChatCompletionsBody({ model: "route", input: "hi", previous_response_id: "resp_prior" }),
      (error) => error.status === 400 && error.error.param === "previous_response_id"
    );
  });

  it("preserves the requested route and marks length-limited responses incomplete", () => {
    const request = { instructions: "Code", tools: [{ type: "function", name: "shell" }], tool_choice: "required", parallel_tool_calls: false };
    const response = fromChatCompletion({
      id: "chatcmpl-limit",
      model: "upstream-model",
      choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
    }, "public-route", request);
    assert.equal(response.model, "public-route");
    assert.equal(response.status, "incomplete");
    assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
    assert.equal(response.instructions, "Code");
    assert.deepEqual(response.tools, request.tools);
    assert.equal(response.tool_choice, "required");
    assert.equal(response.parallel_tool_calls, false);
  });

  it("keeps tool-first and text output indexes stable with distinct item and call IDs", async () => {
    const chunks = [];
    await pipeChatCompletionsSseToResponses(async (sink) => {
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "shell", arguments: "{}" } }] } }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] })}\n\n`);
    }, { write: (chunk) => chunks.push(String(chunk)) }, "route", { instructions: "Code" });
    const events = chunks.join("").split("\n\n").filter(Boolean).map((block) => JSON.parse(block.split("\ndata: ")[1]));
    assert.equal(events.filter((event) => event.type === "response.created").length, 1);
    assert.equal(events.filter((event) => event.type === "response.in_progress").length, 1);
    assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
    assert.equal(events.some((event) => JSON.stringify(event).includes("[DONE]")), false);
    const added = events.filter((event) => event.type === "response.output_item.added");
    assert.deepEqual(added.map((event) => event.output_index), [0, 1]);
    assert.notEqual(added[0].item.id, added[0].item.call_id);
    const completed = events.find((event) => event.type === "response.completed").response;
    assert.deepEqual(completed.output.map((item) => item.type), ["function_call", "message"]);
    assert.equal(completed.model, "route");
    assert.equal(completed.instructions, "Code");
  });

  it("round-trips encrypted reasoning through the ChatGPT durable extension", () => {
    const reasoning = {
      id: "rs_turn_1",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "private summary" }],
      content: [{ type: "reasoning_text", text: "private reasoning" }],
      encrypted_content: "encrypted-turn-1",
      decrypted_content: "private plaintext",
    };
    const routed = toChatCompletionsBody({
      model: "route",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Look up 42" }] },
        reasoning,
        { type: "function_call", call_id: "call_42", name: "lookup", arguments: '{"id":42}' },
        { type: "function_call_output", call_id: "call_42", output: "found" },
      ],
      include: ["reasoning.encrypted_content"],
    });
    assert.deepEqual(routed.messages[1].tool_calls[0].extra_content, {
      openai: {
        reasoning_items: [{ id: "rs_turn_1", type: "reasoning", status: "completed", encrypted_content: "encrypted-turn-1" }],
      },
    });
    assert.doesNotMatch(JSON.stringify(routed), /private/);

    const response = fromChatCompletion({
      id: "chatcmpl_turn_2",
      choices: [{ message: routed.messages[1], finish_reason: "tool_calls" }],
    }, "route", { include: ["reasoning.encrypted_content"] });
    assert.deepEqual(response.output.map((item) => item.type), ["reasoning", "function_call"]);
    assert.equal(response.output[0].encrypted_content, "encrypted-turn-1");
    assert.doesNotMatch(JSON.stringify(response), /private/);

    const omitted = fromChatCompletion({
      id: "chatcmpl_turn_2",
      choices: [{ message: routed.messages[1], finish_reason: "tool_calls" }],
    }, "route", {});
    assert.deepEqual(omitted.output.map((item) => item.type), ["function_call"]);
  });

  it("streams encrypted reasoning items with stable output indexes", async () => {
    const chunks = [];
    await pipeChatCompletionsSseToResponses(async (sink) => {
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] } }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", extra_content: { openai: { reasoning_items: [{ id: "rs_1", type: "reasoning", encrypted_content: "encrypted-1", summary: [{ type: "summary_text", text: "private" }] }] } } }] }, finish_reason: "tool_calls" }] })}\n\n`);
    }, { write: (chunk) => chunks.push(String(chunk)) }, "route", { include: ["reasoning.encrypted_content"] });
    const events = chunks.join("").split("\n\n").filter(Boolean).map((block) => JSON.parse(block.split("\ndata: ")[1]));
    const added = events.filter((event) => event.type === "response.output_item.added");
    assert.deepEqual(added.map((event) => [event.output_index, event.item.type]), [[0, "reasoning"], [1, "function_call"]]);
    const completed = events.find((event) => event.type === "response.completed").response;
    assert.deepEqual(completed.output.map((item) => item.type), ["reasoning", "function_call"]);
    assert.equal(completed.output[0].encrypted_content, "encrypted-1");
    assert.doesNotMatch(chunks.join(""), /private/);
  });

  it("emits documented top-level streaming errors", async () => {
    const chunks = [];
    await assert.rejects(
      pipeChatCompletionsSseToResponses(async () => { throw Object.assign(new Error("Exact failure"), { code: "invalid_model", param: "model" }); }, { write: (chunk) => chunks.push(String(chunk)) }, "route"),
      /Exact failure/
    );
    const event = JSON.parse(chunks.at(-1).split("\ndata: ")[1]);
    assert.deepEqual(event, {
      type: "error",
      sequence_number: 2,
      code: "invalid_model",
      message: "Exact failure",
      param: "model",
    });
    assert.equal("error" in event, false);
  });

  it("normalizes errors", () => {
    assert.deepEqual(
      toResponsesError({ error: { message: "Missing", type: "invalid_request_error", code: "bad" } }),
      { error: { message: "Missing", type: "invalid_request_error", code: "bad" } }
    );
  });
});
