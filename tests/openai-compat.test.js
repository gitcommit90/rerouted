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
    }
  );

  assert.ok(Date.now() - startedAt < 500, "model discovery should return promptly");
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
    { name: "TimeoutError", code: "ETIMEDOUT" }
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
