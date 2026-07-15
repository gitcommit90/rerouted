"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const { listProviderModels, modelIdFor } = require("../src/lib/providers");
const {
  customConnectionNameError,
  customModelRouteConflict,
  ensureUniqueCustomConnectionNames,
} = require("../src/lib/model-ids");
const { resolveSingle } = require("../src/lib/router");

describe("custom provider model ids", () => {
  it("advertises the trimmed connection name and custom namespace", () => {
    const provider = {
      id: "prov_1234567890",
      type: "openai-compat",
      name: "  Local Lab  ",
      enabled: true,
      models: [{ id: "team/model-a", name: "Model A", enabled: true }],
    };

    assert.equal(modelIdFor(provider, "team/model-a"), "Local Lab/custom/team/model-a");
    assert.equal(listProviderModels(provider)[0].id, "Local Lab/custom/team/model-a");
  });

  it("falls back to Custom for legacy blank names", () => {
    assert.equal(
      modelIdFor(
        { id: "prov_abcdef1234", type: "custom", name: "   " },
        "legacy-model"
      ),
      "Custom/custom/legacy-model"
    );
  });

  it("keeps old hash-qualified custom ids resolvable", () => {
    const provider = {
      id: "prov_1234567890",
      type: "openai-compat",
      name: "Local Lab",
      enabled: true,
      models: [{ id: "model-a", name: "Model A", enabled: true }],
    };
    const cfg = { providers: [provider], combos: [] };

    assert.equal(resolveSingle(cfg, "Local Lab/custom/model-a")?.provider.id, provider.id);
    assert.equal(resolveSingle(cfg, "openai-compat/12345678/model-a")?.provider.id, provider.id);
  });

  it("retains hash-qualified ids for named keyed presets", () => {
    assert.equal(
      modelIdFor(
        { id: "prov_1234567890", type: "openrouter", name: "OpenRouter" },
        "model-a"
      ),
      "openrouter/12345678/model-a"
    );
  });

  it("requires an unambiguous custom connection path segment", () => {
    const providers = [{ type: "openai-compat", name: "Local Lab" }];
    assert.equal(customConnectionNameError("", providers), "Custom connection name required");
    assert.equal(
      customConnectionNameError("lab/primary", providers),
      "Custom connection names cannot contain /"
    );
    assert.equal(
      customConnectionNameError(" local lab ", providers),
      "A custom connection named local lab already exists"
    );
    assert.equal(customConnectionNameError("Backup Lab", providers), null);
  });

  it("disambiguates legacy blank, duplicate, and route-colliding connection names", () => {
    const providers = [
      { type: "openai-compat", name: "", models: ["model-a"] },
      { type: "openai-compat", name: "Custom", models: ["model-a"] },
      { type: "openai-compat", name: "Local Lab", models: ["model-a"] },
    ];
    ensureUniqueCustomConnectionNames(providers, [
      { id: "combo_route", name: "Local Lab/custom/model-a" },
    ]);
    assert.deepEqual(
      providers.map((provider) => provider.name),
      ["Custom", "Custom 2", "Local Lab 2"]
    );
    ensureUniqueCustomConnectionNames(providers, []);
    assert.deepEqual(
      providers.map((provider) => provider.name),
      ["Custom", "Custom 2", "Local Lab 2"]
    );
  });

  it("detects a readable custom model id that is already owned by a route", () => {
    assert.deepEqual(
      customModelRouteConflict(
        "Local Lab",
        [{ id: "model-a" }, { id: "model-b" }],
        [{ id: "combo_a", name: "Local Lab/custom/model-b" }]
      ),
      { id: "model-b" }
    );
  });
});
