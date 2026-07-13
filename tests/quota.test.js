"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  parseCodexQuota,
  parseClaudeQuota,
  parseAntigravityQuota,
  parseAntigravityQuotaBuckets,
  fetchProviderQuota,
  createQuotaService,
} = require("../src/lib/quota");

function response(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  };
}

describe("quota parsing", () => {
  it("maps Codex session/weekly windows and credits", () => {
    const parsed = parseCodexQuota({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 72, reset_at: 2_000_000_000, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 31, reset_at: 2_000_100_000, limit_window_seconds: 604800 },
      },
      credits: { has_credits: true, unlimited: false, balance: "12.5" },
    });
    assert.equal(parsed.plan, "plus");
    assert.equal(parsed.windows.length, 2);
    assert.equal(parsed.windows[0].remainingPercent, 28);
    assert.equal(parsed.windows[0].resetsAt, 2_000_000_000_000);
    assert.equal(parsed.credits.balance, 12.5);
  });

  it("maps Claude OAuth windows and scoped limits", () => {
    const parsed = parseClaudeQuota({
      subscription_type: "max",
      five_hour: { utilization: 44, resets_at: "2030-01-01T01:00:00Z" },
      seven_day: { utilization: 67, resets_at: "2030-01-05T01:00:00Z" },
      limits: [
        {
          is_active: true,
          percent: 20,
          resets_at: "2030-01-05T01:00:00Z",
          scope: { model: { display_name: "Opus" } },
        },
      ],
    });
    assert.equal(parsed.plan, "max");
    assert.deepEqual(parsed.windows.map((w) => w.label), ["Session", "Weekly", "Opus"]);
  });

  it("supports Claude OAuth-app/routines aliases and converts credit cents", () => {
    const parsed = parseClaudeQuota({
      seven_day_oauth_apps: { utilization: 25, resets_at: "2030-01-05T01:00:00Z" },
      seven_day_claude_routines: { utilization: 40, resets_at: "2030-01-06T01:00:00Z" },
      extra_usage: {
        is_enabled: true,
        used_credits: 1234,
        monthly_limit: 200000,
        currency: "USD",
      },
    });
    assert.deepEqual(parsed.windows.map((w) => w.label), ["Weekly", "Routines weekly"]);
    assert.equal(parsed.credits.used, 12.34);
    assert.equal(parsed.credits.limit, 2000);
  });

  it("maps Antigravity model remaining fractions", () => {
    const parsed = parseAntigravityQuota(
      {
        models: {
          "gemini-pro-agent": {
            displayName: "Gemini Pro",
            quotaInfo: { remainingFraction: 0.6, resetTime: "2030-01-01T00:00:00Z" },
          },
        },
      },
      { currentTier: { name: "Pro" } }
    );
    assert.equal(parsed.plan, "Pro");
    assert.equal(parsed.windows[0].usedPercent, 40);
    assert.equal(parsed.windows[0].remainingPercent, 60);
  });

  it("keeps the lowest Antigravity quota bucket per model", () => {
    const parsed = parseAntigravityQuotaBuckets({
      buckets: [
        { modelId: "gemini-pro-agent", remainingFraction: 0.8 },
        { modelId: "gemini-pro-agent", remainingFraction: 0.35 },
      ],
    });
    assert.equal(parsed.models["gemini-pro-agent"].quotaInfo.remainingFraction, 0.35);
  });

  it("verifies Antigravity availability-only data with retrieveUserQuota", async () => {
    const calls = [];
    const result = await fetchProviderQuota(
      {
        type: "antigravity",
        accessToken: "token",
        projectId: "project",
        models: [{ id: "gemini-pro-agent" }],
      },
      {
        fetchImpl: async (url) => {
          calls.push(url);
          if (url.includes("loadCodeAssist")) return response({ currentTier: { name: "Pro" } });
          if (url.includes("fetchAvailableModels")) {
            return response({
              models: {
                "gemini-pro-agent": {
                  quotaInfo: { remainingFraction: 1, resetTime: "2030-01-01T00:00:00Z" },
                },
              },
            });
          }
          return response({
            buckets: [
              {
                modelId: "gemini-pro-agent",
                remainingFraction: 0.4,
                resetTime: "2030-01-01T00:00:00Z",
              },
            ],
          });
        },
      }
    );
    assert.equal(result.windows[0].usedPercent, 60);
    assert.ok(calls.some((url) => url.includes("retrieveUserQuota")));
  });

  it("falls back to retrieveUserQuota when fetchAvailableModels is forbidden", async () => {
    const result = await fetchProviderQuota(
      {
        type: "antigravity",
        accessToken: "token",
        projectId: "project",
        models: [{ id: "gemini-pro-agent" }],
      },
      {
        fetchImpl: async (url) => {
          if (url.includes("loadCodeAssist")) return response({ currentTier: { name: "Pro" } });
          if (url.includes("fetchAvailableModels")) return response({ error: "forbidden" }, 403);
          return response({
            buckets: [{ modelId: "gemini-pro-agent", remainingFraction: 0.2 }],
          });
        },
      }
    );
    assert.equal(result.windows[0].usedPercent, 80);
  });
});

describe("quota service", () => {
  it("returns per-account aliases and isolates unsupported providers", async () => {
    const store = {
      load: () => ({
        providers: [
          {
            id: "p1",
            type: "chatgpt",
            name: "ChatGPT",
            accountAlias: "oauth1",
            profileName: "Fantastic Fox",
            accessToken: "token",
            enabled: true,
          },
          {
            id: "p2",
            type: "xai",
            name: "Grok",
            accountAlias: "oauth1",
            accessToken: "token",
            enabled: true,
          },
        ],
      }),
    };
    const service = createQuotaService({
      store,
      fetchImpl: async () =>
        response({
          rate_limit: {
            primary_window: { used_percent: 10, reset_at: 2_000_000_000 },
          },
        }),
      now: () => 1234,
    });
    const snapshot = await service.refresh();
    assert.equal(snapshot.accounts[0].accountAlias, "oauth1");
    assert.equal(snapshot.accounts[0].profileName, "Fantastic Fox");
    assert.equal(snapshot.accounts[0].status, "ok");
    assert.equal(snapshot.accounts[1].status, "unsupported");
  });
});
