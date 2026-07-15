"use strict";

const assert = require("node:assert/strict");
const { it } = require("node:test");
const openaiCompat = require("../src/lib/providers/openai-compat");

const provider = {
  baseUrl: "https://example.test/v1/",
  apiKey: "test-key",
};

it("bounds model discovery even when fetch ignores cancellation", async () => {
  let signal;
  const startedAt = Date.now();

  await assert.rejects(
    () =>
      openaiCompat.listModels(provider, {
        timeoutMs: 20,
        fetchImpl: (_url, options) => {
          signal = options.signal;
          return new Promise(() => {});
        },
      }),
    (error) => {
      assert.equal(error.name, "TimeoutError");
      assert.equal(error.code, "ETIMEDOUT");
      assert.equal(error.message, "models fetch timed out after 20ms");
      return true;
    },
  );

  assert.ok(
    Date.now() - startedAt < 500,
    "model discovery should return promptly",
  );
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, "TimeoutError");
});

it("bounds model discovery while reading a stalled response body", async () => {
  await assert.rejects(
    () =>
      openaiCompat.listModels(provider, {
        timeoutMs: 20,
        fetchImpl: async () => ({
          ok: true,
          json: () => new Promise(() => {}),
        }),
      }),
    { name: "TimeoutError", code: "ETIMEDOUT" },
  );
});

it("clears the timeout after successful model discovery", async () => {
  let request;
  const models = await openaiCompat.listModels(provider, {
    timeoutMs: 20,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({ data: [{ id: "model-a" }, { name: "Model B" }] }),
      };
    },
  });

  assert.equal(request.url, "https://example.test/v1/models");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(models, [
    { id: "model-a", name: "model-a" },
    { id: "Model B", name: "Model B" },
  ]);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(request.options.signal.aborted, false);
});

it("unwraps successful object response envelopes without losing completion metadata", async () => {
  const completion = {
    id: "chatcmpl-1",
    model: "model-a",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    provider_metadata: { request_id: "upstream-1" },
  };

  const response = await openaiCompat.chat(provider, {
    model: "model-a",
    body: { messages: [{ role: "user", content: "Weather?" }] },
    stream: false,
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: true, data: completion }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-1",
        },
      }),
  });

  assert.deepEqual(await response.json(), completion);
  assert.equal(response.headers.get("x-request-id"), "request-1");
});

it("unwraps nested JSON data envelopes and normalizes tool-call finish reasons", async () => {
  const response = await openaiCompat.chat(provider, {
    model: "model-a",
    body: { messages: [{ role: "user", content: "Weather?" }] },
    stream: false,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: JSON.stringify({
            data: {
              id: "chatcmpl-2",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    tool_calls: [
                      {
                        id: "call-2",
                        type: "function",
                        function: { name: "get_weather", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: "stop",
                },
              ],
            },
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });

  const completion = await response.json();
  assert.equal(completion.id, "chatcmpl-2");
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(
    completion.choices[0].message.tool_calls[0].function.name,
    "get_weather",
  );
});

it("normalizes structured tool calls in ordinary successful completions", async () => {
  const response = await openaiCompat.chat(provider, {
    model: "model-a",
    body: { messages: [{ role: "user", content: "Weather?" }] },
    stream: false,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call-3",
                    type: "function",
                    function: { name: "weather", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200 },
      ),
  });

  assert.equal((await response.json()).choices[0].finish_reason, "tool_calls");
});

it("preserves terminal failure reasons and incomplete tool calls", async () => {
  const response = await openaiCompat.chat(provider, {
    model: "model-a",
    body: { messages: [{ role: "user", content: "Weather?" }] },
    stream: false,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call-incomplete",
                    type: "function",
                    function: { name: "weather", arguments: '{"city":' },
                  },
                ],
              },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200 },
      ),
  });

  assert.equal((await response.json()).choices[0].finish_reason, "length");
});

it("does not unwrap an already-valid completion with vendor data metadata", async () => {
  const completion = {
    success: true,
    data: { choices: [] },
    choices: [
      {
        message: { role: "assistant", content: "top-level completion" },
        finish_reason: "stop",
      },
    ],
  };
  const response = await openaiCompat.chat(provider, {
    model: "model-a",
    body: { messages: [{ role: "user", content: "Hi" }] },
    stream: false,
    fetchImpl: async () => new Response(JSON.stringify(completion), { status: 200 }),
  });

  assert.deepEqual(await response.json(), completion);
});

it("turns failure envelopes into upstream errors and preserves HTTP errors and streams", async () => {
  const failure = new Response(
    JSON.stringify({
      success: false,
      data: { choices: [] },
      error: "provider failed",
    }),
    { status: 200 },
  );
  const failedHttp = new Response(
    JSON.stringify({ success: true, data: { choices: [] } }),
    {
      status: 429,
    },
  );
  const streamResponse = new Response(
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const responses = [failure, failedHttp, streamResponse];
  const fetchImpl = async () => responses.shift();
  const options = {
    model: "model-a",
    body: { messages: [{ role: "user", content: "Hi" }] },
    fetchImpl,
  };

  const normalizedFailure = await openaiCompat.chat(provider, {
    ...options,
    stream: false,
  });
  assert.equal(normalizedFailure.status, 502);
  assert.deepEqual(await normalizedFailure.json(), {
    success: false,
    data: { choices: [] },
    error: "provider failed",
  });
  assert.equal(
    await openaiCompat.chat(provider, { ...options, stream: false }),
    failedHttp,
  );
  assert.equal(
    await openaiCompat.chat(provider, { ...options, stream: true }),
    streamResponse,
  );
});
