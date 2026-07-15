"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { createStore } = require("../src/lib/store");
const { createRouter } = require("../src/lib/router");
const {
  publicCombo,
  comboMatchesId,
  publicRouteId,
  providerRouteIds,
  comboStorageIdConflict,
  ensureUniqueComboNames,
  comboNameConflict,
} = require("../src/lib/combos");

describe("public combo identity", () => {
  it("exposes the user-given name without leaking the generated storage id", () => {
    const stored = { id: "combo_83b27a85ecbc", name: "My Fast Route", strategy: "fallback" };
    assert.deepEqual(publicCombo(stored), {
      id: "My Fast Route",
      name: "My Fast Route",
      strategy: "fallback",
      storageId: "combo_83b27a85ecbc",
    });
    assert.equal(comboMatchesId(stored, "My Fast Route"), true);
    assert.equal(comboMatchesId(stored, "combo_83b27a85ecbc"), true);
  });

  it("detects duplicate public names while excluding the route being edited", () => {
    const combos = [
      { id: "combo_a", name: "Coding" },
      { id: "combo_b", name: "Research" },
    ];
    assert.equal(comboNameConflict(combos, " coding ")?.id, "combo_a");
    assert.equal(comboNameConflict(combos, "coding", 0), null);
  });

  it("maps stored ids to their public route names for activity displays", () => {
    const combos = [{ id: "combo_83b27a85ecbc", name: "coding" }];
    assert.equal(publicRouteId(combos, "combo_83b27a85ecbc"), "coding");
    assert.equal(publicRouteId(combos, "coding"), "coding");
    assert.equal(publicRouteId(combos, "gpt-5"), "gpt-5");
  });

  it("gives duplicate and colliding names deterministic public identities", () => {
    const combos = [
      { id: "combo_a", name: "Coding" },
      { id: "combo_b", name: "coding" },
      { id: "combo_c", name: "coding-2" },
      { id: "combo_d", name: "gpt-5" },
      { id: "combo_e", name: "combo_a" },
    ];
    ensureUniqueComboNames(combos, new Set(["gpt-5"]));
    assert.deepEqual(
      combos.map((combo) => combo.name),
      ["Coding", "coding-3", "coding-2", "gpt-5-2", "combo_a-2"]
    );
  });

  it("reserves provider routes and internal combo ids from public route names", () => {
    const providerIds = providerRouteIds([
      {
        id: "prov_1234567890",
        type: "chatgpt",
        accountAlias: "oauth1",
        models: [{ id: "gpt-5", enabled: true }],
      },
      {
        id: "prov_abcdef1234",
        type: "openai-compat",
        name: "  Local Lab  ",
        models: [{ id: "private-model", enabled: true }],
      },
    ]);
    assert.equal(providerIds.has("gpt-5"), true);
    assert.equal(providerIds.has("chatgpt/gpt-5"), true);
    assert.equal(providerIds.has("chatgpt/oauth1/gpt-5"), true);
    assert.equal(providerIds.has("chatgpt/12345678/gpt-5"), true);
    assert.equal(providerIds.has("local lab/custom/private-model"), true);
    assert.equal(providerIds.has("openai-compat/abcdef12/private-model"), true);
    assert.equal(comboStorageIdConflict([{ id: "combo_a", name: "Coding" }], "combo_a")?.id, "combo_a");
  });

  it("normalizes stored configs so every advertised route remains addressable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-combos-"));
    try {
      const store = createStore(path.join(dir, "config.json"));
      const cfg = store.seed({
        version: 4,
        providers: [
          {
            id: "prov_1234567890",
            type: "openai-compat",
            enabled: true,
            models: [{ id: "gpt-5", enabled: true }],
          },
        ],
        combos: [
          { id: "combo_a", name: "Coding", members: [] },
          { id: "combo_b", name: "coding", members: [] },
          { id: "combo_c", name: "gpt-5", members: [] },
        ],
      });
      assert.deepEqual(
        cfg.combos.map((combo) => combo.name),
        ["Coding", "coding-2", "gpt-5-2"]
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a route authoritative when a later provider adds the same public model id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-combo-provider-"));
    try {
      const store = createStore(path.join(dir, "config.json"));
      store.update((cfg) => {
        cfg.combos.push({
          id: "combo_coding",
          name: "chatgpt/gpt-5",
          strategy: "fallback",
          members: [{ providerId: "prov_chatgpt", model: "gpt-5" }],
        });
      });
      store.update((cfg) => {
        cfg.providers.push({
          id: "prov_chatgpt",
          type: "chatgpt",
          enabled: true,
          models: [{ id: "gpt-5", enabled: true }],
        });
      });

      const router = createRouter({ store });
      const matching = router
        .listModels()
        .data.filter((model) => model.id.toLowerCase() === "chatgpt/gpt-5");
      assert.equal(matching.length, 1);
      assert.equal(matching[0].combo, true);
      assert.equal(router.resolveTargets(store.load(), "chatgpt/gpt-5").kind, "combo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
