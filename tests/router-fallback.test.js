"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  classifyFailure,
  createRouter,
  errorMessageFromText,
  parseResetHint,
  resolveSingle,
} = require("../src/lib/router");
const { createStore } = require("../src/lib/store");
const { createGateway } = require("../src/lib/gateway");

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-fallback-"));
  return path.join(dir, "config.json");
}

function oauthAccount(id, token, createdAt, extra = {}) {
  return {
    id,
    type: "xai",
    name: id,
    accessToken: token,
    models: [{ id: "grok-4.5", name: "Grok 4.5", enabled: true }],
    enabled: true,
    createdAt,
    ...extra,
  };
}

function chatgptAccount(id, token, createdAt, extra = {}) {
  return {
    id,
    type: "chatgpt",
    name: id,
    accessToken: token,
    models: [{ id: "gpt-5.4", name: "GPT 5.4", enabled: true }],
    enabled: true,
    createdAt,
    ...extra,
  };
}

function captureLogger() {
  const entries = [];
  const add = (level) => (message, meta) => entries.push({ level, message, meta });
  return {
    entries,
    info: add("info"),
    warn: add("warn"),
    error: add("error"),
  };
}

function successResponse(content = "ok") {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function responsesSuccessResponse(content = "ok") {
  return new Response(
    [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}`,
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}`,
      "",
    ].join("\n\n"),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function authToken(options) {
  return String(options?.headers?.Authorization || "").replace(/^Bearer\s+/i, "");
}

async function withGateway(store, router, callback) {
  const gateway = createGateway({ store, router, port: 0 });
  const server = http.createServer((req, res) => gateway.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await callback(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("provider failure classification", () => {
  it("extracts top-level detail messages", () => {
    assert.equal(
      errorMessageFromText(
        JSON.stringify({
          detail: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
        })
      ),
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
    );
  });

  it("allows model capability failures to advance fallback without widening generic errors", () => {
    assert.deepEqual(
      classifyFailure(
        400,
        "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account."
      ),
      { eligible: true, kind: "capability", defaultCooldownMs: 0 }
    );
    assert.deepEqual(classifyFailure(400, "invalid request body"), {
      eligible: false,
      kind: "request",
      defaultCooldownMs: 0,
    });
    assert.deepEqual(classifyFailure(404, "not-found"), {
      eligible: false,
      kind: "request",
      defaultCooldownMs: 0,
    });
  });
});

describe("same-provider OAuth account fallback", () => {
  it("assigns monotonic oauth aliases and advertises only shared model ids", () => {
    const configPath = tmpConfig();
    const store = createStore(configPath);
    store.seed({
      providers: [oauthAccount("prov_b", "token-b", 200), oauthAccount("prov_a", "token-a", 100)],
    });

    let cfg = store.load();
    assert.equal(cfg.providers.find((p) => p.id === "prov_a").accountAlias, "oauth1");
    assert.equal(cfg.providers.find((p) => p.id === "prov_b").accountAlias, "oauth2");

    store.update((next) => {
      next.providers.push(oauthAccount("prov_c", "token-c", 300));
    });
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(cfg.providers.find((p) => p.id === "prov_a").accountAlias, "oauth1");
    assert.equal(cfg.providers.find((p) => p.id === "prov_b").accountAlias, "oauth2");
    assert.equal(cfg.providers.find((p) => p.id === "prov_c").accountAlias, "oauth3");

    let ids = createRouter({ store, logger: captureLogger() }).listModels().data.map((model) => model.id);
    assert.deepEqual(ids.filter((id) => id.endsWith("/grok-4.5")), ["xai/grok-4.5"]);
    assert.equal(resolveSingle(store.load(), "xai/oauth1/grok-4.5").provider.id, "prov_a");
    assert.equal(resolveSingle(store.load(), "xai/oauth2/grok-4.5").provider.id, "prov_b");

    store.update((next) => {
      next.providers = next.providers.filter((provider) => provider.id !== "prov_a");
      next.providers.push(oauthAccount("prov_d", "token-d", 400));
    });
    cfg = store.load();
    assert.equal(cfg.providers.find((p) => p.id === "prov_b").accountAlias, "oauth2");
    assert.equal(cfg.providers.find((p) => p.id === "prov_c").accountAlias, "oauth3");
    assert.equal(cfg.providers.find((p) => p.id === "prov_d").accountAlias, "oauth4");
    ids = createRouter({ store, logger: captureLogger() }).listModels().data.map((model) => model.id);
    assert.deepEqual(ids.filter((id) => id.endsWith("/grok-4.5")), ["xai/grok-4.5"]);
    assert.equal(resolveSingle(store.load(), "xai/oauth4/grok-4.5").provider.id, "prov_d");

    store.update((next) => {
      next.providers = next.providers.filter((provider) => provider.type !== "xai");
    });
    store.update((next) => {
      next.providers.push(oauthAccount("prov_e", "token-e", 500));
    });
    assert.equal(store.load().providers.find((p) => p.id === "prov_e").accountAlias, "oauth5");
    assert.equal(store.load().providerAliasCounters.xai, 5);
  });

  it("keeps stored account short-id routes resolvable", () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        {
          id: "prov_abcdef123456",
          type: "codex",
          name: "Stored account",
          accessToken: "token-a",
          models: [{ id: "gpt-5.4", name: "GPT 5.4", enabled: true }],
          enabled: true,
          createdAt: 100,
        },
      ],
    });
    const resolved = resolveSingle(store.load(), "codex/abcdef12/gpt-5.4");
    assert.equal(resolved.provider.id, "prov_abcdef123456");
    assert.equal(resolved.upstreamModel, "gpt-5.4");
  });

  it("uses the longest trustworthy reset hint", () => {
    const now = Date.now();
    const resetAt = now + 60 * 60_000;
    const response = new Response("", {
      status: 429,
      headers: {
        "Retry-After": "120",
        "x-ratelimit-reset": String(Math.floor(resetAt / 1000)),
      },
    });
    const parsed = parseResetHint(response, "", now);
    assert.ok(parsed >= resetAt - 1000);
  });

  it("falls from direct oauth1 after 429 to oauth2 and persists the reset lock", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const calls = [];
    const logger = captureLogger();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async (_url, options) => {
        const token = authToken(options);
        calls.push(token);
        if (token === "token-a") {
          return new Response(JSON.stringify({ error: { message: "usage limit reached" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "120" },
          });
        }
        return successResponse("from oauth2");
      },
    });

    const before = Date.now();
    const result = await router.chatCompletions({
      body: {
        model: "xai/oauth1/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.accountAlias, "oauth2");
    assert.deepEqual(calls, ["token-a", "token-b"]);
    const first = store.load().providers.find((provider) => provider.id === "prov_a");
    assert.equal(first.modelLocks["grok-4.5"].status, 429);
    assert.equal(first.modelLocks["grok-4.5"].kind, "quota");
    assert.ok(first.modelLocks["grok-4.5"].until >= before + 119_000);
    assert.equal(first.modelLocks["*"].kind, "quota");
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "account_failure"));
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "account_fallback"));
  });

  it("reports each provider selection as fallback retargets a live request", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const selections = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      fetchImpl: async (_url, options) => {
        if (authToken(options) === "token-a") {
          return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        return successResponse("fallback target");
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      onProviderSelected: (provider) => selections.push(provider),
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual(
      selections.map(({ providerId, providerType, upstreamModel }) => ({
        providerId,
        providerType,
        upstreamModel,
      })),
      [
        { providerId: "prov_a", providerType: "xai", upstreamModel: "grok-4.5" },
        { providerId: "prov_b", providerType: "xai", upstreamModel: "grok-4.5" },
      ]
    );
  });

  it("serves a successful gateway response after shared-route account fallback", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const calls = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      fetchImpl: async (_url, options) => {
        const token = authToken(options);
        calls.push(token);
        if (token === "token-a") {
          return new Response(JSON.stringify({ error: { message: "quota exhausted" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        return responsesSuccessResponse("gateway fallback worked");
      },
    });

    await withGateway(store, router, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${store.load().apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "xai/grok-4.5",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.choices[0].message.content, "gateway fallback worked");
    });
    assert.deepEqual(calls, ["token-a", "token-b"]);
  });

  it("turns an early 200 Codex SSE usage limit into account fallback", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        chatgptAccount("prov_a", "token-a", 100),
        chatgptAccount("prov_b", "token-b", 200),
      ],
    });
    const calls = [];
    const resetAtSeconds = Math.floor((Date.now() + 5 * 60_000) / 1000);
    const router = createRouter({
      store,
      logger: captureLogger(),
      fetchImpl: async (_url, options) => {
        const token = authToken(options);
        calls.push(token);
        if (token === "token-a") {
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: response.created\ndata: ${JSON.stringify({ type: "response.created" })}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({
                    type: "error",
                    error: {
                      type: "usage_limit_reached",
                      message: "Codex weekly quota exhausted",
                      resets_at: resetAtSeconds,
                    },
                  })}\n\n`
                )
              );
              controller.close();
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response(
          [
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "from oauth2" })}`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}`,
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "chatgpt/gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.accountAlias, "oauth2");
    const chunks = [];
    await result.streamPipe({ write: (chunk) => chunks.push(String(chunk)) });
    assert.match(chunks.join(""), /from oauth2/);
    assert.deepEqual(calls, ["token-a", "token-b"]);
    const first = store.load().providers.find((provider) => provider.id === "prov_a");
    assert.equal(first.modelLocks["*"].kind, "quota");
    assert.ok(first.modelLocks["*"].until >= resetAtSeconds * 1000);
  });

  it("falls back on non-Codex SSE quota errors before output starts", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const calls = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      fetchImpl: async (_url, options) => {
        const token = authToken(options);
        calls.push(token);
        if (token === "token-a") {
          return new Response(
            [
              `data: ${JSON.stringify({
                id: "meta",
                choices: [{ delta: { role: "assistant", content: "" } }],
              })}`,
              `data: ${JSON.stringify({ error: { code: "insufficient_quota" } })}`,
              "",
            ].join("\n\n"),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "from oauth2" } }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        );
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.accountAlias, "oauth2");
    assert.deepEqual(calls, ["token-a", "token-b"]);
  });

  it("uses quota error codes for fallback even when the message is absent", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const calls = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      fetchImpl: async (_url, options) => {
        const token = authToken(options);
        calls.push(token);
        if (token === "token-a") {
          return new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        return successResponse("code fallback");
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.accountAlias, "oauth2");
    assert.deepEqual(calls, ["token-a", "token-b"]);
  });

  it("advances a three-target route after a locked account and unsupported model", async () => {
    const unsupported =
      "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.";
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        chatgptAccount("prov_a", "token-a", 100, {
          models: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", enabled: true }],
          modelLocks: {
            "*": {
              until: Date.now() + 5 * 60_000,
              status: 429,
              kind: "quota",
              reason: "usage_limit_reached",
            },
          },
        }),
        chatgptAccount("prov_b", "token-b", 200, {
          models: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol", enabled: true }],
        }),
        {
          id: "prov_backup",
          type: "openai-compat",
          name: "Backup",
          baseUrl: "https://backup.test/v1",
          apiKey: "backup-key",
          enabled: true,
          models: [{ id: "backup-model", name: "Backup model", enabled: true }],
        },
      ],
      combos: [
        {
          id: "combo_sol",
          name: "5.6-sol",
          strategy: "fallback",
          members: [
            { providerId: "prov_a", model: "gpt-5.6-sol" },
            { providerId: "prov_b", model: "gpt-5.6-sol" },
            { providerId: "prov_backup", model: "backup-model" },
          ],
        },
      ],
    });
    const calls = [];
    const logger = captureLogger();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async (_url, options) => {
        const token = authToken(options);
        calls.push(token);
        if (token === "token-b") {
          return new Response(JSON.stringify({ detail: unsupported }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (token === "backup-key") {
          const request = JSON.parse(options.body);
          if (request.stream) {
            return new Response(
              [
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "third target worked" }, finish_reason: null }] })}`,
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
                "data: [DONE]",
                "",
              ].join("\n\n"),
              { status: 200, headers: { "Content-Type": "text/event-stream" } }
            );
          }
          return successResponse("third target worked");
        }
        throw new Error(`Unexpected upstream token: ${token}`);
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "5.6-sol",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.openAiJson.choices[0].message.content, "third target worked");
    assert.deepEqual(calls, ["token-b", "backup-key"]);
    assert.deepEqual(store.load().providers.find((provider) => provider.id === "prov_b").modelLocks, {});
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "account_locked_skip"));
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "route_fallback"));

    calls.length = 0;
    await withGateway(store, router, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${store.load().apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "5.6-sol",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /third target worked/);
    });
    assert.deepEqual(calls, ["token-b", "backup-key"]);
  });

  it("does not fall back or lock accounts after caller cancellation", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const calls = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      fetchImpl: async (_url, options) => {
        calls.push(authToken(options));
        await new Promise((resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason || new Error("aborted")),
            { once: true }
          );
        });
      },
    });
    const controller = new AbortController();
    const pending = router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      signal: controller.signal,
    });
    controller.abort(new Error("client gone"));
    const result = await pending;

    assert.equal(result.status, 499);
    assert.deepEqual(calls, ["token-a"]);
    assert.deepEqual(store.load().providers[0].modelLocks, {});
    assert.deepEqual(store.load().providers[1].modelLocks, {});
  });

  it("logs when a stream fails after output has already started", async () => {
    const store = createStore(tmpConfig());
    store.seed({ providers: [chatgptAccount("prov_a", "token-a", 100)] });
    const logger = captureLogger();
    const usageRows = [];
    const encoder = new TextEncoder();
    const router = createRouter({
      store,
      logger,
      usage: { record: (entry) => usageRows.push(entry) },
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`
                )
              );
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({
                    type: "error",
                    error: { type: "rate_limit_error", message: "late quota failure" },
                  })}\n\n`
                )
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ),
    });
    const result = await router.chatCompletions({
      body: {
        model: "chatgpt/gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });
    assert.equal(result.ok, true);
    await assert.rejects(
      result.streamPipe({ write() {} }),
      /late quota failure/
    );
    assert.ok(
      logger.entries.some((entry) => entry.meta?.event === "stream_failure_no_fallback")
    );
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0].status, 502);
    assert.match(usageRows[0].error, /late quota failure/);
  });

  it("logs late OpenAI-compatible SSE errors after output has started", async () => {
    const store = createStore(tmpConfig());
    store.seed({ providers: [oauthAccount("prov_a", "token-a", 100)] });
    const logger = captureLogger();
    const encoder = new TextEncoder();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`
                )
              );
              setImmediate(() => {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      error: { message: "late xAI quota failure" },
                    })}\n\n`
                  )
                );
                controller.close();
              });
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ),
    });
    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });

    assert.equal(result.ok, true);
    await assert.rejects(result.streamPipe({ write() {} }), /late xAI quota failure/);
    assert.ok(
      logger.entries.some((entry) => entry.meta?.event === "stream_failure_no_fallback")
    );
  });

  it("keeps the upstream stream cancellable after route selection", async () => {
    const store = createStore(tmpConfig());
    store.seed({ providers: [oauthAccount("prov_a", "token-a", 100)] });
    const encoder = new TextEncoder();
    let upstreamAborted = false;
    const logger = captureLogger();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`
                )
              );
              options.signal.addEventListener(
                "abort",
                () => {
                  upstreamAborted = true;
                  controller.error(options.signal.reason || new Error("aborted"));
                },
                { once: true }
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ),
    });
    const controller = new AbortController();
    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      signal: controller.signal,
    });
    const pending = result.streamPipe({ write() {} });
    controller.abort(new Error("client disconnected"));

    await assert.rejects(pending, /client disconnected/);
    assert.equal(upstreamAborted, true);
    assert.ok(!logger.entries.some((entry) => entry.meta?.event === "stream_failure_no_fallback"));
  });

  it("does not apply the route-selection timeout to an active stream", async () => {
    const store = createStore(tmpConfig());
    store.seed({ providers: [oauthAccount("prov_a", "token-a", 100)] });
    const encoder = new TextEncoder();
    let timedOut = false;
    const router = createRouter({
      store,
      timeoutMs: 20,
      logger: captureLogger(),
      fetchImpl: async (_url, options) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "first" })}\n\n`
                )
              );
              options.signal.addEventListener(
                "abort",
                () => {
                  timedOut = true;
                  controller.error(options.signal.reason || new Error("timed out"));
                },
                { once: true }
              );
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode(
                    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "second" })}\n\n`
                  )
                );
                controller.enqueue(
                  encoder.encode(
                    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`
                  )
                );
                controller.close();
              }, 50);
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ),
    });
    const outer = new AbortController();
    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      signal: outer.signal,
    });
    const chunks = [];
    await result.streamPipe({ write: (chunk) => chunks.push(String(chunk)) });

    assert.equal(timedOut, false);
    assert.match(chunks.join(""), /second/);
  });

  it("propagates a gateway client disconnect through an active stream", async () => {
    const store = createStore(tmpConfig());
    store.seed({ providers: [] });
    let resolveAborted;
    const aborted = new Promise((resolve) => {
      resolveAborted = resolve;
    });
    const router = {
      async chatCompletions({ signal }) {
        signal.addEventListener("abort", resolveAborted, { once: true });
        return {
          ok: true,
          stream: true,
          providerId: "test",
          model: "test",
          streamPipe: async (res) => {
            res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
            await new Promise((resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(signal.reason || new Error("aborted")),
                { once: true }
              );
            });
          },
        };
      },
      listModels() {
        return { object: "list", data: [] };
      },
    };

    await withGateway(store, router, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${store.load().apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
      await Promise.race([
        aborted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("abort not propagated")), 1000)),
      ]);
    });
  });

  it("does not claim account exhaustion after a non-fallback request error", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const logger = captureLogger();
    const calls = [];
    const router = createRouter({
      store,
      logger,
      fetchImpl: async (_url, options) => {
        calls.push(authToken(options));
        return new Response(JSON.stringify({ error: { message: "invalid request" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(calls, ["token-a"]);
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "route_failure_no_fallback"));
    assert.ok(!logger.entries.some((entry) => entry.meta?.event === "accounts_exhausted"));
  });

  it("does not persist OAuth account locks for keyed providers", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        {
          id: "prov_keyed",
          type: "openai-compat",
          name: "Keyed",
          baseUrl: "https://example.test/v1",
          apiKey: "key",
          enabled: true,
          models: [{ id: "keyed-model", name: "Keyed model", enabled: true }],
        },
      ],
    });
    const modelId = createRouter({ store, logger: captureLogger() }).listModels().data[0].id;
    const logger = captureLogger();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const result = await router.chatCompletions({
      body: {
        model: modelId,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(store.load().providers[0].modelLocks, {});
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "route_member_failure"));
    assert.ok(!logger.entries.some((entry) => entry.meta?.event === "account_failure"));
  });

  it("uses route exhaustion logs for mixed OAuth and keyed combos", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        oauthAccount("prov_oauth", "token-oauth", 100),
        {
          id: "prov_keyed",
          type: "openai-compat",
          name: "Keyed",
          baseUrl: "https://example.test/v1",
          apiKey: "key",
          enabled: true,
          models: [{ id: "keyed-model", name: "Keyed model", enabled: true }],
        },
      ],
      combos: [
        {
          id: "mixed-combo",
          strategy: "fallback",
          members: [
            { providerId: "prov_oauth", model: "grok-4.5" },
            { providerId: "prov_keyed", model: "keyed-model" },
          ],
        },
      ],
    });
    const logger = captureLogger();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const result = await router.chatCompletions({
      body: {
        model: "mixed-combo",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, false);
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "route_failure_no_fallback"));
    assert.ok(!logger.entries.some((entry) => entry.meta?.event === "accounts_exhausted"));
  });

  it("returns every attempt and emits terminal exhaustion logging", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [oauthAccount("prov_a", "token-a", 100), oauthAccount("prov_b", "token-b", 200)],
    });
    const logger = captureLogger();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async (_url, options) => {
        const token = authToken(options);
        if (token === "token-a") {
          return new Response(JSON.stringify({ error: { message: "rate limited A" } }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: { message: "upstream unavailable B" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.error.details.length, 2);
    assert.deepEqual(
      result.error.error.details.map((attempt) => attempt.accountAlias),
      ["oauth1", "oauth2"]
    );
    assert.match(result.error.error.message, /xAI \(Grok\) \(oauth1\) \[429\]: rate limited A/);
    assert.match(result.error.error.message, /xAI \(Grok\) \(oauth2\) \[503\]: upstream unavailable B/);
    assert.doesNotMatch(result.error.error.message, /prov_/);
    const terminal = logger.entries.find((entry) => entry.meta?.event === "accounts_exhausted");
    assert.ok(terminal);
    assert.equal(terminal.meta.attempts.length, 2);
  });

  it("skips a persisted model lock and selects the next account without calling the locked one", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        oauthAccount("prov_a", "token-a", 100, {
          models: [
            { id: "grok-4.5", name: "Grok 4.5", enabled: true },
            { id: "grok-4.5-high", name: "Grok 4.5 High", enabled: true },
          ],
          modelLocks: {
            "*": {
              until: Date.now() + 5 * 60_000,
              status: 429,
              kind: "quota",
              reason: "weekly quota exhausted",
            },
          },
        }),
        oauthAccount("prov_b", "token-b", 200, {
          models: [
            { id: "grok-4.5", name: "Grok 4.5", enabled: true },
            { id: "grok-4.5-high", name: "Grok 4.5 High", enabled: true },
          ],
        }),
      ],
    });
    const calls = [];
    const logger = captureLogger();
    const router = createRouter({
      store,
      logger,
      fetchImpl: async (_url, options) => {
        calls.push(authToken(options));
        return successResponse("lock skipped");
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5-high",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.accountAlias, "oauth2");
    assert.deepEqual(calls, ["token-b"]);
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "account_locked_skip"));
    assert.ok(logger.entries.some((entry) => entry.meta?.event === "account_fallback"));
  });

  it("stops an explicit route on a non-retryable failure before later locks can replace it", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        oauthAccount("prov_a", "token-a", 100),
        oauthAccount("prov_b", "token-b", 200, {
          modelLocks: {
            "*": {
              until: Date.now() + 5 * 60_000,
              status: 429,
              kind: "quota",
              reason: "stale transport lock",
            },
          },
        }),
      ],
      combos: [
        {
          id: "combo_general",
          name: "general",
          strategy: "fallback",
          members: [
            { providerId: "prov_a", model: "grok-4.5" },
            { providerId: "prov_b", model: "grok-4.5" },
          ],
        },
      ],
    });
    const calls = [];
    const usageRows = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      usage: { record: (entry) => usageRows.push(entry) },
      fetchImpl: async (_url, options) => {
        calls.push(authToken(options));
        return new Response(JSON.stringify({ error: { message: "not-found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await router.chatCompletions({
      body: {
        model: "general",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.deepEqual(calls, ["token-a"]);
    assert.equal(result.error.error.details.length, 1);
    assert.match(result.error.error.message, /xAI \(Grok\) \(oauth1\) \[404\]: not-found/);
    assert.doesNotMatch(result.error.error.message, /locked|prov_/i);
    assert.deepEqual(
      usageRows.map((row) => [row.providerType, row.providerName, row.accountAlias]),
      [["xai", "xAI (Grok)", "oauth1"]]
    );
  });

  it("records streaming usage after the final SSE event instead of an early zero-token success", async () => {
    const store = createStore(tmpConfig());
    store.seed({ providers: [oauthAccount("prov_a", "token-a", 100)] });
    const usageRows = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      usage: { record: (entry) => usageRows.push(entry) },
      fetchImpl: async () =>
        new Response(
          [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}',
            'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ),
    });

    const result = await router.chatCompletions({
      body: {
        model: "xai/grok-4.5",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });

    assert.equal(result.ok, true);
    assert.equal(usageRows.length, 0);
    await result.streamPipe({ write() {} });
    assert.equal(usageRows.length, 1);
    assert.deepEqual(
      {
        prompt_tokens: usageRows[0].prompt_tokens,
        completion_tokens: usageRows[0].completion_tokens,
        total_tokens: usageRows[0].total_tokens,
      },
      { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
    );
  });

  it("captures final usage from OpenAI-compatible streams", async () => {
    const store = createStore(tmpConfig());
    store.seed({
      providers: [
        {
          id: "prov_glm",
          type: "glm",
          name: "GLM Coding",
          baseUrl: "https://api.z.ai/api/coding/paas/v4",
          apiKey: "glm-key",
          models: [{ id: "glm-5.2", name: "GLM 5.2", enabled: true }],
          enabled: true,
          createdAt: 100,
        },
      ],
    });
    const usageRows = [];
    const router = createRouter({
      store,
      logger: captureLogger(),
      usage: { record: (entry) => usageRows.push(entry) },
      fetchImpl: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ),
    });

    const result = await router.chatCompletions({
      body: {
        model: "glm/glm-5.2",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
    });
    assert.equal(usageRows.length, 0);
    await result.streamPipe({ write() {} });
    assert.deepEqual(
      usageRows.map((row) => [row.prompt_tokens, row.completion_tokens, row.total_tokens]),
      [[12, 5, 17]]
    );
  });
});
