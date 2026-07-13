"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { OAUTH } = require("../src/lib/constants");
const { migrate } = require("../src/lib/store");

function migrateProvider(provider) {
  return migrate({ providers: [provider], combos: [] }).providers[0];
}

describe("OAuth catalog migration", () => {
  it("removes retired built-ins while preserving current state and custom models", () => {
    const provider = migrateProvider({
      id: "prov_chatgpt",
      type: "chatgpt",
      models: [
        { id: "gpt-5.4", name: "GPT 5.4", enabled: false },
        { id: "gpt-5.3-codex", name: "GPT 5.3 Codex", enabled: true },
        { id: "my-private-model", name: "Private model", enabled: false },
      ],
    });

    assert.deepEqual(
      provider.models.slice(0, OAUTH.chatgpt.models.length).map((model) => model.id),
      OAUTH.chatgpt.models.map((model) => model.id)
    );
    assert.equal(provider.models.some((model) => model.id === "gpt-5.3-codex"), false);
    assert.equal(provider.models.find((model) => model.id === "gpt-5.4").enabled, false);
    assert.deepEqual(provider.models.find((model) => model.id === "my-private-model"), {
      id: "my-private-model",
      name: "Private model",
      enabled: false,
    });
  });

  it("cleans every retired OAuth catalog without removing unknown IDs", () => {
    const cases = [
      ["claude", "claude-sonnet-4-6"],
      ["antigravity", "gemini-3-flash"],
      ["xai", "grok-code-fast-1"],
      ["codex", "gpt-5.3-codex"],
    ];

    for (const [type, retiredId] of cases) {
      const provider = migrateProvider({
        id: `prov_${type}`,
        type,
        models: [retiredId, `${type}-custom-model`],
      });
      assert.equal(provider.models.some((model) => model.id === retiredId), false, type);
      assert.equal(
        provider.models.some((model) => model.id === `${type}-custom-model`),
        true,
        type
      );
    }
  });

  it("does not apply OAuth cleanup to keyed providers", () => {
    const provider = migrateProvider({
      id: "prov_custom",
      type: "openai-compat",
      models: ["gpt-5.3-codex", "grok-3"],
    });

    assert.deepEqual(
      provider.models.map((model) => model.id),
      ["gpt-5.3-codex", "grok-3"]
    );
  });

  it("clears pre-fix xAI locks once without clearing other providers or future xAI locks", () => {
    const oldLock = {
      until: Date.now() + 60_000,
      status: 429,
      kind: "quota",
      reason: "usage limit reached",
    };
    const migrated = migrate({
      version: 5,
      providers: [
        { id: "prov_xai", type: "xai", models: [], modelLocks: { "*": oldLock } },
        { id: "prov_claude", type: "claude", models: [], modelLocks: { "*": oldLock } },
      ],
      combos: [],
    });

    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.providers[0].modelLocks, {});
    assert.deepEqual(migrated.providers[1].modelLocks, { "*": oldLock });

    const newLock = { ...oldLock, reason: "new transport response" };
    migrated.providers[0].modelLocks = { "*": newLock };
    assert.deepEqual(migrate(migrated).providers[0].modelLocks, { "*": newLock });
  });

  it("preserves alias high-water marks after every account is removed", () => {
    const cfg = migrate({
      version: 6,
      providers: [],
      providerAliasCounters: { xai: 7 },
      combos: [],
    });
    assert.equal(cfg.providerAliasCounters.xai, 7);

    cfg.providers.push({ id: "prov_new", type: "xai", models: [] });
    const next = migrate(cfg);
    assert.equal(next.providers[0].accountAlias, "oauth8");
    assert.equal(next.providerAliasCounters.xai, 8);
  });
});
