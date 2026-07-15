"use strict";

const assert = require("node:assert/strict");
const { it } = require("node:test");
const cloudflare = require("../src/lib/providers/cloudflare");

const provider = {
  type: "cloudflare",
  baseUrl: "https://api.cloudflare.test/client/v4/accounts/account-id/ai/v1/",
  apiKey: "test-key",
};

it("discovers runnable chat models through the Cloudflare models search endpoint", async () => {
  const requests = [];
  const models = await cloudflare.listModels(provider, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          success: true,
          result:
            new URL(url).searchParams.get("page") === "1"
              ? [
                  {
                    id: "catalog-uuid",
                    name: "@cf/meta/llama-chat",
                    task: { name: "Text Generation" },
                  },
                  {
                    id: "image-uuid",
                    name: "@cf/image/model",
                    task: { name: "Image Classification" },
                  },
                  {
                    id: "chat-uuid",
                    name: "@cf/openai/gpt-chat",
                    task: { name: "Chat" },
                  },
                  {
                    id: "duplicate-catalog-uuid",
                    name: "@cf/meta/llama-chat",
                    task: { name: "Text Generation" },
                  },
                ]
              : [],
        }),
      };
    },
  });

  assert.equal(
    requests[0].url,
    "https://api.cloudflare.test/client/v4/accounts/account-id/ai/models/search?page=1&per_page=100"
  );
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-key");
  assert.equal(new URL(requests[1].url).searchParams.get("page"), "2");
  assert.deepEqual(models, [
    { id: "@cf/meta/llama-chat", name: "@cf/meta/llama-chat" },
    { id: "@cf/openai/gpt-chat", name: "@cf/openai/gpt-chat" },
  ]);
});

it("continues Cloudflare discovery until the final short page", async () => {
  const pages = [];
  const models = await cloudflare.listModels(provider, {
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      const result =
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({
              name: `@cf/test/model-${index}`,
              task: "Text Generation",
            }))
          : page === 2
            ? [{ name: "@cf/test/final-model", task: "Text Generation" }]
            : [];
      return { ok: true, json: async () => ({ success: true, result }) };
    },
  });

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(models.length, 101);
  assert.equal(models.at(-1).id, "@cf/test/final-model");
});

it("reports Cloudflare envelope errors instead of accepting an empty model list", async () => {
  await assert.rejects(
    () =>
      cloudflare.listModels(provider, {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            success: false,
            result: null,
            errors: [{ code: 7001, message: "GET not supported for requested URI." }],
          }),
        }),
      }),
    /7001: GET not supported for requested URI\./
  );
});

it("bounds Cloudflare model discovery when fetch ignores cancellation", async () => {
  let signal;
  await assert.rejects(
    () =>
      cloudflare.listModels(provider, {
        timeoutMs: 20,
        fetchImpl: (_url, options) => {
          signal = options.signal;
          return new Promise(() => {});
        },
      }),
    { name: "TimeoutError", code: "ETIMEDOUT" }
  );

  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, "TimeoutError");
});

it("keeps Cloudflare chat on the OpenAI-compatible endpoint", async () => {
  let request;
  const response = await cloudflare.chat(provider, {
    model: "@cf/meta/llama-chat",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    },
  });

  assert.equal(
    request.url,
    "https://api.cloudflare.test/client/v4/accounts/account-id/ai/v1/chat/completions"
  );
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(JSON.parse(request.options.body).model, "@cf/meta/llama-chat");
  assert.equal(response.ok, true);
});
