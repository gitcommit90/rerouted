"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");
const chatgpt = require("../src/lib/providers/chatgpt");

function parseSseWrites(writes) {
  return writes
    .join("")
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice(6)));
}

describe("ChatGPT Responses tool translation", () => {
  it("sends Chat Completions tools and tool choice to the Codex Responses endpoint", async () => {
    let request;
    const result = await chatgpt.chat(
      { accessToken: "oauth-token", accountId: "account-1" },
      {
        model: "gpt-5.6-sol",
        body: {
          messages: [{ role: "user", content: "What is the weather?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "Get the current weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"],
                },
                strict: true,
              },
            },
          ],
          tool_choice: { type: "function", function: { name: "get_weather" } },
          parallel_tool_calls: false,
        },
        stream: false,
        fetchImpl: async (url, options) => {
          request = { url, options, payload: JSON.parse(options.body) };
          return new Response("", { status: 200 });
        },
      }
    );

    assert.equal(request.url, chatgpt.cfg.chatUrl);
    assert.equal(request.options.headers["chatgpt-account-id"], "account-1");
    assert.deepEqual(request.payload.tools, [
      {
        type: "function",
        name: "get_weather",
        description: "Get the current weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
        strict: true,
      },
    ]);
    assert.deepEqual(request.payload.tool_choice, { type: "function", name: "get_weather" });
    assert.equal(request.payload.parallel_tool_calls, false);
    assert.deepEqual(request.payload.include, ["reasoning.encrypted_content"]);
    assert.equal(result.translate, "responses");
    assert.equal(typeof result.reasoningScope, "string");
  });

  it("preserves captured additional_tools custom grammar and replays custom output", () => {
    const additionalTools = [
      { type: "custom", name: "exec", description: "Runs a shell command and returns its output.", format: { type: "grammar", syntax: "lark", definition: "start: command\ncommand: /(.|\\n)+/" } },
      { type: "namespace", name: "container", description: "Container tools", tools: [{ type: "custom", name: "exec", format: { type: "grammar", syntax: "regex", definition: "(?s).+" } }] },
    ];
    const first = chatgpt.toResponsesBody({ messages: [{ role: "user", content: "List files" }], tools: additionalTools }, "gpt-5.6-sol", false);
    assert.deepEqual(first.tools, additionalTools);
    const output = [
      { type: "input_text", text: "Script completed..." },
      { type: "input_text", text: "{...TOOL_EXEC_OK...}" },
    ];
    const second = chatgpt.toResponsesBody({ messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_capture", type: "custom", custom: { name: "exec", input: "ls" } }] },
      { role: "tool", tool_call_id: "call_capture", content: output, extra_content: { openai: { custom_tool_call_output: true } } },
    ], tools: additionalTools }, "gpt-5.6-sol", false);
    assert.deepEqual(second.input, [
      { type: "custom_tool_call", call_id: "call_capture", name: "exec", input: "ls" },
      { type: "custom_tool_call_output", call_id: "call_capture", output },
    ]);
    assert.deepEqual(second.tools, additionalTools);
  });

  it("collects custom tool events without converting them to function calls", async () => {
    const events = [
      { type: "response.output_item.added", output_index: 1, item: { id: "ctc_1", type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "" } },
      { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 1, delta: "pw" },
      { type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 1, input: "pwd" },
      { type: "response.output_item.done", output_index: 1, item: { id: "ctc_1", type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "pwd" } },
      { type: "response.completed" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const result = await chatgpt.pipeResponsesSse(Readable.from(events), null, "gpt-5.6-sol", { collect: true });
    assert.deepEqual(result.choices[0].message.tool_calls, [{ id: "call_exec", type: "custom", custom: { name: "exec", input: "pwd" } }]);
  });

  it("preserves assistant tool calls and tool results in multi-turn input", () => {
    const payload = chatgpt.toResponsesBody(
      {
        messages: [
          { role: "system", content: "Use tools when needed." },
          { role: "user", content: "Weather in Oslo and Rome?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_oslo",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Oslo"}' },
              },
              {
                id: "call_rome",
                type: "function",
                function: { name: "get_weather", arguments: { city: "Rome" } },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_oslo", content: "8 C" },
          {
            role: "tool",
            tool_call_id: "call_rome",
            content: [{ type: "text", text: "25 C" }],
          },
        ],
      },
      "gpt-5.6-sol",
      false
    );

    assert.equal(payload.instructions, "Use tools when needed.");
    assert.deepEqual(payload.input, [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Weather in Oslo and Rome?" }],
      },
      {
        type: "function_call",
        call_id: "call_oslo",
        name: "get_weather",
        arguments: '{"city":"Oslo"}',
      },
      {
        type: "function_call",
        call_id: "call_rome",
        name: "get_weather",
        arguments: '{"city":"Rome"}',
      },
      {
        type: "function_call_output",
        call_id: "call_oslo",
        output: "8 C",
      },
      {
        type: "function_call_output",
        call_id: "call_rome",
        output: "25 C",
      },
    ]);
  });

  it("keeps Responses-style tools and all tool-choice modes compatible", () => {
    const tool = {
      type: "function",
      name: "lookup",
      parameters: { type: "object", properties: {} },
    };
    for (const choice of ["auto", "none", "required"]) {
      const payload = chatgpt.toResponsesBody(
        { messages: [{ role: "user", content: "Hello" }], tools: [tool], tool_choice: choice },
        "gpt-5.6-sol",
        false
      );
      assert.deepEqual(payload.tools, [tool]);
      assert.equal(payload.tool_choice, choice);
    }

    const named = chatgpt.toResponsesBody(
      {
        messages: [{ role: "user", content: "Hello" }],
        tools: [tool],
        tool_choice: { type: "function", name: "lookup" },
      },
      "gpt-5.6-sol",
      false
    );
    assert.deepEqual(named.tool_choice, { type: "function", name: "lookup" });
  });

  it("replays streamed encrypted reasoning before a matching function call and output", async () => {
    const events = [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_streamed",
          type: "reasoning",
          status: "completed",
          summary: [],
          content: [],
          encrypted_content: "encrypted-streamed-reasoning",
          decrypted_content: "must-never-be-returned",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "fc_streamed",
          type: "function_call",
          call_id: "call_streamed",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.done",
        item_id: "fc_streamed",
        output_index: 1,
        arguments: '{"city":"Oslo"}',
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_streamed",
          type: "function_call",
          call_id: "call_streamed",
          name: "get_weather",
          arguments: '{"city":"Oslo"}',
        },
      },
      { type: "response.completed" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const first = await chatgpt.pipeResponsesSse(
      Readable.from(events),
      null,
      "gpt-5.6-sol",
      { collect: true, reasoningScope: "provider-a" }
    );
    assert.deepEqual(
      first.choices[0].message.tool_calls[0].extra_content.openai.reasoning_items,
      [
        {
          type: "reasoning",
          id: "rs_streamed",
          status: "completed",
          summary: [],
          content: [],
          encrypted_content: "encrypted-streamed-reasoning",
        },
      ]
    );
    assert.doesNotMatch(JSON.stringify(first), /must-never-be-returned/);

    const next = chatgpt.toResponsesBody(
      {
        messages: [
          { role: "user", content: "Weather in Oslo?" },
          first.choices[0].message,
          { role: "tool", tool_call_id: "call_streamed", content: "8 C" },
        ],
      },
      "gpt-5.6-sol",
      false,
      { reasoningScope: "provider-b" }
    );

    assert.deepEqual(next.input.slice(1), [
      {
        id: "rs_streamed",
        type: "reasoning",
        status: "completed",
        summary: [],
        content: [],
        encrypted_content: "encrypted-streamed-reasoning",
      },
      {
        type: "function_call",
        call_id: "call_streamed",
        name: "get_weather",
        arguments: '{"city":"Oslo"}',
      },
      {
        type: "function_call_output",
        call_id: "call_streamed",
        output: "8 C",
      },
    ]);
  });

  it("replays encrypted reasoning collected from JSON responses", () => {
    const first = chatgpt.fromResponsesJson(
      {
        output: [
          {
            id: "rs_json",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-json-reasoning",
          },
          {
            id: "fc_json",
            type: "function_call",
            call_id: "call_json",
            name: "lookup",
            arguments: '{"id":42}',
          },
        ],
      },
      "gpt-5.6-sol"
    );
    assert.equal(
      first.choices[0].message.tool_calls[0].extra_content.openai.reasoning_items[0]
        .encrypted_content,
      "encrypted-json-reasoning"
    );
    const next = chatgpt.toResponsesBody(
      {
        messages: [
          { role: "user", content: "Look up 42" },
          first.choices[0].message,
          { role: "tool", tool_call_id: "call_json", content: "found" },
        ],
      },
      "gpt-5.6-sol",
      false
    );

    assert.deepEqual(
      next.input.slice(1).map((item) => item.type),
      ["reasoning", "function_call", "function_call_output"]
    );
    assert.equal(next.input[1].encrypted_content, "encrypted-json-reasoning");
  });

  it("keeps structured reasoning out of visible JSON and streaming content", async () => {
    const json = chatgpt.fromResponsesJson(
      {
        output: [
          {
            id: "rs_hidden",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Private planning" }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Visible answer" }],
          },
        ],
      },
      "gpt-5.6-sol"
    );
    assert.equal(json.choices[0].message.content, "Visible answer");

    const events = [
      {
        type: "response.reasoning_summary_text.delta",
        delta: "Private streamed planning",
      },
      { type: "response.output_text.delta", delta: "Visible streamed answer" },
      { type: "response.completed" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`);

    const collected = await chatgpt.pipeResponsesSse(
      Readable.from(events),
      null,
      "gpt-5.6-sol",
      { collect: true }
    );
    assert.equal(collected.choices[0].message.content, "Visible streamed answer");

    const writes = [];
    await chatgpt.pipeResponsesSse(
      Readable.from(events),
      { write(chunk) { writes.push(chunk); } },
      "gpt-5.6-sol"
    );
    const visibleContent = parseSseWrites(writes)
      .map((chunk) => chunk.choices[0].delta.content || "")
      .join("");
    assert.equal(visibleContent, "Visible streamed answer");
    assert.doesNotMatch(writes.join(""), /Private streamed planning/);
  });

  it("replays multiple reasoning phases once in their original call order", () => {
    const first = chatgpt.fromResponsesJson(
      {
        output: [
          {
            id: "rs_multi_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-multi-1",
          },
          {
            type: "function_call",
            call_id: "call_multi_1",
            name: "lookup",
            arguments: '{"id":1}',
          },
          {
            id: "rs_multi_2",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-multi-2",
          },
          {
            type: "function_call",
            call_id: "call_multi_2",
            name: "lookup",
            arguments: '{"id":2}',
          },
        ],
      },
      "gpt-5.6-sol-multi"
    );
    const returnedCalls = first.choices[0].message.tool_calls;
    assert.deepEqual(
      returnedCalls.map((call) =>
        call.extra_content.openai.reasoning_items.map((item) => item.id)
      ),
      [["rs_multi_1"], ["rs_multi_1", "rs_multi_2"]]
    );
    const next = chatgpt.toResponsesBody(
      {
        messages: [
          first.choices[0].message,
          { role: "tool", tool_call_id: "call_multi_1", content: "one" },
          { role: "tool", tool_call_id: "call_multi_2", content: "two" },
        ],
      },
      "gpt-5.6-sol-multi",
      false
    );

    assert.deepEqual(
      next.input.map((item) => item.type),
      [
        "reasoning",
        "function_call",
        "reasoning",
        "function_call",
        "function_call_output",
        "function_call_output",
      ]
    );
    assert.deepEqual(
      next.input.filter((item) => item.type === "reasoning").map((item) => item.id),
      ["rs_multi_1", "rs_multi_2"]
    );
  });

  it("expires cached reasoning instead of retaining it indefinitely", () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const first = chatgpt.fromResponsesJson(
        {
          output: [
            {
              id: "rs_expiring",
              type: "reasoning",
              summary: [],
              encrypted_content: "encrypted-expiring-reasoning",
            },
            {
              type: "function_call",
              call_id: "call_expiring",
              name: "lookup",
              arguments: "{}",
            },
          ],
        },
        "gpt-5.6-sol"
      );
      delete first.choices[0].message.tool_calls[0].extra_content;
      now += 31 * 60 * 1000;
      const next = chatgpt.toResponsesBody(
        {
          messages: [
            first.choices[0].message,
            { role: "tool", tool_call_id: "call_expiring", content: "done" },
          ],
        },
        "gpt-5.6-sol",
        false
      );
      assert.deepEqual(
        next.input.map((item) => item.type),
        ["function_call", "function_call_output"]
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("evicts old reasoning when the bounded cache reaches its entry limit", () => {
    let first;
    let last;
    for (let index = 0; index <= 256; index += 1) {
      const converted = chatgpt.fromResponsesJson(
        {
          output: [
            {
              id: `rs_bounded_${index}`,
              type: "reasoning",
              summary: [],
              encrypted_content: `encrypted-bounded-${index}`,
            },
            {
              type: "function_call",
              call_id: `call_bounded_${index}`,
              name: "lookup",
              arguments: "{}",
            },
          ],
        },
        "gpt-5.6-sol-bounded"
      );
      delete converted.choices[0].message.tool_calls[0].extra_content;
      if (index === 0) first = converted.choices[0].message;
      if (index === 256) last = converted.choices[0].message;
    }

    const oldest = chatgpt.toResponsesBody(
      { messages: [first] },
      "gpt-5.6-sol-bounded",
      false
    );
    const newest = chatgpt.toResponsesBody(
      { messages: [last] },
      "gpt-5.6-sol-bounded",
      false
    );
    assert.deepEqual(oldest.input.map((item) => item.type), ["function_call"]);
    assert.deepEqual(newest.input.map((item) => item.type), ["reasoning", "function_call"]);
  });

  it("replays an echoed extension without relying on any in-process cache", () => {
    const payload = chatgpt.toResponsesBody(
      {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_extension_only_never_cached",
                type: "function",
                function: { name: "lookup", arguments: '{"id":7}' },
                extra_content: {
                  openai: {
                    reasoning_items: [
                      {
                        id: "rs_extension_only",
                        type: "reasoning",
                        summary: [],
                        encrypted_content: "encrypted-extension-only",
                      },
                    ],
                  },
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_extension_only_never_cached", content: "seven" },
        ],
      },
      "gpt-5.6-sol",
      false,
      { reasoningScope: "fresh-process-scope" }
    );

    assert.deepEqual(payload.input.map((item) => item.type), [
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    assert.equal(payload.input[0].encrypted_content, "encrypted-extension-only");
  });

  it("prefers an echoed reasoning extension over a conflicting scoped cache entry", () => {
    const first = chatgpt.fromResponsesJson(
      {
        output: [
          {
            id: "rs_cached_preference",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-cache-value",
          },
          {
            type: "function_call",
            call_id: "call_preference",
            name: "lookup",
            arguments: "{}",
          },
        ],
      },
      "gpt-5.6-sol",
      { reasoningScope: "preference-scope" }
    );
    first.choices[0].message.tool_calls[0].extra_content.openai.reasoning_items = [
      {
        id: "rs_echoed_preference",
        type: "reasoning",
        summary: [],
        encrypted_content: "encrypted-echoed-value",
      },
    ];

    const payload = chatgpt.toResponsesBody(
      { messages: [first.choices[0].message] },
      "gpt-5.6-sol",
      false,
      { reasoningScope: "preference-scope" }
    );
    assert.equal(payload.input[0].id, "rs_echoed_preference");
    assert.equal(payload.input[0].encrypted_content, "encrypted-echoed-value");
  });

  it("keeps cache fallback isolated to the originating provider scope", () => {
    const first = chatgpt.fromResponsesJson(
      {
        output: [
          {
            id: "rs_scoped_cache",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-scoped-cache",
          },
          {
            type: "function_call",
            call_id: "call_scoped_cache",
            name: "lookup",
            arguments: "{}",
          },
        ],
      },
      "gpt-5.6-sol",
      { reasoningScope: "provider-scope-a" }
    );
    delete first.choices[0].message.tool_calls[0].extra_content;

    const wrongProvider = chatgpt.toResponsesBody(
      { messages: [first.choices[0].message] },
      "gpt-5.6-sol",
      false,
      { reasoningScope: "provider-scope-b" }
    );
    const sameProvider = chatgpt.toResponsesBody(
      { messages: [first.choices[0].message] },
      "gpt-5.6-sol",
      false,
      { reasoningScope: "provider-scope-a" }
    );

    assert.deepEqual(wrongProvider.input.map((item) => item.type), ["function_call"]);
    assert.deepEqual(sameProvider.input.map((item) => item.type), [
      "reasoning",
      "function_call",
    ]);
  });

  it("emits a final streaming tool-call delta with the durable reasoning extension", async () => {
    const events = [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_stream_extension",
          type: "reasoning",
          summary: [],
          encrypted_content: "encrypted-stream-extension",
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "fc_stream_extension",
          type: "function_call",
          call_id: "call_stream_extension",
          name: "lookup",
          arguments: "",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          id: "fc_stream_extension",
          type: "function_call",
          call_id: "call_stream_extension",
          name: "lookup",
          arguments: "{}",
        },
      },
      { type: "response.completed" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
    const writes = [];
    await chatgpt.pipeResponsesSse(
      Readable.from(events),
      { write(chunk) { writes.push(chunk); } },
      "gpt-5.6-sol",
      { collect: false, reasoningScope: "stream-provider" }
    );

    const chunks = parseSseWrites(writes);
    const extensionIndex = chunks.findIndex((chunk) =>
      chunk.choices[0].delta.tool_calls?.some((call) => call.extra_content?.openai)
    );
    const finishIndex = chunks.findIndex(
      (chunk) => chunk.choices[0].finish_reason === "tool_calls"
    );
    assert.ok(extensionIndex >= 0);
    assert.ok(extensionIndex < finishIndex);
    assert.deepEqual(chunks[extensionIndex].choices[0].delta.tool_calls, [
      {
        index: 0,
        id: "call_stream_extension",
        extra_content: {
          openai: {
            reasoning_items: [
              {
                type: "reasoning",
                id: "rs_stream_extension",
                summary: [],
                encrypted_content: "encrypted-stream-extension",
              },
            ],
          },
        },
      },
    ]);
    assert.ok(writes.join("").includes("data: [DONE]"));
  });
});
