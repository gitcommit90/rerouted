"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  buildRouteProviderOptions,
  modelsForRouteProvider,
  routeMemberForProvider,
  normalizeRouteMember,
  moveRouteMember,
} = require("../src/renderer/route-picker");

describe("route member picker", () => {
  it("groups enabled OAuth accounts into one provider choice and merges their models", () => {
    const providers = buildRouteProviderOptions([
      {
        id: "prov_a",
        type: "chatgpt",
        name: "ChatGPT Plus",
        accountAlias: "oauth1",
        enabled: true,
        hasToken: true,
        models: [
          { id: "gpt-a", name: "GPT A", gatewayId: "chatgpt/gpt-a", enabled: true },
          { id: "gpt-off", name: "GPT Off", enabled: false },
        ],
      },
      {
        id: "prov_b",
        type: "codex",
        name: "ChatGPT Team",
        accountAlias: "oauth2",
        enabled: true,
        hasToken: true,
        models: [
          { id: "gpt-a", name: "GPT A", enabled: true },
          { id: "gpt-b", name: "GPT B", enabled: true },
        ],
      },
      {
        id: "prov_disabled",
        type: "claude",
        name: "Claude",
        enabled: false,
        hasToken: true,
        models: [{ id: "claude-a", enabled: true }],
      },
      {
        id: "prov_signed_out",
        type: "xai",
        name: "xAI",
        enabled: true,
        hasToken: false,
        models: [{ id: "grok-a", enabled: true }],
      },
    ]);

    assert.deepEqual(providers, [
      {
        id: "provider:chatgpt",
        name: "ChatGPT",
        providerType: "chatgpt",
        providerId: null,
        providerIds: ["prov_a", "prov_b"],
        connectionScoped: false,
        accountCount: 2,
        models: [
          {
            id: "gpt-a",
            name: "GPT A",
            gatewayId: "chatgpt/gpt-a",
            upstreamModel: "gpt-a",
            providerIds: ["prov_a", "prov_b"],
            accountCount: 2,
          },
          {
            id: "gpt-b",
            name: "GPT B",
            gatewayId: null,
            upstreamModel: "gpt-b",
            providerIds: ["prov_b"],
            accountCount: 1,
          },
        ],
      },
    ]);
  });

  it("keeps custom endpoints distinct because a connection is its provider", () => {
    const providers = buildRouteProviderOptions([
      {
        id: "prov_local",
        type: "openai-compat",
        name: "Local Lab",
        enabled: true,
        hasToken: true,
        models: ["local-model"],
      },
      {
        id: "prov_backup",
        type: "custom",
        name: "Backup Lab",
        enabled: true,
        hasToken: true,
        models: ["backup-model"],
      },
    ]);

    assert.deepEqual(
      providers.map(({ id, name, providerId, connectionScoped, models }) => ({
        id,
        name,
        providerId,
        connectionScoped,
        models: models.map((model) => model.upstreamModel),
      })),
      [
        {
          id: "connection:prov_local",
          name: "Local Lab",
          providerId: "prov_local",
          connectionScoped: true,
          models: ["local-model"],
        },
        {
          id: "connection:prov_backup",
          name: "Backup Lab",
          providerId: "prov_backup",
          connectionScoped: true,
          models: ["backup-model"],
        },
      ]
    );
  });

  it("creates account-agnostic members and upgrades legacy account-specific members", () => {
    const providers = buildRouteProviderOptions([
      {
        id: "prov_a",
        type: "xai",
        name: "xAI",
        enabled: true,
        hasToken: true,
        models: ["grok-4.5"],
      },
    ]);
    const provider = providers[0];
    assert.deepEqual(routeMemberForProvider(provider, "grok-4.5"), {
      providerType: "xai",
      model: "grok-4.5",
    });
    assert.deepEqual(normalizeRouteMember({ providerId: "prov_a", model: "grok-4.5" }, providers), {
      providerType: "xai",
      model: "grok-4.5",
    });
    assert.deepEqual(
      modelsForRouteProvider(providers, "provider:xai").map((model) => model.upstreamModel),
      ["grok-4.5"]
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
