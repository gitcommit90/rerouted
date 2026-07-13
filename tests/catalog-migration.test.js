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
});
