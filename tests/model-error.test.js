"use strict";

const assert = require("node:assert/strict");
const { it } = require("node:test");
const openaiCompat = require("../src/lib/providers/openai-compat");
const {
  MAX_ERROR_BODY_LENGTH,
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

it("rejects an HTTP-200 JSON model-test error with a bounded response", async () => {
  const tail = "JSON-TAIL-MUST-REMAIN";
  const body = JSON.stringify({
    error: { code: "bad_model", message: `${"x".repeat(MAX_ERROR_BODY_LENGTH + 600)}${tail}` },
  });
  const inspected = await inspectModelTestResponse(new Response(body, { status: 200 }));

  assert.equal(inspected.ok, false);
  assert.equal(inspected.status, 200);
  assert.ok(inspected.body.length < body.length);
  assert.match(inspected.body, /\[truncated \d+ chars\]/);
  assert.doesNotMatch(inspected.body, new RegExp(tail));
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

it("bounds and redacts non-OK model-test bodies", async () => {
  const secret = "model-test-secret-token";
  const body = `Authorization: Bearer ${secret}\n${"z".repeat(MAX_ERROR_BODY_LENGTH + 600)}`;
  const inspected = await inspectModelTestResponse(new Response(body, { status: 400 }));

  assert.equal(inspected.ok, false);
  assert.equal(inspected.status, 400);
  assert.equal(inspected.body.includes(secret), false);
  assert.match(inspected.body, /Authorization: \[REDACTED\]/);
  assert.match(inspected.body, /\[truncated \d+ chars\]/);
});

it("bounds and redacts thrown adapter model-test failures", async () => {
  const secret = "adapter-secret-token";
  const message = `api_key=${secret} ${"q".repeat(MAX_ERROR_BODY_LENGTH + 600)}`;
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
  assert.equal(result.error.includes(secret), false);
  assert.match(result.error, /\[REDACTED\]/);
  assert.match(result.error, /\[truncated \d+ chars\]/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].meta.status, 401);
  assert.equal(entries[0].meta.body.includes(secret), false);
  assert.match(entries[0].meta.body, /\[truncated \d+ chars\]/);
});
