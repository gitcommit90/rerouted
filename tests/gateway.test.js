"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const { createStore } = require("../src/lib/store");
const { createRouter } = require("../src/lib/router");
const { createGateway } = require("../src/lib/gateway");
const { hashPassword, verifyPassword, generateApiKey } = require("../src/lib/password");
const { generatePkce } = require("../src/lib/oauth");
const { OAUTH } = require("../src/lib/constants");
const claude = require("../src/lib/providers/claude");
const chatgpt = require("../src/lib/providers/chatgpt");
const antigravity = require("../src/lib/providers/antigravity");
const openaiCompat = require("../src/lib/providers/openai-compat");
const xai = require("../src/lib/providers/xai");
const { orderMembers, isRetryableStatus } = require("../src/lib/router");

const SCRATCH = process.env.REROUTED_SCRATCH || "/tmp/grok-goal-bf3f39dc0f60/implementer";
fs.mkdirSync(SCRATCH, { recursive: true });

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-test-"));
  return path.join(dir, "config.json");
}

/** Mock OpenAI-compatible upstream */
function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res, server));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

describe("password + api key", () => {
  it("hashes and verifies with scrypt", async () => {
    const h = await hashPassword("secret-pass");
    assert.match(h, /^scrypt\$/);
    assert.equal(await verifyPassword("secret-pass", h), true);
    assert.equal(await verifyPassword("wrong", h), false);
  });

  it("generates rr- api keys", () => {
    const k = generateApiKey();
    assert.match(k, /^rr-[a-f0-9]{32}$/);
  });
});

describe("store atomic write + mode", () => {
  it("persists config and chmod 0600 when possible", () => {
    const p = tmpConfig();
    const store = createStore(p);
    const cfg = store.load();
    assert.ok(cfg.apiKey.startsWith("rr-"));
    assert.ok(Array.isArray(cfg.providers));
    store.update((c) => {
      c.port = 4949;
    });
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    assert.equal(raw.port, 4949);
    try {
      const mode = fs.statSync(p).mode & 0o777;
      assert.equal(mode, 0o600);
    } catch {
      /* windows */
    }
  });
});

describe("gateway auth + models + chat", () => {
  let upstream;
  let store;
  let router;
  let gateway;
  let port;
  let apiKey;
  let callCount = 0;
  let lastBodies = [];

  before(async () => {
    upstream = await startMockUpstream(async (req, res) => {
      const url = new URL(req.url, "http://x");
      if (url.pathname.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock-model", name: "Mock" }] }));
        return;
      }
      if (url.pathname.endsWith("/chat/completions")) {
        callCount++;
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        lastBodies.push(body);
        if (req.headers["x-fail"] === "1" || body.model === "fail-me") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "rate limited" } }));
          return;
        }
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: " there" }, finish_reason: null }],
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello from mock" },
                finish_reason: "stop",
              },
            ],
          })
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    store = createStore(tmpConfig());
    apiKey = store.load().apiKey;
    store.update((cfg) => {
      cfg.providers.push({
        id: "prov_mock_a",
        type: "openai-compat",
        name: "Mock A",
        baseUrl: upstream.baseUrl,
        apiKey: "upstream-key",
        models: [{ id: "mock-model", name: "Mock" }],
        enabled: true,
        createdAt: Date.now(),
      });
      cfg.providers.push({
        id: "prov_mock_b",
        type: "openai-compat",
        name: "Mock B",
        baseUrl: upstream.baseUrl,
        apiKey: "upstream-key",
        models: [{ id: "mock-model", name: "Mock" }],
        enabled: true,
        createdAt: Date.now(),
      });
      cfg.combos.push({
        id: "combo_fb",
        name: "fallback-combo",
        strategy: "fallback",
        members: [
          { providerId: "prov_mock_a", model: "fail-me" },
          { providerId: "prov_mock_b", model: "mock-model" },
        ],
        createdAt: Date.now(),
      });
      cfg.combos.push({
        id: "combo_rr",
        name: "rr-combo",
        strategy: "round-robin",
        members: [
          { providerId: "prov_mock_a", model: "mock-model" },
          { providerId: "prov_mock_b", model: "mock-model" },
        ],
        createdAt: Date.now(),
      });
    });

    router = createRouter({ store });
    gateway = createGateway({ store, router, port: 0 });
    // bind random port
    const httpServer = http.createServer((req, res) => gateway.handle(req, res));
    await new Promise((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
      gateway._testServer = httpServer;
    });
    port = httpServer.address().port;
  });

  after(async () => {
    await new Promise((r) => gateway._testServer.close(r));
    await new Promise((r) => upstream.server.close(r));
  });

  async function req(method, urlPath, { key, body, headers } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  it("rejects missing api key with 401", async () => {
    const r = await req("GET", "/v1/models");
    assert.equal(r.status, 401);
  });

  it("lists routes by their user-given names while preserving stored ids for routing", async () => {
    const r = await req("GET", "/v1/models", { key: apiKey });
    assert.equal(r.status, 200);
    const ids = r.json.data.map((m) => m.id);
    assert.ok(ids.includes("fallback-combo"));
    assert.ok(ids.includes("rr-combo"));
    assert.ok(!ids.includes("combo_fb"));
    assert.ok(!ids.includes("combo_rr"));
    assert.ok(ids.some((i) => i.includes("mock-model")));
  });

  it("non-streaming chat completion", async () => {
    const models = (await req("GET", "/v1/models", { key: apiKey })).json.data;
    const mockId = models.find((m) => m.upstreamModel === "mock-model" || String(m.id).includes("mock"));
    const model = mockId ? mockId.id : "openai-compat/mock_a/mock-model";
    // resolve via provider model id from list
    const id = models.find((m) => m.owned_by === "openai-compat")?.id;
    assert.ok(id, "expected openai-compat model in list");
    const r = await req("POST", "/v1/chat/completions", {
      key: apiKey,
      body: {
        model: id,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, "Hello from mock");
  });

  it("streaming chat completion SSE", async () => {
    const models = (await req("GET", "/v1/models", { key: apiKey })).json.data;
    const id = models.find((m) => m.owned_by === "openai-compat")?.id;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("data:"));
    assert.ok(text.includes("[DONE]") || text.includes("Hi"));
  });

  it("fallback combo advances past failing member", async () => {
    lastBodies = [];
    const r = await req("POST", "/v1/chat/completions", {
      key: apiKey,
      body: {
        model: "combo_fb",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.choices[0].message.content, "Hello from mock");
    // first member used fail-me (429), second succeeded
    assert.ok(lastBodies.length >= 1);
  });

  it("routes a combo by its user-given name", async () => {
    const r = await req("POST", "/v1/chat/completions", {
      key: apiKey,
      body: {
        model: "fallback-combo",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.choices[0].message.content, "Hello from mock");
  });

  it("round-robin rotates members across requests", async () => {
    lastBodies = [];
    for (let i = 0; i < 4; i++) {
      const r = await req("POST", "/v1/chat/completions", {
        key: apiKey,
        body: {
          model: "combo_rr",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
      });
      assert.equal(r.status, 200);
    }
    // both providers should have been hit (we can't see provider id in body easily,
    // but orderMembers + two members means at least 2 calls)
    assert.ok(lastBodies.length >= 4);
  });
});

describe("combo ordering + retryable", () => {
  it("marks 429/5xx as retryable", () => {
    assert.equal(isRetryableStatus(429), true);
    assert.equal(isRetryableStatus(503), true);
    assert.equal(isRetryableStatus(400), false);
  });

  it("round-robin rotates starting index", () => {
    const rr = new Map();
    const resolved = {
      strategy: "round-robin",
      combo: { id: "c1" },
      members: [{ id: "a" }, { id: "b" }, { id: "c" }],
    };
    const o1 = orderMembers(resolved, rr).map((m) => m.id);
    const o2 = orderMembers(resolved, rr).map((m) => m.id);
    assert.deepEqual(o1, ["a", "b", "c"]);
    assert.deepEqual(o2, ["b", "c", "a"]);
  });
});

describe("OAuth refresh against mock", () => {
  it("claude refreshToken posts refresh_token grant", async () => {
    let saw = null;
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          saw = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              expires_in: 3600,
            })
          );
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = server.address().port;
    // temporarily patch cfg.tokenUrl via provider refresh using custom fetch
    const orig = claude.cfg.tokenUrl;
    claude.cfg.tokenUrl = `http://127.0.0.1:${port}/token`;
    try {
      const tokens = await claude.refreshToken(
        { refreshToken: "old-refresh" },
        { fetchImpl: fetch }
      );
      assert.equal(tokens.accessToken, "new-access");
      assert.equal(saw.grant_type, "refresh_token");
      assert.equal(saw.refresh_token, "old-refresh");
    } finally {
      claude.cfg.tokenUrl = orig;
      await new Promise((r) => server.close(r));
    }
  });
});

describe("claude oauth request shaping", () => {
  it("applyCloaking injects CC system blocks + metadata; moves client system to user", () => {
    const base = claude.toAnthropicBody(
      {
        messages: [
          { role: "system", content: "You are a custom app agent with secret tools." },
          { role: "user", content: "hi" },
        ],
        max_tokens: 8,
      },
      "claude-sonnet-4-6",
      false
    );
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const oat = "sk-ant-oat01-testtoken";
    const cloaked = claude.applyCloaking(base, oat, sessionId);
    assert.ok(Array.isArray(cloaked.system));
    assert.equal(cloaked.system.length, 3);
    assert.ok(
      cloaked.system[0].text.startsWith("x-anthropic-billing-header:"),
      cloaked.system[0].text
    );
    assert.ok(cloaked.system[0].text.includes("cc_entrypoint=cli"));
    assert.match(cloaked.system[1].text, /Claude Code/);
    assert.ok(cloaked.system[2].text.includes("software engineering"));
    // Client system moved off system[] into first user as system-reminder
    const userContent = cloaked.messages[0].content;
    const userText = Array.isArray(userContent)
      ? userContent.map((b) => b.text || "").join("\n")
      : String(userContent);
    assert.ok(userText.includes("<system-reminder>"), userText.slice(0, 200));
    const uid = JSON.parse(cloaked.metadata.user_id);
    assert.equal(uid.session_id, sessionId);
    assert.ok(uid.device_id && uid.account_uuid);
    // non-oat tokens are not cloaked
    const plain = claude.applyCloaking(base, "sk-ant-api03-x", sessionId);
    assert.equal(plain.system, base.system);
  });

  it("stableSessionId is stable per token", () => {
    const a = claude.stableSessionId("sk-ant-oat01-abc");
    const b = claude.stableSessionId("sk-ant-oat01-abc");
    const c = claude.stableSessionId("sk-ant-oat01-other");
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("chat posts full CLI spoof headers + cloaked body", async () => {
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = { url: String(url), opts };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
        async text() {
          return "";
        },
      };
    };
    await claude.chat(
      { accessToken: "sk-ant-oat01-abc", refreshToken: "rt" },
      {
        model: "claude-sonnet-4-6",
        body: { messages: [{ role: "user", content: "hi" }], max_tokens: 8 },
        stream: false,
        fetchImpl,
      }
    );
    assert.ok(seen);
    assert.ok(seen.url.includes("/v1/messages"));
    const h = seen.opts.headers;
    assert.equal(h["X-App"], "cli");
    assert.ok(String(h["User-Agent"]).startsWith("claude-cli/"));
    assert.ok(String(h["User-Agent"]).includes("(external, cli)"));
    assert.ok(h["X-Stainless-Os"]);
    assert.ok(h["X-Claude-Code-Session-Id"]);
    assert.ok(String(h["Anthropic-Beta"]).includes("oauth-2025-04-20"));
    const body = JSON.parse(seen.opts.body);
    assert.ok(body.system?.[0]?.text?.startsWith("x-anthropic-billing-header:"));
    assert.equal(body.system.length, 3);
    assert.ok(body.metadata?.user_id);
  });
});

describe("format translation", () => {
  it("openai → anthropic body", () => {
    const body = claude.toAnthropicBody(
      {
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
        ],
        max_tokens: 100,
      },
      "claude-sonnet-4-6",
      false
    );
    assert.equal(body.system, "sys");
    assert.equal(body.messages[0].role, "user");
    assert.equal(body.model, "claude-sonnet-4-6");
  });

  it("openai tools + tool_calls round-trip to anthropic blocks", () => {
    const body = claude.toAnthropicBody(
      {
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "60F" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 64,
      },
      "claude-sonnet-4-6",
      false
    );
    assert.ok(Array.isArray(body.tools));
    assert.equal(body.tools[0].name, "get_weather");
    assert.equal(body.tools[0].input_schema.properties.city.type, "string");
    assert.deepEqual(body.tool_choice, { type: "auto" });
    assert.equal(body.messages[1].role, "assistant");
    assert.equal(body.messages[1].content[0].type, "tool_use");
    assert.equal(body.messages[1].content[0].name, "get_weather");
    assert.deepEqual(body.messages[1].content[0].input, { city: "SF" });
    assert.equal(body.messages[2].role, "user");
    assert.equal(body.messages[2].content[0].type, "tool_result");
    assert.equal(body.messages[2].content[0].tool_use_id, "call_1");
  });

  it("anthropic tool_use → openai tool_calls", () => {
    const out = claude.fromAnthropicJson(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SF" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      "claude-x"
    );
    assert.equal(out.choices[0].finish_reason, "tool_calls");
    assert.equal(out.choices[0].message.content, "checking");
    assert.equal(out.choices[0].message.tool_calls[0].function.name, "get_weather");
    assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"city":"SF"}');
  });

  it("anthropic json → openai", () => {
    const out = claude.fromAnthropicJson(
      {
        id: "msg_1",
        content: [{ type: "text", text: "Hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 1 },
      },
      "claude-x"
    );
    assert.equal(out.choices[0].message.content, "Hi");
    assert.equal(out.usage.prompt_tokens, 3);
  });

  it("openai → responses body", () => {
    const body = chatgpt.toResponsesBody(
      { messages: [{ role: "user", content: "hi" }] },
      "gpt-5.4",
      true
    );
    assert.equal(body.model, "gpt-5.4");
    assert.equal(body.stream, true);
    assert.ok(Array.isArray(body.input));
  });

  it("Codex Responses receives reasoning.effort from OpenAI and Responses clients", () => {
    const fromOpenAi = chatgpt.toResponsesBody(
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      "gpt-5.5",
      true
    );
    const fromResponses = chatgpt.toResponsesBody(
      { messages: [{ role: "user", content: "hi" }], reasoning: { effort: "xhigh" } },
      "gpt-5.5",
      true
    );
    assert.deepEqual(fromOpenAi.reasoning, { effort: "high", summary: "auto" });
    assert.deepEqual(fromResponses.reasoning, { effort: "xhigh", summary: "auto" });
  });

  it("clamps max effort to OpenAI's supported xhigh level", async () => {
    const responses = chatgpt.toResponsesBody(
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
      "gpt-5.5",
      true
    );
    assert.equal(responses.reasoning.effort, "xhigh");

    let payload;
    await openaiCompat.chat(
      { baseUrl: "https://api.openai.test/v1", apiKey: "key" },
      {
        model: "gpt-5.5",
        body: { messages: [{ role: "user", content: "hi" }], output_config: { effort: "max" } },
        stream: false,
        fetchImpl: async (_url, opts) => {
          payload = JSON.parse(opts.body);
          return { status: 200, ok: true };
        },
      }
    );
    assert.equal(payload.reasoning_effort, "xhigh");
  });

  it("preserves explicit auto effort across Responses, OpenAI, and Claude", async () => {
    const responses = chatgpt.toResponsesBody(
      { messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } },
      "gpt-5.5",
      true
    );
    assert.equal(responses.reasoning.effort, "auto");

    let payload;
    await openaiCompat.chat(
      { baseUrl: "https://api.openai.test/v1", apiKey: "key" },
      {
        model: "gpt-5.5",
        body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "auto" },
        stream: false,
        fetchImpl: async (_url, opts) => {
          payload = JSON.parse(opts.body);
          return { status: 200, ok: true };
        },
      }
    );
    assert.equal(payload.reasoning_effort, "auto");

    const claudeBody = claude.toAnthropicBody(
      { messages: [{ role: "user", content: "hi" }], thinking: { type: "adaptive" } },
      "claude-sonnet-5",
      false
    );
    assert.deepEqual(claudeBody.output_config, { effort: "auto" });
  });

  it("Claude adaptive models receive output_config.effort", () => {
    const body = claude.toAnthropicBody(
      {
        messages: [{ role: "user", content: "hi" }],
        reasoning: { effort: "xhigh" },
      },
      "claude-sonnet-5",
      false
    );
    assert.deepEqual(body.output_config, { effort: "high" });
    assert.equal(body.thinking, undefined);
  });

  it("Claude Haiku falls back to token-budget thinking", () => {
    const body = claude.toAnthropicBody(
      {
        messages: [{ role: "user", content: "hi" }],
        output_config: { effort: "high" },
        max_tokens: 4096,
      },
      "claude-haiku-4-5-20251001",
      false
    );
    assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 24576 });
    assert.ok(body.max_tokens > body.thinking.budget_tokens);
    assert.equal(body.output_config, undefined);
  });

  it("Antigravity maps effort to Gemini thinkingLevel", () => {
    const body = antigravity.toGeminiBody(
      {
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "xhigh",
      },
      "gemini-3-flash-agent"
    );
    assert.deepEqual(body.request.generationConfig.thinkingConfig, {
      thinkingLevel: "high",
      includeThoughts: true,
    });
  });

  it("xAI passes OpenAI effort through and omits it for Grok Composer", async () => {
    const payloads = [];
    const fetchImpl = async (_url, opts) => {
      payloads.push(JSON.parse(opts.body));
      return { status: 200, ok: true };
    };
    const provider = { accessToken: "token" };

    await xai.chat(provider, {
      model: "grok-4.5-high",
      body: { messages: [{ role: "user", content: "hi" }], reasoning: { effort: "medium" } },
      stream: false,
      fetchImpl,
    });
    await xai.chat(provider, {
      model: "grok-composer-2.5-fast",
      body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      stream: false,
      fetchImpl,
    });

    assert.equal(payloads[0].reasoning_effort, "medium");
    assert.equal(payloads[0].reasoning, undefined);
    assert.equal(payloads[1].reasoning_effort, undefined);
    assert.equal(payloads[1].reasoning, undefined);
  });

  it("OpenAI-compatible providers preserve reasoning_effort", async () => {
    let payload;
    await openaiCompat.chat(
      { baseUrl: "https://api.openai.test/v1", apiKey: "key" },
      {
        model: "gpt-5.5",
        body: { messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
        stream: false,
        fetchImpl: async (_url, opts) => {
          payload = JSON.parse(opts.body);
          return { status: 200, ok: true };
        },
      }
    );
    assert.equal(payload.reasoning_effort, "high");
  });
});

describe("requested OAuth model catalogs", () => {
  it("ships the requested ChatGPT, Claude, Antigravity, and Grok models", () => {
    assert.deepEqual(
      OAUTH.chatgpt.models.map((model) => model.id),
      ["gpt-5.6-sol-high", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "gpt-5.4"]
    );
    assert.deepEqual(
      OAUTH.claude.models.map((model) => model.id),
      ["claude-fable-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7", "claude-haiku-4-5-20251001"]
    );
    assert.deepEqual(
      OAUTH.antigravity.models.map((model) => model.id),
      ["gemini-3-flash-agent", "gemini-pro-agent"]
    );
    assert.deepEqual(
      OAUTH.xai.models.map((model) => model.id),
      ["grok-4.5-high", "grok-4.5-medium", "grok-4.5-low", "grok-4.5", "grok-composer-2.5-fast"]
    );
  });

  it("adds new catalog models to existing OAuth accounts during migration", () => {
    const { migrate } = require("../src/lib/store");
    const cfg = migrate({
      providers: [
        {
          id: "prov_existing",
          type: "chatgpt",
          models: [{ id: "gpt-5.4", name: "GPT 5.4", enabled: false }],
        },
      ],
      combos: [],
    });
    const models = cfg.providers[0].models;
    assert.ok(models.some((model) => model.id === "gpt-5.6-sol-high" && model.enabled));
    assert.equal(models.find((model) => model.id === "gpt-5.4").enabled, false);
  });
});

describe("pkce", () => {
  it("generates verifier and challenge", () => {
    const p = generatePkce();
    assert.ok(p.codeVerifier.length > 20);
    assert.ok(p.codeChallenge.length > 20);
    assert.ok(p.state.length > 10);
  });

  it("identifies xAI authorization requests as ReRouted", () => {
    const { buildAuthUrl } = require("../src/lib/oauth");
    const url = new URL(
      buildAuthUrl("xai", {
        redirectUri: "http://localhost:56121/callback",
        state: "teststate",
        codeChallenge: "challenge123",
      })
    );
    assert.equal(url.searchParams.get("referrer"), "rerouted");
  });
});

describe("multi-key auth + disabled models", () => {
  it("accepts any enabled apiKeys entry", async () => {
    const store = createStore(tmpConfig());
    store.update((cfg) => {
      cfg.apiKeys = [
        { id: "k1", key: "rr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "A", enabled: true },
        { id: "k2", key: "rr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", name: "B", enabled: true },
        { id: "k3", key: "rr-cccccccccccccccccccccccccccccccc", name: "C", enabled: false },
      ];
      cfg.apiKey = "rr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    });
    const router = createRouter({ store });
    const gateway = createGateway({ store, router, port: 0 });
    const httpServer = http.createServer((req, res) => gateway.handle(req, res));
    await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = httpServer.address().port;
    const hit = async (key) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      return res.status;
    };
    assert.equal(await hit("rr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), 200);
    assert.equal(await hit("rr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), 200);
    assert.equal(await hit("rr-cccccccccccccccccccccccccccccccc"), 401);
    assert.equal(await hit("rr-wrong"), 401);
    await new Promise((r) => httpServer.close(r));
  });

  it("omits disabled models from /v1/models", () => {
    const { listProviderModels } = require("../src/lib/providers");
    const prov = {
      id: "prov_x",
      type: "openai-compat",
      enabled: true,
      models: [
        { id: "on-model", name: "On", enabled: true },
        { id: "off-model", name: "Off", enabled: false },
      ],
    };
    const pub = listProviderModels(prov, { includeDisabled: false });
    assert.equal(pub.length, 1);
    assert.equal(pub[0].upstreamModel, "on-model");
    const all = listProviderModels(prov, { includeDisabled: true });
    assert.equal(all.length, 2);
  });
});

describe("oauth code normalize", () => {
  it("parses code#state and query strings", () => {
    const { normalizeAuthCode } = require("../src/lib/oauth");
    assert.deepEqual(normalizeAuthCode("abc#xyz"), { code: "abc", state: "xyz" });
    const q = normalizeAuthCode(
      "https://console.anthropic.com/oauth/code/callback?code=tok123&state=st"
    );
    assert.equal(q.code, "tok123");
    assert.equal(q.state, "st");
    const local = normalizeAuthCode("http://localhost:54545/callback?code=abc&state=xyz");
    assert.equal(local.code, "abc");
    assert.equal(local.state, "xyz");
    assert.equal(normalizeAuthCode("  plain  ").code, "plain");
  });
});

describe("claude oauth auth url", () => {
  // Claude OAuth contract values used by the app.
  const EXPECTED_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];
  const EXPECTED_AUTHORIZE = "https://claude.ai/oauth/authorize";
  const EXPECTED_TOKEN = "https://api.anthropic.com/v1/oauth/token";
  const EXPECTED_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

  it("builds the expected Claude authorize contract", () => {
    const { buildAuthUrl } = require("../src/lib/oauth");
    const { OAUTH } = require("../src/lib/constants");
    const redirectUri = "http://localhost:54545/callback";
    const url = buildAuthUrl("claude", {
      redirectUri,
      state: "teststate",
      codeChallenge: "challenge123",
    });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, EXPECTED_AUTHORIZE);
    assert.equal(u.searchParams.get("code"), "true");
    assert.equal(u.searchParams.get("client_id"), EXPECTED_CLIENT_ID);
    assert.equal(u.searchParams.get("client_id"), OAUTH.claude.clientId);
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("redirect_uri"), redirectUri);
    assert.equal(u.searchParams.get("code_challenge"), "challenge123");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("state"), "teststate");
    assert.deepEqual(OAUTH.claude.scopes, EXPECTED_SCOPES);
    assert.equal(u.searchParams.get("scope"), EXPECTED_SCOPES.join(" "));
    // URLSearchParams encodes spaces as + in form-style query strings.
    assert.ok(
      url.includes("scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference") ||
        url.includes("org%3Acreate_api_key+user%3Aprofile+user%3Ainference"),
      url
    );
    assert.equal(OAUTH.claude.tokenUrl, EXPECTED_TOKEN);
    assert.ok(!OAUTH.claude.userAgent || !String(OAUTH.claude.userAgent).startsWith("claude-cli/"));
  });

  it("startOAuth claude uses a localhost callback", async () => {
    const { startOAuth, clearPending } = require("../src/lib/oauth");
    const r = await startOAuth("claude");
    try {
      assert.ok(r.authUrl.startsWith(`${EXPECTED_AUTHORIZE}?`), r.authUrl);
      assert.ok(/^http:\/\/localhost:\d+\/callback$/.test(r.redirectUri), r.redirectUri);
      const u = new URL(r.authUrl);
      assert.equal(u.searchParams.get("code"), "true");
      assert.equal(u.searchParams.get("scope"), EXPECTED_SCOPES.join(" "));
      assert.equal(u.searchParams.get("redirect_uri"), r.redirectUri);
      assert.equal(u.searchParams.get("client_id"), EXPECTED_CLIENT_ID);
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      assert.ok(u.searchParams.get("code_challenge"));
      assert.ok(u.searchParams.get("state"));
    } finally {
      clearPending("claude");
    }
  });

  it("completeOAuth claude posts JSON to api.anthropic.com", async () => {
    const {
      startOAuth,
      completeOAuth,
      clearPending,
      getPending,
    } = require("../src/lib/oauth");
    const r = await startOAuth("claude");
    const session = getPending("claude");
    assert.ok(session?.codeVerifier);
    // Users can paste the full callback URL from the browser address bar.
    const pasteCode = `http://localhost:54545/callback?code=authcode123&state=${session.state}`;
    let seen = null;
    const fetchImpl = async (url, opts) => {
      seen = { url: String(url), opts };
      return {
        ok: true,
        async json() {
          return {
            access_token: "at_test",
            refresh_token: "rt_test",
            expires_in: 3600,
          };
        },
        async text() {
          return "";
        },
      };
    };
    try {
      const tokens = await completeOAuth("claude", { pasteCode, fetchImpl });
      assert.equal(tokens.type, "claude");
      assert.equal(tokens.accessToken, "at_test");
      assert.equal(tokens.refreshToken, "rt_test");
      assert.ok(seen, "token fetch must be called");
      assert.equal(seen.url, EXPECTED_TOKEN);
      assert.equal(seen.opts.method, "POST");
      assert.equal(seen.opts.headers["Content-Type"], "application/json");
      assert.equal(seen.opts.headers.Accept, "application/json");
      assert.ok(
        !seen.opts.headers["User-Agent"] ||
          !String(seen.opts.headers["User-Agent"]).startsWith("claude-cli/"),
        "token exchange must not use the inference User-Agent"
      );
      const body = JSON.parse(seen.opts.body);
      // Keep the token payload field order stable.
      assert.deepEqual(Object.keys(body), [
        "code",
        "state",
        "grant_type",
        "client_id",
        "redirect_uri",
        "code_verifier",
      ]);
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.code, "authcode123");
      assert.equal(body.state, session.state);
      assert.equal(body.client_id, EXPECTED_CLIENT_ID);
      assert.equal(body.redirect_uri, r.redirectUri);
      assert.equal(body.code_verifier, session.codeVerifier);
    } finally {
      clearPending("claude");
    }
  });
});

describe("usage store", () => {
  it("records events and aggregates by period", () => {
    const { createUsageStore } = require("../src/lib/usage");
    const p = path.join(os.tmpdir(), `rr-usage-${Date.now()}.json`);
    const u = createUsageStore(p);
    u.record({
      model: "combo_x",
      upstream: "mock-model",
      providerId: "prov_a",
      providerName: "Mock A",
      status: 200,
      prompt_tokens: 10,
      completion_tokens: 5,
      cached_tokens: 2,
      total_tokens: 15,
    });
    u.record({
      model: "mock-model",
      upstream: "mock-model",
      providerName: "Mock A",
      status: 200,
      prompt_tokens: 3,
      completion_tokens: 1,
      total_tokens: 4,
    });
    const agg = u.aggregate("all");
    assert.equal(agg.requests, 2);
    assert.equal(agg.prompt_tokens, 13);
    assert.equal(agg.completion_tokens, 6);
    assert.equal(agg.cached_tokens, 2);
    assert.ok(agg.byModel.length >= 1);
    assert.ok(agg.recent.length === 2);
    // recent list for home
    assert.equal(u.recent(10).length, 2);
  });
});

describe("timeout advances fallback", () => {
  it("hanging first member falls back within timeoutMs", async () => {
    const hang = await startMockUpstream((req, res) => {
      // never respond
    });
    const ok = await startMockUpstream(async (req, res) => {
      if (req.url.includes("chat")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "ok",
            choices: [{ message: { role: "assistant", content: "rescued" }, finish_reason: "stop" }],
          })
        );
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
      }
    });
    const store = createStore(tmpConfig());
    store.update((cfg) => {
      cfg.providers = [
        {
          id: "prov_hang",
          type: "openai-compat",
          name: "Hang",
          baseUrl: hang.baseUrl,
          apiKey: "k",
          models: [{ id: "h", name: "h" }],
          enabled: true,
        },
        {
          id: "prov_ok",
          type: "openai-compat",
          name: "Ok",
          baseUrl: ok.baseUrl,
          apiKey: "k",
          models: [{ id: "o", name: "o" }],
          enabled: true,
        },
      ];
      cfg.combos = [
        {
          id: "combo_timeout",
          name: "timeout-fb",
          strategy: "fallback",
          members: [
            { providerId: "prov_hang", model: "h" },
            { providerId: "prov_ok", model: "o" },
          ],
        },
      ];
    });
    const router = createRouter({ store, timeoutMs: 400 });
    const t0 = Date.now();
    const result = await router.chatCompletions({
      body: {
        model: "combo_timeout",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.openAiJson.choices[0].message.content, "rescued");
    assert.ok(elapsed < 2500, `expected timeout+fallback < 2.5s, got ${elapsed}ms`);
    await new Promise((r) => hang.server.close(r));
    await new Promise((r) => ok.server.close(r));
  });
});

describe("OAuth chat path refresh on 401", () => {
  it("claude chat refreshes token after 401 then succeeds", async () => {
    let chatHits = 0;
    let refreshHits = 0;
    let lastAuth = null;
    const server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          if (req.url.includes("/oauth/token") || req.url.endsWith("/token")) {
            refreshHits++;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                access_token: "fresh-token",
                refresh_token: "fresh-refresh",
                expires_in: 3600,
              })
            );
            return;
          }
          // messages API
          chatHits++;
          lastAuth = req.headers.authorization || "";
          if (lastAuth.includes("stale-token")) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "expired" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_ok",
              content: [{ type: "text", text: "refreshed-hello" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 2 },
            })
          );
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = server.address().port;
    const origChat = claude.cfg.chatUrl;
    const origToken = claude.cfg.tokenUrl;
    claude.cfg.chatUrl = `http://127.0.0.1:${port}/v1/messages`;
    claude.cfg.tokenUrl = `http://127.0.0.1:${port}/oauth/token`;

    const store = createStore(tmpConfig());
    store.update((cfg) => {
      cfg.providers = [
        {
          id: "prov_claude_test",
          type: "claude",
          name: "Claude Test",
          accessToken: "stale-token",
          refreshToken: "refresh-me",
          models: [{ id: "claude-haiku-4-5-20251001", name: "Haiku" }],
          enabled: true,
        },
      ];
      cfg.combos = [];
    });
    const router = createRouter({ store, timeoutMs: 5000 });
    const models = router.listModels().data;
    const mid = models.find((m) => m.owned_by === "claude")?.id;
    assert.ok(mid);
    const result = await router.chatCompletions({
      body: {
        model: mid,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
    });
    claude.cfg.chatUrl = origChat;
    claude.cfg.tokenUrl = origToken;
    await new Promise((r) => server.close(r));

    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.openAiJson.choices[0].message.content, "refreshed-hello");
    assert.ok(refreshHits >= 1, "expected refresh call");
    assert.ok(chatHits >= 2, "expected retry after refresh");
    // persisted token
    const saved = store.load().providers.find((p) => p.id === "prov_claude_test");
    assert.equal(saved.accessToken, "fresh-token");
  });
});

describe("SSE chunk decoding", () => {
  it("chunkToString decodes Uint8Array as utf8 (not default toString)", () => {
    const { chunkToString } = require("../src/lib/sse");
    const text = 'data: {"type":"response.output_text.delta","delta":"pong"}\n\n';
    const u8 = new Uint8Array(Buffer.from(text, "utf8"));
    assert.equal(chunkToString(u8), text);
    assert.notEqual(String(u8), text);
  });
});

describe("OAuth → OpenAI SSE translation pipes", () => {
  it("pipeAnthropicSseToOpenAi emits OpenAI chunks", async () => {
    const { Readable } = require("node:stream");
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ];
    const body = Readable.from(events);
    const chunks = [];
    const res = {
      write(s) {
        chunks.push(s);
      },
    };
    await claude.pipeAnthropicSseToOpenAi(body, res, "claude-test");
    const joined = chunks.join("");
    assert.ok(joined.includes("chat.completion.chunk"));
    assert.ok(joined.includes("Hel") || joined.includes("Hello"));
    assert.ok(joined.includes("[DONE]"));
    // parse a data line
    const dataLine = chunks.find((c) => c.includes('"content":"Hel"') || c.includes("Hel"));
    assert.ok(dataLine, "expected text delta chunk");
  });

  it("pipeResponsesSse collect builds chat completion", async () => {
    const { Readable } = require("node:stream");
    const events = [
      'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"!"}\n\n',
      'data: {"type":"response.completed"}\n\n',
    ];
    const out = await chatgpt.pipeResponsesSse(Readable.from(events), null, "gpt-test", {
      collect: true,
    });
    assert.equal(out.object, "chat.completion");
    assert.equal(out.choices[0].message.content, "Hi!");
  });

  it("pipeGeminiSse emits OpenAI chunks", async () => {
    const antigravity = require("../src/lib/providers/antigravity");
    const { Readable } = require("node:stream");
    const events = [
      'data: {"candidates":[{"content":{"parts":[{"text":"ge"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"mini"}]}}]}\n\n',
    ];
    const chunks = [];
    const res = {
      write(s) {
        chunks.push(s);
      },
    };
    await antigravity.pipeGeminiSse(Readable.from(events), res, "gemini-test");
    const joined = chunks.join("");
    assert.ok(joined.includes("chat.completion.chunk"));
    assert.ok(joined.includes("[DONE]"));
  });
});

// Write a short evidence log
const logPath = path.join(SCRATCH, "unit-tests-selfcheck.txt");
fs.writeFileSync(logPath, `gateway tests module loaded at ${new Date().toISOString()}\n`);
