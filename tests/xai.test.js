"use strict";

const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { describe, it } = require("node:test");
const xai = require("../src/lib/providers/xai");

function sseResponse(text = "ok") {
  return new Response(
    [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

describe("xAI OAuth Responses transport", () => {
  it("uses the subscription endpoint, identity headers, and virtual model effort", async () => {
    let request;
    const result = await xai.chat(
      { accessToken: "oauth-token" },
      {
        model: "grok-4.5-high",
        body: {
          messages: [
            { role: "system", content: "Be direct." },
            { role: "user", content: "Hello" },
          ],
          stream: false,
        },
        stream: false,
        fetchImpl: async (url, options) => {
          request = { url, options, payload: JSON.parse(options.body) };
          return sseResponse();
        },
      }
    );

    assert.equal(request.url, "https://cli-chat-proxy.grok.com/v1/responses");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.Authorization, "Bearer oauth-token");
    assert.equal(request.options.headers.Accept, "text/event-stream");
    assert.equal(request.options.headers["x-xai-token-auth"], "xai-grok-cli");
    assert.equal(request.options.headers["x-grok-client-identifier"], "grok-shell");
    assert.match(request.options.headers["x-grok-client-version"], /^\d+\.\d+\.\d+$/);
    assert.equal(request.payload.model, "grok-4.5");
    assert.equal(request.payload.stream, true);
    assert.equal(request.payload.store, false);
    assert.deepEqual(
      request.payload.input.map(({ type, role, content }) => ({ type, role, content })),
      [
        { type: "message", role: "system", content: "Be direct." },
        { type: "message", role: "user", content: "Hello" },
      ]
    );
    assert.deepEqual(request.payload.reasoning, { effort: "high", summary: "concise" });
    assert.ok(request.payload.include.includes("reasoning.encrypted_content"));
    assert.equal(result.translate, "responses");
    assert.equal(result.clientStream, false);
    assert.equal(result.model, "grok-4.5-high");
  });

  it("prioritizes explicit client effort and preserves Composer behavior", () => {
    for (const effort of ["high", "medium", "low"]) {
      const virtual = xai.toResponsesBody(
        { messages: [{ role: "user", content: "Hello" }] },
        `grok-4.5-${effort}`
      );
      assert.equal(virtual.model, "grok-4.5");
      assert.equal(virtual.reasoning.effort, effort);
    }
    assert.deepEqual(xai.resolveModel("grok-next-high"), {
      requested: "grok-next-high",
      upstream: "grok-next-high",
      modelEffort: null,
    });

    const explicit = xai.toResponsesBody(
      {
        messages: [{ role: "user", content: "Hello" }],
        reasoning: { effort: "medium", summary: "detailed" },
      },
      "grok-4.5-high"
    );
    assert.equal(explicit.model, "grok-4.5");
    assert.deepEqual(explicit.reasoning, { effort: "medium", summary: "detailed" });

    const normalized = {
      minimal: "low",
      none: "low",
      auto: "high",
      xhigh: "high",
      max: "high",
    };
    for (const [requested, expected] of Object.entries(normalized)) {
      const payload = xai.toResponsesBody(
        {
          messages: [{ role: "user", content: "Hello" }],
          reasoning_effort: requested,
        },
        "grok-4.5"
      );
      assert.equal(payload.reasoning.effort, expected);
    }

    const composer = xai.toResponsesBody(
      {
        messages: [{ role: "user", content: "Hello" }],
        reasoning_effort: "high",
        include: ["reasoning.encrypted_content"],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look something up",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      "grok-composer-2.5-fast"
    );
    assert.equal(composer.reasoning, undefined);
    assert.equal(composer.include, undefined);
    assert.deepEqual(composer.tools[0], {
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: {} },
    });
  });

  it("persists refreshed tokens before retrying a rejected request", async () => {
    const provider = { accessToken: "stale", refreshToken: "refresh-old" };
    const calls = [];
    let persisted;
    const result = await xai.chat(provider, {
      model: "grok-4.5-low",
      body: { messages: [{ role: "user", content: "Hello" }] },
      fetchImpl: async (url, options) => {
        calls.push({ url, authorization: options.headers?.Authorization });
        if (url === xai.cfg.tokenUrl) {
          return new Response(
            JSON.stringify({ access_token: "fresh", refresh_token: "refresh-new", expires_in: 90 }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (options.headers.Authorization === "Bearer stale") return new Response("", { status: 401 });
        assert.equal(persisted?.accessToken, "fresh");
        return sseResponse("refreshed");
      },
      onTokenRefresh: async (tokens) => {
        persisted = { ...tokens };
      },
    });

    assert.equal(result.response.status, 200);
    assert.equal(calls.filter((call) => call.url === xai.cfg.chatUrl).length, 2);
    assert.equal(calls.at(-1).authorization, "Bearer fresh");
    assert.equal(persisted.accessToken, "fresh");
    assert.equal(persisted.refreshToken, "refresh-new");
    assert.equal(provider.accessToken, "fresh");
  });

  it("does not mutate credentials or retry when refreshed tokens cannot be persisted", async () => {
    const provider = { accessToken: "stale", refreshToken: "refresh-old" };
    let inferenceCalls = 0;
    await assert.rejects(
      xai.chat(provider, {
        model: "grok-4.5",
        body: { messages: [{ role: "user", content: "Hello" }] },
        fetchImpl: async (url) => {
          if (url === xai.cfg.tokenUrl) {
            return new Response(JSON.stringify({ access_token: "fresh", expires_in: 90 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          inferenceCalls += 1;
          return new Response("", { status: 401 });
        },
        onTokenRefresh: async () => {
          throw new Error("persistence failed");
        },
      }),
      /persistence failed/
    );
    assert.equal(inferenceCalls, 1);
    assert.equal(provider.accessToken, "stale");
    assert.equal(provider.refreshToken, "refresh-old");
  });

  it("collects non-stream output and relays streaming output and errors", async () => {
    const events = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Private planning"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ];
    const collected = await xai.pipeResponsesSse(Readable.from(events), null, "grok-4.5", {
      collect: true,
    });
    assert.equal(collected.object, "chat.completion");
    assert.equal(collected.choices[0].message.content, "Hello");

    const chunks = [];
    await xai.pipeResponsesSse(
      Readable.from(events),
      { write(chunk) { chunks.push(chunk); } },
      "grok-4.5"
    );
    const output = chunks.join("");
    assert.match(output, /chat\.completion\.chunk/);
    assert.match(output, /\[DONE\]/);
    assert.doesNotMatch(output, /Private planning/);

    await assert.rejects(
      xai.pipeResponsesSse(
        Readable.from([
          'event: error\ndata: {"type":"error","error":{"type":"usage_limit_reached","message":"Real upstream quota message"}}\n\n',
        ]),
        null,
        "grok-4.5",
        { collect: true }
      ),
      /Real upstream quota message/
    );
    await assert.rejects(
      xai.pipeResponsesSse(
        Readable.from([
          'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"invalid_model","message":"Exact provider failure"}}}\n\n',
        ]),
        null,
        "grok-4.5",
        { collect: true }
      ),
      /Exact provider failure/
    );
  });

  it("normalizes Responses function calls for collected and streaming clients", async () => {
    const events = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"q\\":\\"gro"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"k\\"}"}\n\n',
      'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","output_index":0,"item_id":"fc_1","arguments":"{\\"q\\":\\"grok\\"}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}\n\n',
    ];

    const collected = await xai.pipeResponsesSse(Readable.from(events), null, "grok-4.5", {
      collect: true,
    });
    assert.equal(collected.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(collected.choices[0].message.tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: '{"q":"grok"}' },
      },
    ]);
    assert.deepEqual(collected.usage, {
      prompt_tokens: 8,
      completion_tokens: 3,
      total_tokens: 11,
    });

    const chunks = [];
    await xai.pipeResponsesSse(
      Readable.from(events),
      { write(chunk) { chunks.push(chunk); } },
      "grok-4.5"
    );
    const output = chunks.join("");
    assert.match(output, /"tool_calls"/);
    assert.match(output, /"finish_reason":"tool_calls"/);
    const payloads = output
      .split("\n")
      .filter((line) => line.startsWith("data: {") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)));
    const deltas = payloads.map((payload) => payload.choices[0].delta);
    const streamedArguments = deltas
      .flatMap((delta) => delta.tool_calls || [])
      .map((call) => call.function?.arguments || "")
      .join("");
    assert.equal(streamedArguments, '{"q":"grok"}');
    assert.ok(deltas.every((delta) => !delta.content?.includes('"q"')));
  });
});
