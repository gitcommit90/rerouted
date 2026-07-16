"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { describe, it } = require("node:test");
const { createGateway } = require("../src/lib/gateway");
const { createRequestActivity } = require("../src/lib/request-activity");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: "Bearer rr-test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe("live request activity", () => {
  it("tracks provider selection until a non-stream response completes", async () => {
    let tick = 100;
    const activity = createRequestActivity({
      now: () => ++tick,
      idFactory: () => "request-1",
    });
    const events = [];
    activity.subscribe((event) => events.push(event));
    const router = {
      chatCompletions: async ({ onProviderSelected }) => {
        onProviderSelected({
          providerId: "provider-1",
          providerType: "chatgpt",
          providerName: "ChatGPT Plus",
          upstreamModel: "gpt-5",
        });
        assert.equal(activity.snapshot()[0].providerId, "provider-1");
        return {
          ok: true,
          stream: false,
          openAiJson: { choices: [{ message: { role: "assistant", content: "ok" } }] },
        };
      },
    };
    const gateway = createGateway({
      store: { load: () => ({ apiKey: "rr-test", serverEnabled: true }) },
      router,
      requestActivity: activity,
    });
    const server = http.createServer((req, res) => gateway.handle(req, res));
    const port = await listen(server);
    try {
      const response = await post(port, { model: "coding", messages: [] });
      assert.equal(response.status, 200);
      assert.deepEqual(events.map((event) => event.type), ["started", "routed", "finished"]);
      assert.equal(events[1].request.providerName, "ChatGPT Plus");
      assert.equal(events[2].request.outcome, "success");
      assert.deepEqual(activity.snapshot(), []);
    } finally {
      await close(server);
    }
  });

  it("clears failed requests so the status visualization cannot get stuck", async () => {
    const activity = createRequestActivity({ idFactory: () => "request-failed" });
    const events = [];
    activity.subscribe((event) => events.push(event));
    const gateway = createGateway({
      store: { load: () => ({ apiKey: "rr-test", serverEnabled: true }) },
      router: {
        chatCompletions: async ({ onProviderSelected }) => {
          onProviderSelected({ providerId: "provider-2", providerType: "claude" });
          return { ok: false, status: 429, error: { error: { message: "busy" } } };
        },
      },
      requestActivity: activity,
    });
    const server = http.createServer((req, res) => gateway.handle(req, res));
    const port = await listen(server);
    try {
      const response = await post(port, { model: "coding", messages: [] });
      assert.equal(response.status, 429);
      assert.equal(events.at(-1).request.status, 429);
      assert.equal(events.at(-1).request.outcome, "error");
      assert.deepEqual(activity.snapshot(), []);
    } finally {
      await close(server);
    }
  });

  it("keeps streaming requests active until the response stream finishes", async () => {
    const activity = createRequestActivity({ idFactory: () => "request-stream" });
    let releaseStream;
    let streamStarted;
    const streamReady = new Promise((resolve) => {
      streamStarted = resolve;
    });
    const gateway = createGateway({
      store: { load: () => ({ apiKey: "rr-test", serverEnabled: true }) },
      router: {
        chatCompletions: async ({ onProviderSelected }) => {
          onProviderSelected({
            providerId: "provider-stream",
            providerType: "chatgpt",
            providerName: "ChatGPT Plus",
          });
          return {
            ok: true,
            stream: true,
            streamPipe: async (response) => {
              response.write('data: {"choices":[]}\n\n');
              streamStarted();
              await new Promise((resolve) => {
                releaseStream = resolve;
              });
              response.write("data: [DONE]\n\n");
            },
          };
        },
      },
      requestActivity: activity,
    });
    const server = http.createServer((req, res) => gateway.handle(req, res));
    const port = await listen(server);
    try {
      const responsePromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: "Bearer rr-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "coding", messages: [], stream: true }),
      });
      await streamReady;
      assert.equal(activity.snapshot()[0].providerId, "provider-stream");
      releaseStream();
      const response = await responsePromise;
      assert.equal(response.status, 200);
      await response.text();
      assert.deepEqual(activity.snapshot(), []);
    } finally {
      await close(server);
    }
  });
});
