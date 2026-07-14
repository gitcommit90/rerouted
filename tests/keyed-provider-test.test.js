"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { it } = require("node:test");
const { testKeyedProvider } = require("../src/lib/keyed-provider-test");

it("discovers models when no exact custom model ID is supplied", async () => {
  let listedProvider;
  const result = await testKeyedProvider(
    { baseUrl: "https://example.test/v1/", apiKey: "test-key" },
    {
      adapter: {
        listModels: async (provider) => {
          listedProvider = provider;
          return [{ id: "model-a", name: "Model A" }];
        },
      },
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.validation, "models");
  assert.equal(listedProvider.baseUrl, "https://example.test/v1");
  assert.deepEqual(result.models, [{ id: "model-a", name: "Model A" }]);
});

it("validates a known model through chat completions without calling /models", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      if (request.url === "/v1/models") {
        response.writeHead(404).end("not supported");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const result = await testKeyedProvider({
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKey: "test-key",
      modelId: "cline-known-model",
    });

    assert.equal(result.ok, true);
    assert.equal(result.validation, "chat-completions");
    assert.deepEqual(requests.map((request) => request.path), ["/v1/chat/completions"]);
    assert.equal(requests[0].authorization, "Bearer test-key");
    assert.equal(requests[0].body.model, "cline-known-model");
    assert.deepEqual(result.models, [{ id: "cline-known-model", name: "cline-known-model" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

it("does not admit an exact model when its chat-completion test fails", async () => {
  const result = await testKeyedProvider(
    {
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      modelId: "missing-model",
    },
    {
      adapter: {
        chat: async () => new Response("unknown model", { status: 404 }),
      },
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /Model test failed \(404\): unknown model/);
});
