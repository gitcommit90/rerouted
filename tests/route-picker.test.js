"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  buildRouteAccountOptions,
  modelsForRouteAccount,
  moveRouteMember,
} = require("../src/renderer/route-picker");

describe("route member picker", () => {
  it("exposes only enabled accounts with enabled models", () => {
    const accounts = buildRouteAccountOptions([
      {
        id: "prov_a",
        type: "chatgpt",
        name: "ChatGPT",
        accountAlias: "oauth1",
        enabled: true,
        models: [
          { id: "gpt-a", name: "GPT A", gatewayId: "chatgpt/gpt-a", enabled: true },
          { id: "gpt-off", name: "GPT Off", enabled: false },
        ],
      },
      {
        id: "prov_b",
        type: "claude",
        name: "Claude",
        enabled: false,
        models: [{ id: "claude-a", enabled: true }],
      },
      {
        id: "prov_empty",
        type: "xai",
        name: "xAI",
        enabled: true,
        models: [{ id: "grok-off", enabled: false }],
      },
      {
        id: "prov_custom",
        type: "openai-compat",
        name: "Local Lab",
        enabled: true,
        models: ["local-model"],
      },
    ]);

    assert.deepEqual(
      accounts.map((account) => account.id),
      ["prov_a", "prov_custom"]
    );
    assert.deepEqual(accounts[0], {
      id: "prov_a",
      name: "ChatGPT",
      accountAlias: "oauth1",
      providerType: "chatgpt",
      models: [
        {
          id: "gpt-a",
          name: "GPT A",
          gatewayId: "chatgpt/gpt-a",
          providerId: "prov_a",
          upstreamModel: "gpt-a",
        },
      ],
    });
  });

  it("returns models only for the selected account", () => {
    const accounts = buildRouteAccountOptions([
      { id: "prov_a", name: "A", models: ["model-a"] },
      { id: "prov_b", name: "B", models: ["model-b"] },
    ]);

    assert.deepEqual(
      modelsForRouteAccount(accounts, "prov_b").map((model) => model.upstreamModel),
      ["model-b"]
    );
    assert.deepEqual(modelsForRouteAccount(accounts, "missing"), []);
    assert.deepEqual(modelsForRouteAccount(accounts, null), []);
  });

  it("numbers duplicate keyed connections without exposing internal ids", () => {
    const accounts = buildRouteAccountOptions([
      { id: "prov_private_a", type: "openrouter", name: "OpenRouter", models: ["a"] },
      { id: "prov_private_b", type: "openrouter", name: "OpenRouter", models: ["b"] },
    ]);

    assert.deepEqual(
      accounts.map(({ connectionIndex, connectionCount }) => ({
        connectionIndex,
        connectionCount,
      })),
      [
        { connectionIndex: 1, connectionCount: 2 },
        { connectionIndex: 2, connectionCount: 2 },
      ]
    );
  });

  it("moves a route member to the requested position for drag or keyboard controls", () => {
    const members = [{ model: "a" }, { model: "b" }, { model: "c" }];
    assert.equal(moveRouteMember(members, 0, 2), members);
    assert.deepEqual(members.map((member) => member.model), ["b", "c", "a"]);
    moveRouteMember(members, 2, 1);
    assert.deepEqual(members.map((member) => member.model), ["b", "a", "c"]);
    moveRouteMember(members, -1, 4);
    assert.deepEqual(members.map((member) => member.model), ["b", "a", "c"]);
  });
});
