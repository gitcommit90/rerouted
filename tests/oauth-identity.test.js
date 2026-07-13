"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  decodeJwtPayload,
  identityFromProfile,
  identityFromTokens,
} = require("../src/lib/oauth-identity");
const { backfillLocalOAuthIdentities, localXaiIdentity } = require("../src/lib/detect");
const { migrate } = require("../src/lib/store");
const xai = require("../src/lib/providers/xai");
const { backfillClaudeProfiles } = require("../src/lib/oauth");

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("OAuth account identity", () => {
  it("extracts ChatGPT profile and account claims from an access JWT", () => {
    const accessToken = jwt({
      "https://api.openai.com/profile": {
        email: "fantasticfox@gmail.com",
        name: "Fantastic Fox",
      },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
    });

    assert.deepEqual(identityFromTokens("chatgpt", { accessToken }), {
      email: "fantasticfox@gmail.com",
      profileName: "Fantastic Fox",
      accountId: "acct_123",
    });
  });

  it("never treats a generic ChatGPT subject as the request account id", () => {
    assert.deepEqual(identityFromTokens("chatgpt", { accessToken: jwt({ sub: "user-123" }) }), {});
  });

  it("combines xAI OIDC identity claims with the access-token principal", () => {
    const identity = identityFromTokens("xai", {
      id_token: jwt({ email: "fox@x.ai", name: "Fox", sub: "oidc-user" }),
      access_token: jwt({ principal_id: "principal-123" }),
    });

    assert.deepEqual(identity, {
      email: "fox@x.ai",
      profileName: "Fox",
      accountId: "oidc-user",
    });
    assert.equal(decodeJwtPayload("not-a-jwt"), null);
  });

  it("does not erase stored identity when a refresh response has no identity claims", async () => {
    const provider = {
      refreshToken: "refresh-token",
      email: "saved@example.com",
      profileName: "Saved Account",
      accountId: "saved-account",
    };
    const tokens = await xai.refreshToken(provider, {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return { access_token: "opaque-access-token", expires_in: 3600 };
        },
      }),
    });

    assert.equal(Object.hasOwn(tokens, "email"), false);
    assert.equal(Object.hasOwn(tokens, "profileName"), false);
    assert.equal(Object.hasOwn(tokens, "accountId"), false);
    Object.assign(provider, tokens);
    assert.equal(provider.email, "saved@example.com");
    assert.equal(provider.profileName, "Saved Account");
    assert.equal(provider.accountId, "saved-account");
  });

  it("normalizes Claude profile response variants", () => {
    assert.deepEqual(
      identityFromProfile("claude", {
        email_address: "claude@example.com",
        tokenAccount: { uuid: "account-1" },
        organization: { name: "Example Org" },
      }),
      {
        email: "claude@example.com",
        profileName: "Example Org",
        accountId: "account-1",
      }
    );
  });

  it("backfills already-connected Claude accounts from the profile endpoint", async () => {
    const providers = [
      {
        id: "claude-1",
        type: "claude",
        accessToken: "expired-access",
        refreshToken: "refresh-1",
        expiresAt: 1,
      },
      {
        id: "claude-2",
        type: "claude",
        accessToken: "access-2",
        email: "complete@example.com",
        profileName: "Complete",
      },
      { id: "xai-1", type: "xai", accessToken: "access-3" },
    ];
    const calls = [];
    const changed = await backfillClaudeProfiles(providers, {
      fetchImpl: async (_url, options) => {
        calls.push(options.headers.Authorization);
        return {
          ok: true,
          async json() {
            return { email_address: "existing@example.com", name: "Existing Claude" };
          },
        };
      },
      refreshImpl: async () => ({
        accessToken: "fresh-access",
        refreshToken: "refresh-2",
        expiresAt: Date.now() + 3_600_000,
      }),
    });

    assert.equal(changed, true);
    assert.deepEqual(calls, ["Bearer fresh-access"]);
    assert.equal(providers[0].accessToken, "fresh-access");
    assert.equal(providers[0].refreshToken, "refresh-2");
    assert.equal(providers[0].email, "existing@example.com");
    assert.equal(providers[0].profileName, "Existing Claude");
    assert.equal(providers[1].email, "complete@example.com");
    assert.equal(providers[2].email, undefined);
  });

  it("backfills legacy ChatGPT accounts locally during config migration", () => {
    const accessToken = jwt({
      "https://api.openai.com/profile": { email: "legacy@example.com", name: "Legacy" },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_legacy" },
    });
    const provider = migrate({
      version: 6,
      providers: [{ id: "prov_chatgpt", type: "chatgpt", accessToken, models: [] }],
      combos: [],
    }).providers[0];

    assert.equal(provider.email, "legacy@example.com");
    assert.equal(provider.profileName, "Legacy");
    assert.equal(provider.accountId, "acct_legacy");
  });

  it("removes a duplicated raw email from legacy OAuth provider names", () => {
    const provider = migrate({
      version: 6,
      providers: [
        {
          id: "prov_antigravity",
          type: "antigravity",
          name: "Antigravity (legacy@example.com)",
          email: "legacy@example.com",
          models: [],
        },
      ],
      combos: [],
    }).providers[0];

    assert.equal(provider.name, "Antigravity");
    assert.equal(provider.email, "legacy@example.com");
  });

  it("matches a legacy xAI account to local Grok identity data without copying secrets", () => {
    const accessToken = jwt({ principal_id: "principal-123", sub: "subject-123" });
    const localToken = jwt({ principal_id: "principal-123" });
    const authData = {
      account: {
        key: localToken,
        refresh_token: "local-refresh-secret",
        principal_id: "principal-123",
        email: "local@example.com",
        first_name: "Local Fox",
      },
    };
    const provider = { type: "xai", accessToken, refreshToken: "rerouted-refresh-secret" };

    assert.deepEqual(localXaiIdentity(provider, authData), {
      email: "local@example.com",
      profileName: "Local Fox",
      accountId: "principal-123",
    });
    assert.equal(backfillLocalOAuthIdentities([provider], { xaiAuthData: authData }), true);
    assert.equal(provider.email, "local@example.com");
    assert.equal(provider.profileName, "Local Fox");
    assert.equal(provider.refreshToken, "rerouted-refresh-secret");
    assert.equal(provider.key, undefined);
  });
});
