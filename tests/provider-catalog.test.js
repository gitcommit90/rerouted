"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildEnabledProviderGroups,
  buildProviderCatalog,
  canonicalProviderType,
} = require("../src/renderer/provider-catalog");

describe("provider-first catalog", () => {
  it("canonicalizes legacy OAuth and custom keyed provider types", () => {
    assert.equal(canonicalProviderType("codex"), "chatgpt");
    assert.equal(canonicalProviderType("openai-compat"), "custom");
    assert.equal(canonicalProviderType("custom"), "custom");
    assert.equal(canonicalProviderType("claude"), "claude");
  });

  it("includes every named provider plus Custom before any accounts are connected", () => {
    const catalog = buildProviderCatalog({
      oauthProviders: [
        { id: "chatgpt", name: "ChatGPT" },
        { id: "claude", name: "Claude" },
        { id: "antigravity", name: "Antigravity" },
        { id: "xai", name: "xAI (Grok)" },
      ],
      keyedPresets: [
        { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
        { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
        { id: "cloudflare", name: "Cloudflare", baseUrl: "https://api.cloudflare.com" },
        { id: "glm", name: "GLM Coding", baseUrl: "https://api.z.ai" },
      ],
      providers: [],
    });

    assert.deepEqual(
      catalog.map(({ id, name, kind, accounts }) => ({ id, name, kind, accounts })),
      [
        { id: "chatgpt", name: "ChatGPT", kind: "oauth", accounts: [] },
        { id: "claude", name: "Claude", kind: "oauth", accounts: [] },
        { id: "antigravity", name: "Antigravity", kind: "oauth", accounts: [] },
        { id: "xai", name: "xAI (Grok)", kind: "oauth", accounts: [] },
        { id: "openrouter", name: "OpenRouter", kind: "keyed", accounts: [] },
        { id: "nvidia", name: "NVIDIA NIM", kind: "keyed", accounts: [] },
        { id: "cloudflare", name: "Cloudflare", kind: "keyed", accounts: [] },
        { id: "glm", name: "GLM Coding", kind: "keyed", accounts: [] },
        { id: "custom", name: "Custom", kind: "custom", accounts: [] },
      ]
    );
    assert.equal(catalog[0].oauthType, "chatgpt");
    assert.equal(catalog[4].preset.id, "openrouter");
  });

  it("groups 0-N connected accounts under their canonical providers", () => {
    const providers = [
      { id: "oauth1", type: "codex", name: "ChatGPT account one" },
      { id: "oauth2", type: "chatgpt", name: "ChatGPT account two" },
      { id: "prov_1", type: "openrouter", name: "OpenRouter primary" },
      { id: "prov_2", type: "openai-compat", name: "Local endpoint" },
      { id: "prov_3", type: "custom", name: "Backup endpoint" },
    ];
    const catalog = buildProviderCatalog({
      oauthProviders: [
        { id: "chatgpt", name: "ChatGPT" },
        { id: "claude", name: "Claude" },
      ],
      keyedPresets: [{ id: "openrouter", name: "OpenRouter" }],
      providers,
    });

    assert.deepEqual(
      catalog.find((entry) => entry.id === "chatgpt").accounts,
      providers.slice(0, 2)
    );
    assert.deepEqual(
      catalog.find((entry) => entry.id === "openrouter").accounts,
      providers.slice(2, 3)
    );
    assert.deepEqual(
      catalog.find((entry) => entry.id === "custom").accounts,
      providers.slice(3)
    );
    assert.deepEqual(catalog.find((entry) => entry.id === "claude").accounts, []);
  });

  it("preserves unknown connected provider types as additional grouped entries", () => {
    const providers = [
      { id: "legacy_1", type: "legacy-cloud", name: "Legacy Cloud" },
      { id: "legacy_2", type: "legacy-cloud", name: "Legacy Cloud backup" },
      { id: "mystery_1", type: "mystery_provider" },
    ];
    const catalog = buildProviderCatalog({ providers });

    assert.deepEqual(catalog.map((entry) => entry.id), [
      "custom",
      "legacy-cloud",
      "mystery_provider",
    ]);
    assert.deepEqual(catalog[1], {
      id: "legacy-cloud",
      name: "Legacy Cloud",
      kind: "unknown",
      accounts: providers.slice(0, 2),
    });
    assert.equal(catalog[2].name, "Mystery Provider");
    assert.deepEqual(catalog[2].accounts, providers.slice(2));
  });

  it("builds one enabled live node per canonical provider, not per account", () => {
    const providers = [
      { id: "chatgpt_one", type: "chatgpt", enabled: true, hasToken: true },
      { id: "chatgpt_two", type: "codex", enabled: true, hasToken: true },
      { id: "claude_disabled", type: "claude", enabled: false, hasToken: true },
      { id: "xai_signed_out", type: "xai", enabled: true, hasToken: false },
      { id: "custom_one", type: "openai-compat", enabled: true, hasToken: true },
      { id: "custom_two", type: "custom", enabled: true, hasToken: true },
    ];

    const groups = buildEnabledProviderGroups(providers);

    assert.deepEqual(groups.map((group) => group.id), ["chatgpt", "custom"]);
    assert.deepEqual(groups[0].accounts, providers.slice(0, 2));
    assert.deepEqual(groups[1].accounts, providers.slice(4));
  });
});
