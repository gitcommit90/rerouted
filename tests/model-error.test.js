"use strict";

const assert = require("node:assert/strict");
const { it } = require("node:test");
const openaiCompat = require("../src/lib/providers/openai-compat");
const {
  bodyHasUpstreamError,
  inspectModelTestResponse,
  runProviderModelTest,
} = require("../src/lib/model-test");

it("preserves the full provider model-test response", async () => {
  const tail = "TAIL-MUST-REMAIN";
  const body = `${"x".repeat(500)}${tail}`;
  await assert.rejects(
    () =>
      openaiCompat.listModels(
        { baseUrl: "https://example.test/v1", apiKey: "key" },
        {
          fetchImpl: async () => ({
            ok: false,
            status: 400,
            text: async () => body,
          }),
        }
      ),
    (error) => {
      assert.match(error.message, new RegExp(tail));
      return true;
    }
  );
});

it("rejects an HTTP-200 JSON model-test error without truncating it", async () => {
  const tail = "JSON-TAIL-MUST-REMAIN";
  const body = JSON.stringify({ error: { code: "bad_model", message: `${"x".repeat(600)}${tail}` } });
  const inspected = await inspectModelTestResponse(new Response(body, { status: 200 }));

  assert.equal(inspected.ok, false);
  assert.equal(inspected.status, 200);
  assert.equal(inspected.body, body);
  assert.match(inspected.body, new RegExp(tail));
});

it("rejects an HTTP-200 SSE model-test error after metadata", async () => {
  const tail = "SSE-TAIL-MUST-REMAIN";
  const body = [
    'event: response.created\ndata: {"type":"response.created"}',
    `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: `${"y".repeat(600)}${tail}` },
    })}`,
    "",
  ].join("\n\n");
  const inspected = await inspectModelTestResponse(
    new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  );

  assert.equal(inspected.ok, false);
  assert.equal(inspected.body, body);
  assert.match(inspected.body, new RegExp(tail));
});

it("accepts successful JSON and SSE model-test responses", async () => {
  const json = await inspectModelTestResponse(
    new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
  );
  const sseBody = [
    'event: response.created\ndata: {"type":"response.created"}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}',
    'event: response.completed\ndata: {"type":"response.completed"}',
    "",
  ].join("\n\n");
  const sse = await inspectModelTestResponse(new Response(sseBody, { status: 200 }));

  assert.equal(json.ok, true);
  assert.equal(sse.ok, true);
  assert.equal(bodyHasUpstreamError(sseBody), false);
});

it("preserves full non-OK model-test bodies", async () => {
  const tail = "HTTP-TAIL-MUST-REMAIN";
  const body = `${"z".repeat(600)}${tail}`;
  const inspected = await inspectModelTestResponse(new Response(body, { status: 400 }));

  assert.equal(inspected.ok, false);
  assert.equal(inspected.status, 400);
  assert.equal(inspected.body, body);
});

it("logs thrown adapter model-test failures with the full message", async () => {
  const tail = "THROWN-TAIL-MUST-REMAIN";
  const message = `${"q".repeat(600)}${tail}`;
  const entries = [];
  const error = new Error(message);
  error.status = 401;
  const result = await runProviderModelTest({
    adapter: { chat: async () => { throw error; } },
    provider: { type: "chatgpt", name: "ChatGPT" },
    model: "gpt-test",
    logger: { error: (msg, meta) => entries.push({ msg, meta }) },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, new RegExp(tail));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].meta.status, 401);
  assert.equal(entries[0].meta.body, message);
});
