"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");
const antigravity = require("../src/lib/providers/antigravity");

function weatherTool() {
  return {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          days: { type: "array" },
        },
        required: ["city"],
        additionalProperties: false,
      },
    },
  };
}

function parseSseWrites(writes) {
  return writes
    .join("")
    .split("\n\n")
    .filter((block) => block.startsWith("data: ") && block !== "data: [DONE]")
    .map((block) => JSON.parse(block.slice(6)));
}

describe("Antigravity tool calling", () => {
  it("maps OpenAI tools and tool choices to Gemini's JSON Schema request fields", () => {
    const forced = antigravity.toGeminiBody(
      {
        messages: [{ role: "user", content: "Weather in Paris?" }],
        tools: [weatherTool()],
        tool_choice: { type: "function", function: { name: "get_weather" } },
      },
      "gemini-3-flash-agent"
    );

    assert.deepEqual(forced.request.tools, [
      {
        functionDeclarations: [
          {
            name: "get_weather",
            description: "Get current weather",
            parametersJsonSchema: {
              type: "object",
              properties: {
                city: { type: "string" },
                days: { type: "array" },
              },
              required: ["city"],
              additionalProperties: false,
            },
          },
        ],
      },
    ]);
    assert.deepEqual(forced.request.toolConfig, {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather"] },
    });

    for (const [choice, mode] of [
      ["auto", "AUTO"],
      ["required", "ANY"],
      ["none", "NONE"],
    ]) {
      const body = antigravity.toGeminiBody(
        { messages: [{ role: "user", content: "test" }], tools: [weatherTool()], tool_choice: choice },
        "gemini-3-flash-agent"
      );
      assert.equal(body.request.toolConfig.functionCallingConfig.mode, mode);
    }
  });

  it("preserves JSON Schema refs and nullable unions without lossy conversion", () => {
    const parameters = {
      type: "object",
      properties: {
        location: { $ref: "#/$defs/location" },
        units: { type: ["string", "null"], enum: ["celsius", "fahrenheit", null] },
      },
      $defs: {
        location: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    };
    const body = antigravity.toGeminiBody(
      {
        messages: [{ role: "user", content: "Weather?" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", description: "Get weather", parameters },
          },
        ],
      },
      "gemini-3-flash-agent"
    );

    assert.deepEqual(
      body.request.tools[0].functionDeclarations[0].parametersJsonSchema,
      parameters
    );
    assert.equal(body.request.tools[0].functionDeclarations[0].parameters, undefined);
  });

  it("round-trips Gemini function calls and OpenAI tool results with thought signatures", () => {
    const upstream = {
      responseId: "response-1",
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { city: "Paris" },
                },
                thoughtSignature: "signed-reasoning-state",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const completion = antigravity.fromGeminiJson(upstream, "gemini-3-flash-agent");
    assert.equal(completion.id, "response-1");
    assert.equal(completion.choices[0].finish_reason, "tool_calls");
    const toolCall = completion.choices[0].message.tool_calls[0];
    assert.match(toolCall.id, /^call_[0-9a-f]{32}$/);
    assert.deepEqual(completion.choices[0].message, {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: toolCall.id,
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          extra_content: {
            google: { thought_signature: "signed-reasoning-state" },
          },
        },
      ],
    });

    const followUp = antigravity.toGeminiBody(
      {
        messages: [
          { role: "user", content: "Weather in Paris?" },
          completion.choices[0].message,
          { role: "tool", tool_call_id: toolCall.id, content: '{"temperature":21}' },
        ],
        tools: [weatherTool()],
      },
      "gemini-3-flash-agent"
    );

    assert.deepEqual(followUp.request.contents.slice(1), [
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: toolCall.id,
              name: "get_weather",
              args: { city: "Paris" },
            },
            thoughtSignature: "signed-reasoning-state",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: toolCall.id,
              name: "get_weather",
              response: { temperature: 21 },
            },
          },
        ],
      },
    ]);
  });

  it("preserves parallel signatures and IDs on calls and matching responses", () => {
    const body = antigravity.toGeminiBody(
      {
        messages: [
          { role: "user", content: "Weather in Paris and London?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_paris",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                extra_content: { google: { thought_signature: "parallel-signature" } },
              },
              {
                id: "call_london",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"London"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_paris", content: '{"temperature":21}' },
          { role: "tool", tool_call_id: "call_london", content: '{"temperature":18}' },
        ],
      },
      "gemini-3-flash-agent"
    );

    assert.deepEqual(body.request.contents.slice(1), [
      {
        role: "model",
        parts: [
          {
            functionCall: {
              id: "call_paris",
              name: "get_weather",
              args: { city: "Paris" },
            },
            thoughtSignature: "parallel-signature",
          },
          {
            functionCall: {
              id: "call_london",
              name: "get_weather",
              args: { city: "London" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_paris",
              name: "get_weather",
              response: { temperature: 21 },
            },
          },
          {
            functionResponse: {
              id: "call_london",
              name: "get_weather",
              response: { temperature: 18 },
            },
          },
        ],
      },
    ]);
  });

  it("uses Gemini's signature bypass only on the first fabricated parallel call", () => {
    const body = antigravity.toGeminiBody(
      {
        messages: [
          { role: "user", content: "Call it" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Paris"}' },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"London"}' },
              },
            ],
          },
        ],
      },
      "gemini-3-flash-agent"
    );

    assert.equal(
      body.request.contents[1].parts[0].thoughtSignature,
      "skip_thought_signature_validator"
    );
    assert.equal(body.request.contents[1].parts[1].thoughtSignature, undefined);
  });

  it("deduplicates cumulative Gemini SSE text and buffers the final signed tool call", async () => {
    const events = [
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Hel" },
                  {
                    functionCall: {
                      id: "call_stream",
                      name: "get_weather",
                      args: { city: "Par" },
                    },
                  },
                ],
              },
            },
          ],
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Hello" },
                  {
                    functionCall: {
                      id: "call_stream",
                      name: "get_weather",
                      args: { city: "Paris" },
                    },
                    thoughtSignature: "stream-signature",
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        },
      })}\n\n`,
    ];
    const writes = [];
    await antigravity.pipeGeminiSse(
      Readable.from(events),
      { write(chunk) { writes.push(chunk); } },
      "gemini-3-flash-agent"
    );

    const chunks = parseSseWrites(writes);
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(
      chunks
        .map((chunk) => chunk.choices[0].delta.content)
        .filter((content) => content)
        .join(""),
      "Hello"
    );
    const toolChunks = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls);
    assert.equal(toolChunks.length, 1);
    assert.deepEqual(toolChunks[0].choices[0].delta.tool_calls, [
      {
        index: 0,
        id: "call_stream",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        extra_content: {
          google: {
            thought_signature: "stream-signature",
            function_call_id: "call_stream",
          },
        },
      },
    ]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    assert.ok(writes.join("").includes("data: [DONE]"));
  });

  it("keeps anonymous parallel calls from separate SSE events in stable slots", async () => {
    const callA = { functionCall: { name: "call_a", args: { value: "a" } } };
    const callB = { functionCall: { name: "call_b", args: { value: "b" } } };
    const events = [
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [callA] } }] } })}\n\n`,
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [callB] } }] } })}\n\n`,
      `data: ${JSON.stringify({
        response: {
          candidates: [
            {
              content: { parts: [callA, callB] },
              finishReason: "STOP",
            },
          ],
        },
      })}\n\n`,
    ];
    const writes = [];
    await antigravity.pipeGeminiSse(
      Readable.from(events),
      { write(chunk) { writes.push(chunk); } },
      "gemini-3-flash-agent"
    );

    const chunks = parseSseWrites(writes);
    const toolCalls = chunks.flatMap(
      (chunk) => chunk.choices[0].delta.tool_calls || []
    );
    assert.equal(toolCalls.length, 2);
    assert.deepEqual(
      toolCalls.map((call) => ({
        index: call.index,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      [
        { index: 0, name: "call_a", arguments: '{"value":"a"}' },
        { index: 1, name: "call_b", arguments: '{"value":"b"}' },
      ]
    );
    assert.notEqual(toolCalls[0].id, toolCalls[1].id);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  });
});
