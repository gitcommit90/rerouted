"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, it } = require("node:test");
const {
  toChatCompletionsBody,
  fromChatCompletion,
  pipeChatCompletionsSseToAnthropic,
  estimateInputTokens,
  toAnthropicError,
} = require("../src/lib/anthropic-api");
const { createGateway } = require("../src/lib/gateway");
const claude = require("../src/lib/providers/claude");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const event = block.split(/\r?\n/).find((line) => line.startsWith("event:"));
      const data = block.split(/\r?\n/).find((line) => line.startsWith("data:"));
      return {
        event: event?.slice(6).trim(),
        data: data ? JSON.parse(data.slice(5).trim()) : null,
      };
    });
}

describe("Anthropic Messages adapter", () => {
  it("converts system, images, tools, thinking, and tool history to chat completions", () => {
    const body = toChatCompletionsBody({
      model: "coding",
      system: [{ type: "text", text: "Be concise" }],
      max_tokens: 2048,
      stream: true,
      thinking: { type: "adaptive" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          ],
        },
        {
          role: "system",
          content: [{ type: "text", text: "Use the latest instructions" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Checking" },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.js" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "contents", is_error: false },
            { type: "text", text: "Continue" },
          ],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      tool_choice: { type: "tool", name: "read_file", disable_parallel_tool_use: true },
    });

    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "Be concise");
    assert.equal(body.messages[1].content[1].type, "image_url");
    assert.equal(body.messages[1].content[1].image_url.url, "data:image/png;base64,QUJD");
    assert.match(body.messages[2].content, /<instructions>/);
    assert.match(body.messages[2].content, /Use the latest instructions/);
    assert.equal(body.messages[3].tool_calls[0].id, "toolu_1");
    assert.equal(body.messages[4].role, "tool");
    assert.equal(body.messages[4].tool_call_id, "toolu_1");
    assert.equal(body.messages[5].content, "Continue");
    assert.equal(body.tools[0].function.name, "read_file");
    assert.equal(body.tool_choice.function.name, "read_file");
    assert.equal(body.parallel_tool_calls, false);
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.stream, true);
  });

  it("converts non-streaming text, tools, stop reasons, and cache usage", () => {
    const response = fromChatCompletion(
      {
        id: "chatcmpl-abc",
        choices: [
          {
            message: {
              role: "assistant",
              content: "I will inspect it.",
              tool_calls: [
                {
                  id: "toolu_abc",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.js"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 5, cache_creation_tokens: 2 },
        },
      },
      "coding"
    );

    assert.equal(response.id, "msg_abc");
    assert.equal(response.type, "message");
    assert.equal(response.model, "coding");
    assert.equal(response.content[0].text, "I will inspect it.");
    assert.deepEqual(response.content[1], {
      type: "tool_use",
      id: "toolu_abc",
      name: "read_file",
      input: { path: "a.js" },
    });
    assert.equal(response.stop_reason, "tool_use");
    assert.deepEqual(response.usage, {
      input_tokens: 12,
      output_tokens: 4,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2,
    });
  });

  it("streams Anthropic message and tool events in protocol order", async () => {
    const chunks = [];
    const usage = await pipeChatCompletionsSseToAnthropic(async (sink) => {
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hi" } }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { content: " there" } }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "toolu_1", type: "function", function: { name: "shell", arguments: '{"cmd":' } }] } }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`);
      sink.write("data: [DONE]\n\n");
      return { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    }, { write: (chunk) => chunks.push(String(chunk)) }, "coding");

    const events = parseSse(chunks.join(""));
    assert.deepEqual(events.map((event) => event.event), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    assert.equal(events[1].data.content_block.type, "text");
    assert.equal(events[2].data.delta.text, "Hi");
    assert.equal(events[5].data.content_block.type, "tool_use");
    assert.equal(events[5].data.content_block.id, "toolu_1");
    assert.equal(events[6].data.delta.partial_json, '{"cmd":"pwd"}');
    assert.equal(events[8].data.delta.stop_reason, "tool_use");
    assert.equal(events[8].data.usage.output_tokens, 2);
    assert.deepEqual(usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });

  it("serializes interleaved parallel tool deltas into valid sequential Anthropic blocks", async () => {
    const chunks = [];
    await pipeChatCompletionsSseToAnthropic(async (sink) => {
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: "toolu_a", function: { name: "read_file", arguments: '{"path":' } },
        { index: 1, id: "toolu_b", function: { name: "read_file", arguments: '{"path":' } },
      ] } }] })}\n\n`);
      sink.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: '"b.js"}' } },
        { index: 0, function: { arguments: '"a.js"}' } },
      ] }, finish_reason: "tool_calls" }] })}\n\n`);
    }, { write: (chunk) => chunks.push(String(chunk)) }, "coding");

    const events = parseSse(chunks.join(""));
    const toolEvents = events.filter((event) => event.event?.startsWith("content_block_"));
    assert.deepEqual(toolEvents.map((event) => event.event), [
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);
    assert.equal(toolEvents[0].data.content_block.id, "toolu_a");
    assert.equal(toolEvents[1].data.delta.partial_json, '{"path":"a.js"}');
    assert.equal(toolEvents[3].data.content_block.id, "toolu_b");
    assert.equal(toolEvents[4].data.delta.partial_json, '{"path":"b.js"}');
  });

  it("estimates positive token counts without routing upstream", () => {
    assert.equal(estimateInputTokens({ messages: [] }), 0);
    assert.ok(estimateInputTokens({
      system: "Be concise",
      messages: [{ role: "user", content: "Hello world" }],
      tools: [{ name: "shell", input_schema: { type: "object" } }],
    }) > 0);
  });

  it("maps HTTP statuses to Anthropic error types", () => {
    assert.equal(toAnthropicError("busy", "Request failed", 429).error.type, "rate_limit_error");
    assert.equal(toAnthropicError("denied", "Request failed", 403).error.type, "permission_error");
    assert.equal(toAnthropicError("missing", "Request failed", 404).error.type, "not_found_error");
  });

  it("preserves native Claude cache and thinking history without serializing private metadata", () => {
    const original = {
      model: "opus-4.8",
      max_tokens: 4096,
      system: [
        { type: "text", text: "System", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Start", cache_control: { type: "ephemeral" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "opaque", signature: "sig" },
            { type: "tool_use", id: "toolu_1", name: "shell", input: { cmd: "pwd" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "/root", cache_control: { type: "ephemeral" } }],
            },
          ],
        },
      ],
      tools: [
        {
          name: "shell",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    const canonical = toChatCompletionsBody(original);
    const serialized = JSON.stringify(canonical);
    assert.doesNotMatch(serialized, /rerouted\.anthropic\.metadata/);
    assert.doesNotMatch(serialized, /cache_control/);
    assert.doesNotMatch(serialized, /"thinking":"opaque"/);

    const upstream = claude.toAnthropicBody(canonical, "claude-opus-4-8", false);
    assert.deepEqual(upstream.system, original.system);
    assert.deepEqual(upstream.tools, original.tools);
    assert.deepEqual(upstream.messages[0].content[0], original.messages[0].content[0]);
    assert.deepEqual(upstream.messages[1].content[0], original.messages[1].content[0]);
    assert.deepEqual(upstream.messages[2].content[0], original.messages[2].content[0]);
  });
});

describe("Anthropic Messages gateway routes", () => {
  async function withGateway(router, run) {
    const gateway = createGateway({
      store: { load: () => ({ apiKey: "rr-test", serverEnabled: true }) },
      router,
    });
    const server = http.createServer((request, response) => gateway.handle(request, response));
    const port = await listen(server);
    try {
      await run(port);
    } finally {
      await close(server);
    }
  }

  it("accepts x-api-key and returns Anthropic JSON from /v1/messages", async () => {
    let received;
    await withGateway({
      chatCompletions: async ({ body }) => {
        received = body;
        return {
          ok: true,
          stream: false,
          openAiJson: {
            id: "chatcmpl-ok",
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          },
        };
      },
    }, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "rr-test", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "opus-4.8",
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply OK" }],
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.type, "message");
      assert.equal(body.model, "opus-4.8");
      assert.equal(body.content[0].text, "OK");
      assert.equal(received.model, "opus-4.8");
      assert.equal(received.messages[0].content, "Reply OK");
    });
  });

  it("tolerates Claude clients that produce /v1/v1/messages", async () => {
    await withGateway({
      chatCompletions: async () => ({
        ok: true,
        stream: false,
        openAiJson: {
          choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        },
      }),
    }, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/v1/messages`, {
        method: "POST",
        headers: { Authorization: "Bearer rr-test", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus-4.8", max_tokens: 8, messages: [] }),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content[0].text, "OK");
    });
  });

  it("returns Anthropic SSE through the real gateway route", async () => {
    await withGateway({
      chatCompletions: async ({ body }) => ({
        ok: true,
        stream: true,
        streamPipe: async (sink) => {
          sink.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "OK" } }] })}\n\n`);
          sink.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\n`);
          sink.write("data: [DONE]\n\n");
          return { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 };
        },
      }),
    }, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "rr-test", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "opus-4.8",
          max_tokens: 8,
          stream: true,
          messages: [{ role: "user", content: "Reply OK" }],
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const events = parseSse(await response.text());
      assert.deepEqual(events.map((event) => event.event), [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      assert.equal(events[2].data.delta.text, "OK");
      assert.equal(events[4].data.delta.stop_reason, "end_turn");
    });
  });

  it("supports count_tokens aliases without invoking the router", async () => {
    await withGateway({
      chatCompletions: async () => assert.fail("count_tokens must not route upstream"),
    }, async (port) => {
      for (const path of ["/v1/messages/count_tokens", "/v1/v1/messages/count_tokens"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { "x-api-key": "rr-test", "Content-Type": "application/json" },
          body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
        });
        assert.equal(response.status, 200);
        assert.ok((await response.json()).input_tokens > 0);
      }
    });
  });

  it("returns Anthropic authentication and model errors", async () => {
    await withGateway({
      chatCompletions: async () => ({
        ok: false,
        status: 404,
        error: {
          error: {
            message: "Model not found: missing",
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
      }),
    }, async (port) => {
      const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "missing", max_tokens: 8, messages: [] }),
      });
      assert.equal(unauthorized.status, 401);
      assert.equal((await unauthorized.json()).error.type, "authentication_error");

      const missing = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": "rr-test", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "missing", max_tokens: 8, messages: [] }),
      });
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.type, "not_found_error");
    });
  });

  it("leaves the existing OpenAI chat-completions path unchanged", async () => {
    await withGateway({
      chatCompletions: async ({ body }) => ({
        ok: true,
        stream: false,
        openAiJson: {
          id: "chatcmpl-existing",
          choices: [{ message: { role: "assistant", content: body.messages[0].content } }],
        },
      }),
    }, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: "Bearer rr-test", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "existing",
          messages: [{ role: "user", content: "unchanged" }],
        }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.id, "chatcmpl-existing");
      assert.equal(body.choices[0].message.content, "unchanged");
    });
  });
});
