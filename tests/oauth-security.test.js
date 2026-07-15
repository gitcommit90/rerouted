"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  clearPending,
  completeOAuth,
  escapeHtml,
  getPending,
  parseOAuthCallback,
  startOAuth,
  statesMatch,
} = require("../src/lib/oauth");

describe("OAuth callback security", () => {
  it("compares non-empty state values without accepting length or value mismatches", () => {
    assert.equal(statesMatch("expected", "expected"), true);
    assert.equal(statesMatch("expected", "attacker"), false);
    assert.equal(statesMatch("expected", "short"), false);
    assert.equal(statesMatch("", ""), false);
  });

  it("requires the exact callback path and expected state", () => {
    const options = {
      baseUrl: "http://localhost:54545",
      callbackPath: "/callback",
      expectedState: "expected-state",
    };

    assert.equal(
      parseOAuthCallback("/wrong?code=abc&state=expected-state", options).status,
      404
    );
    assert.equal(parseOAuthCallback("/callback?code=abc", options).status, 400);
    assert.equal(
      parseOAuthCallback("/callback?code=abc&state=wrong-state", options).status,
      400
    );

    const valid = parseOAuthCallback(
      "/callback?code=abc&state=expected-state",
      options
    );
    assert.equal(valid.ok, true);
    assert.equal(valid.code, "abc");
    assert.equal(valid.state, "expected-state");
  });

  it("escapes provider-controlled callback text before rendering it", () => {
    assert.equal(
      escapeHtml('<img src=x onerror="alert(1)">'),
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
  });

  it("rejects a pasted callback with a mismatched state before token exchange", async () => {
    await startOAuth("claude");
    let fetched = false;
    try {
      await assert.rejects(
        completeOAuth("claude", {
          pasteCode: "http://localhost:54545/callback?code=attacker-code&state=wrong-state",
          fetchImpl: async () => {
            fetched = true;
            throw new Error("must not fetch");
          },
        }),
        /OAuth state mismatch/
      );
      assert.equal(fetched, false);
    } finally {
      clearPending("claude");
    }
  });

  it("does not combine a plain pasted code with state from an earlier callback", async () => {
    await startOAuth("antigravity");
    const session = getPending("antigravity");
    session.callbackState = session.state;
    let fetched = false;
    try {
      await assert.rejects(
        completeOAuth("antigravity", {
          pasteCode: "unrelated-plain-code",
          fetchImpl: async () => {
            fetched = true;
            throw new Error("must not fetch");
          },
        }),
        /OAuth state mismatch/
      );
      assert.equal(fetched, false);
    } finally {
      clearPending("antigravity");
    }
  });

  it("accepts the standalone code shown by xAI for the active PKCE session", async () => {
    const started = await startOAuth("xai");
    const session = getPending("xai");
    let tokenRequest;
    try {
      const account = await completeOAuth("xai", {
        pasteCode: "xai-provider-displayed-code",
        fetchImpl: async (url, options) => {
          tokenRequest = { url: String(url), options };
          return {
            ok: true,
            async json() {
              return {
                access_token: "xai-access-token",
                refresh_token: "xai-refresh-token",
                expires_in: 3600,
              };
            },
            async text() {
              return "";
            },
          };
        },
      });

      const body = new URLSearchParams(tokenRequest.options.body);
      assert.equal(account.type, "xai");
      assert.equal(tokenRequest.url, "https://auth.x.ai/oauth2/token");
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("code"), "xai-provider-displayed-code");
      assert.equal(body.get("redirect_uri"), started.redirectUri);
      assert.equal(body.get("code_verifier"), session.codeVerifier);
    } finally {
      clearPending("xai");
    }
  });

  it("still rejects an xAI callback URL with a mismatched state", async () => {
    const started = await startOAuth("xai");
    let fetched = false;
    try {
      const callback = new URL(started.redirectUri);
      callback.searchParams.set("code", "xai-authorization-code");
      callback.searchParams.set("state", "wrong-state");
      await assert.rejects(
        completeOAuth("xai", {
          pasteCode: callback.toString(),
          fetchImpl: async () => {
            fetched = true;
            throw new Error("must not fetch");
          },
        }),
        /OAuth state mismatch/
      );
      assert.equal(fetched, false);
    } finally {
      clearPending("xai");
    }
  });

  it("explains that the xAI authorization URL is not a completion result", async () => {
    const started = await startOAuth("xai");
    let fetched = false;
    try {
      await assert.rejects(
        completeOAuth("xai", {
          pasteCode: started.authUrl,
          fetchImpl: async () => {
            fetched = true;
            throw new Error("must not fetch");
          },
        }),
        /does not contain an authorization code/
      );
      assert.equal(fetched, false);
    } finally {
      clearPending("xai");
    }
  });

  it("completes state-bound ChatGPT, Antigravity, and xAI callback flows", async () => {
    for (const type of ["chatgpt", "antigravity", "xai"]) {
      const started = await startOAuth(type);
      const session = getPending(type);
      const callback = new URL(started.redirectUri);
      callback.searchParams.set("code", `${type}-authorization-code`);
      callback.searchParams.set("state", session.state);
      const requests = [];
      try {
        const account = await completeOAuth(type, {
          pasteCode: callback.toString(),
          fetchImpl: async (url) => {
            requests.push(String(url));
            if (String(url).includes("userinfo")) {
              return {
                ok: true,
                async json() {
                  return { email: "person@example.com", name: "Example Person" };
                },
              };
            }
            return {
              ok: true,
              async json() {
                return {
                  access_token: `${type}-access-token`,
                  refresh_token: `${type}-refresh-token`,
                  expires_in: 3600,
                };
              },
              async text() {
                return "";
              },
            };
          },
        });

        assert.equal(account.type, type);
        assert.equal(account.accessToken, `${type}-access-token`);
        assert.ok(requests.length >= 1);
      } finally {
        clearPending(type);
      }
    }
  });
});
