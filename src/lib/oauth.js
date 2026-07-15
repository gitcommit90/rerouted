"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { OAUTH } = require("./constants");
const { generateId } = require("./password");
const {
  applyIdentity,
  identityFromProfile,
  identityFromTokens,
  mergeIdentity,
} = require("./oauth-identity");
const logger = require("./logger");

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate PKCE verifier, challenge, and state values using base64url encoding.
 */
function generatePkce(verifierBytes = 32) {
  const codeVerifier = crypto.randomBytes(verifierBytes).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

function statesMatch(expected, actual) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(actual || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function callbackPathMatches(actualPath, expectedPath) {
  const normalize = (value) => {
    const path = String(value || "/");
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  };
  return normalize(actualPath) === normalize(expectedPath);
}

function parseOAuthCallback(requestUrl, { baseUrl, callbackPath, expectedState } = {}) {
  const url = new URL(requestUrl || "/", baseUrl || "http://127.0.0.1");
  if (!callbackPathMatches(url.pathname, callbackPath)) {
    return { ok: false, status: 404, error: "Not found" };
  }

  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const providerError = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || "";
  if (!code && !providerError) {
    return { ok: false, status: 400, error: "Missing OAuth result" };
  }
  if (!statesMatch(expectedState, state)) {
    return { ok: false, status: 400, error: "OAuth state mismatch. Start the connection again." };
  }

  return {
    ok: true,
    status: 200,
    code,
    state,
    providerError,
    errorDescription,
    fullUrl: new URL(url.pathname + url.search, baseUrl || url.origin).toString(),
  };
}

const pending = new Map();

function getPending(type) {
  return pending.get(type) || null;
}

function clearPending(type) {
  const p = pending.get(type);
  if (p?.server) {
    try {
      p.server.close();
    } catch {
      /* ignore */
    }
  }
  pending.delete(type);
  if (type === "chatgpt") pending.delete("codex");
  if (type === "codex") pending.delete("chatgpt");
}

/**
 * Normalize pasted OAuth codes:
 * - full callback URLs
 * - "code#state" (Claude)
 * - whitespace / wrapping quotes
 */
function normalizeAuthCode(raw) {
  let s = String(raw || "").trim();
  if (!s) return { code: "", state: "" };
  // strip wrapping quotes
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  // Full callback URL or query string with ?code=.
  const callbackLike = /^https?:\/\//i.test(s) || s.includes("code=");
  if (callbackLike) {
    try {
      const u = new URL(s.includes("://") ? s : `http://local/?${s.replace(/^\?/, "")}`);
      const code = u.searchParams.get("code") || "";
      const state = u.searchParams.get("state") || "";
      if (code) return { code: decodeURIComponent(code), state: state || "" };
      return { code: "", state };
    } catch {
      return { code: "", state: "" };
    }
  }
  // Claude: code#state
  if (s.includes("#")) {
    const i = s.indexOf("#");
    return { code: s.slice(0, i).trim(), state: s.slice(i + 1).trim() };
  }
  return { code: s, state: "" };
}

function isStandaloneAuthCode(raw) {
  let s = String(raw || "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return !!s && !/^https?:\/\//i.test(s) && !s.includes("code=") && !s.includes("#");
}

function isCallbackLikeInput(raw) {
  const s = String(raw || "").trim().replace(/^(?:"|')|(?:"|')$/g, "");
  return /^https?:\/\//i.test(s) || s.includes("code=");
}

function callbackPage(result) {
  const safeUrl = escapeHtml(result.fullUrl);
  if (result.providerError) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ReRouted authorization</title></head><body style="font-family:system-ui;padding:2rem;max-width:36rem">
      <h2>ReRouted</h2>
      <p style="color:#b91c1c"><b>Authorization failed</b></p>
      <p>${escapeHtml(result.errorDescription || result.providerError)}</p>
      <p>Copy this URL and check Logs if it keeps failing:</p>
      <pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:12px;border-radius:8px">${safeUrl}</pre>
      </body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ReRouted authorization</title></head><body style="font-family:system-ui;padding:2rem;max-width:36rem">
    <h2>ReRouted - Authorization successful</h2>
    <p>Return to ReRouted and click <b>Finish connection</b>.</p>
    <p>If the app did not pick up the code automatically, copy this full URL and paste it there:</p>
    <pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:12px;border-radius:8px">${safeUrl}</pre>
    </body></html>`;
}

function writeCallbackHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function startCallbackServer(port, callbackPath, expectedState, onCode) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const result = parseOAuthCallback(req.url, {
          baseUrl: `http://localhost:${port}`,
          callbackPath,
          expectedState,
        });
        if (!result.ok) {
          writeCallbackHtml(
            res,
            result.status,
            `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>ReRouted</h2><p>${escapeHtml(result.error)}</p></body></html>`
          );
          return;
        }
        writeCallbackHtml(res, 200, callbackPage(result));
        onCode({
          code: result.code,
          state: result.state,
          error: result.providerError,
          error_description: result.errorDescription,
        });
      } catch {
        writeCallbackHtml(res, 500, "<!doctype html><html><body><p>OAuth callback error.</p></body></html>");
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Prefer fixed port; on EADDRINUSE bind ephemeral and return actual port. */
async function startCallbackServerFlexible(preferredPort, callbackPath, expectedState, onCode) {
  try {
    const server = await startCallbackServer(preferredPort, callbackPath, expectedState, onCode);
    return { server, port: preferredPort };
  } catch {
    const server = await new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        try {
          const address = s.address();
          const activePort = typeof address === "object" && address ? address.port : 0;
          const result = parseOAuthCallback(req.url, {
            baseUrl: `http://127.0.0.1:${activePort}`,
            callbackPath,
            expectedState,
          });
          if (!result.ok) {
            writeCallbackHtml(
              res,
              result.status,
              `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>ReRouted</h2><p>${escapeHtml(result.error)}</p></body></html>`
            );
            return;
          }
          writeCallbackHtml(res, 200, callbackPage(result));
          onCode({
            code: result.code,
            state: result.state,
            error: result.providerError,
            error_description: result.errorDescription,
          });
        } catch {
          writeCallbackHtml(res, 500, "<!doctype html><html><body><p>OAuth callback error.</p></body></html>");
        }
      });
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    return { server, port: server.address().port };
  }
}

function buildAuthUrl(type, { redirectUri, state, codeChallenge }) {
  if (type === "chatgpt" || type === "codex") {
    const c = OAUTH.chatgpt;
    const params = {
      response_type: "code",
      client_id: c.clientId,
      redirect_uri: redirectUri,
      scope: c.scope,
      code_challenge: codeChallenge,
      code_challenge_method: c.codeChallengeMethod,
      state,
      ...c.extraParams,
    };
    // Encode spaces as %20 (OpenAI is picky)
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${c.authorizeUrl}?${qs}`;
  }
  if (type === "claude") {
    const c = OAUTH.claude;
    // URLSearchParams preserves Claude's expected form-style scope encoding.
    const params = new URLSearchParams({
      code: "true",
      client_id: c.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: c.scopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: c.codeChallengeMethod || "S256",
      state: state,
    });
    return `${c.authorizeUrl}?${params.toString()}`;
  }
  if (type === "antigravity") {
    const c = OAUTH.antigravity;
    const params = {
      client_id: c.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: c.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    };
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${c.authorizeUrl}?${qs}`;
  }
  if (type === "xai") {
    const c = OAUTH.xai;
    const params = {
      response_type: "code",
      client_id: c.clientId,
      redirect_uri: redirectUri,
      scope: c.scope,
      code_challenge: codeChallenge,
      code_challenge_method: c.codeChallengeMethod,
      state,
      nonce: crypto.randomBytes(16).toString("hex"),
      plan: "generic",
      referrer: "rerouted",
    };
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `${c.authorizeUrl}?${qs}`;
  }
  throw new Error(`Unknown OAuth provider ${type}`);
}

async function startOAuth(type) {
  clearPending(type);
  logger.oauth(`startOAuth begin type=${type}`);
  let preferredPort;
  let callbackPath;
  let verifierBytes = 32;
  let useLocalCallback = true;
  /** @type {string|null} */
  let fixedRedirect = null;

  if (type === "chatgpt" || type === "codex") {
    preferredPort = OAUTH.chatgpt.fixedPort;
    callbackPath = OAUTH.chatgpt.callbackPath;
  } else if (type === "claude") {
    // Claude uses a localhost callback and accepts the full callback URL when
    // automatic return to the app is unavailable.
    fixedRedirect = null;
    preferredPort = OAUTH.claude.loopbackPort || 54545;
    callbackPath = OAUTH.claude.callbackPath || "/callback";
    useLocalCallback = true;

  } else if (type === "antigravity") {
    preferredPort = 8085;
    callbackPath = "/oauth-callback";
  } else if (type === "xai") {
    preferredPort = OAUTH.xai.loopbackPort;
    callbackPath = OAUTH.xai.callbackPath;
    verifierBytes = 96;
  } else {
    throw new Error(`Unknown OAuth type ${type}`);
  }

  const pkce = generatePkce(verifierBytes);
  const session = {
    type,
    ...pkce,
    redirectUri: fixedRedirect,
    code: null,
    callbackState: null,
    error: null,
    server: null,
    needsPaste: type === "claude" || type === "xai",
  };

  logger.oauth("PKCE generated", {
    type,
    stateLen: pkce.state?.length,
    challengeLen: pkce.codeChallenge?.length,
    verifierLen: pkce.codeVerifier?.length,
  });

  if (useLocalCallback) {
    try {
      const { server, port } = await startCallbackServerFlexible(
        preferredPort,
        callbackPath,
        session.state,
        ({ code, state, error }) => {
          if (error) {
            session.error = error;
            logger.oauth(`callback error type=${type}`, { error });
          }
          if (code) {
            session.code = code;
            logger.oauth(`callback code received type=${type}`, {
              codeLen: code.length,
              hasState: !!state,
            });
          }
          if (state) session.callbackState = state;
        }
      );
      session.server = server;
      // Claude / ChatGPT use hostname "localhost" (not 127.0.0.1) in redirect_uri
      if (type === "chatgpt" || type === "codex" || type === "claude") {
        session.redirectUri = `http://localhost:${port}${callbackPath}`;
      } else {
        session.redirectUri = `http://127.0.0.1:${port}${callbackPath}`;
      }
      logger.oauth(`callback server listening type=${type}`, {
        port,
        redirectUri: session.redirectUri,
      });
    } catch (e) {
      session.portError = e.message;
      logger.error(`callback server failed type=${type}: ${e.message}`);
      if (!session.redirectUri) {
        // Prefer localhost hostname for Claude / ChatGPT; others keep 127.0.0.1
        const host = type === "claude" || type === "chatgpt" || type === "codex" ? "localhost" : "127.0.0.1";
        session.redirectUri = `http://${host}:${preferredPort}${callbackPath}`;
      }
    }
  }

  if (!session.redirectUri) {
    session.redirectUri =
      fixedRedirect ||
      `http://localhost:${preferredPort || 54545}${callbackPath || "/callback"}`;
  }

  const authType = type === "codex" ? "chatgpt" : type;
  const authUrl = buildAuthUrl(authType, {
    redirectUri: session.redirectUri,
    state: session.state,
    codeChallenge: session.codeChallenge,
  });
  session.authUrl = authUrl;

  // Alternate Claude authorize URL (registered paste redirect) for debugging
  let altAuthUrl = null;
  if (type === "claude" && OAUTH.claude.redirectUriFallbacks?.length) {
    altAuthUrl = buildAuthUrl("claude", {
      redirectUri: OAUTH.claude.redirectUriFallbacks[0],
      state: session.state,
      codeChallenge: session.codeChallenge,
    });
    session.altAuthUrl = altAuthUrl;
    session.altRedirectUri = OAUTH.claude.redirectUriFallbacks[0];
  }

  pending.set(type, session);
  if (type === "chatgpt") pending.set("codex", session);
  if (type === "codex") pending.set("chatgpt", session);

  // Keep enough diagnostic structure without persisting live OAuth values.
  let paramDump = {};
  try {
    const u = new URL(authUrl);
    for (const [k] of u.searchParams) {
      paramDump[k] = ["state", "nonce", "code_challenge"].includes(k) ? "[redacted]" : "[present]";
    }
  } catch {
    /* ignore */
  }

  logger.oauth(`AUTHORIZE URL ready type=${type}`, {
    redirectUri: session.redirectUri,
    needsPaste: !!session.needsPaste,
    authorizeOrigin: new URL(authUrl).origin,
    params: paramDump,
    hasAltAuthUrl: !!altAuthUrl,
  });
  logger.info(`OAuth authorization URL prepared for ${type}`);

  return {
    authUrl,
    altAuthUrl,
    type,
    redirectUri: session.redirectUri,
    needsPaste: !!session.needsPaste,
    params: paramDump,
  };
}

async function completeOAuth(type, { pasteCode, fetchImpl = fetch } = {}) {
  logger.oauth(`completeOAuth begin type=${type}`, {
    hasSession: !!pending.get(type),
    pasteLen: pasteCode ? String(pasteCode).length : 0,
  });
  const session = pending.get(type) || pending.get(type === "codex" ? "chatgpt" : type);
  if (!session) {
    logger.error("completeOAuth: no active session");
    throw new Error("No OAuth session in progress. Click the provider again.");
  }

  let code = session?.code;
  let returnedState = session?.callbackState || "";
  let acceptsActivePkceSession = false;
  let callbackInputMissingCode = false;
  if (pasteCode) {
    const n = normalizeAuthCode(pasteCode);
    logger.oauth("paste code normalized", {
      rawLen: String(pasteCode).length,
      codeLen: n.code?.length || 0,
      stateLen: n.state?.length || 0,
    });
    code = n.code || code;
    // A manual value must carry its own state; never combine a pasted code
    // with state captured from an earlier callback. xAI is the exception: its
    // browser flow displays a standalone code that remains bound to this PKCE
    // session through the verifier used during token exchange.
    returnedState = n.state || "";
    acceptsActivePkceSession =
      type === "xai" && !!n.code && !n.state && isStandaloneAuthCode(pasteCode);
    callbackInputMissingCode = !n.code && isCallbackLikeInput(pasteCode);
  }
  if (!code) {
    const msg = callbackInputMissingCode
      ? type === "xai"
        ? "That URL does not contain an authorization code. Paste the code xAI shows you, or the full callback URL after authorization."
        : "That URL does not contain an authorization code. Paste the full callback URL after authorization."
      : session?.error
        ? `OAuth error: ${session.error}`
        : "No authorization code yet. Finish login in the browser, then click Finish connection.";
    logger.error(msg);
    throw new Error(msg);
  }
  if (!statesMatch(session.state, returnedState) && !acceptsActivePkceSession) {
    logger.warn(`OAuth state validation failed for ${type}`);
    throw new Error("OAuth state mismatch. Start the connection again and paste the full callback URL.");
  }

  const t = type === "codex" ? "chatgpt" : type;
  logger.oauth(`exchanging tokens type=${t}`, {
    codeLen: code.length,
    authorizationBinding: acceptsActivePkceSession ? "active-pkce-session" : "callback-state",
    redirectUri: session?.redirectUri,
  });
  let tokens;
  const redirectUri = session?.redirectUri;

  if (t === "chatgpt") {
    const c = OAUTH.chatgpt;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: c.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: session.codeVerifier,
    });
    const res = await fetchImpl(c.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const identity = identityFromTokens("chatgpt", data);
    tokens = {
      type: "chatgpt",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: "ChatGPT",
      ...identity,
    };
  } else if (t === "claude") {
    const c = OAUTH.claude;
    // Token exchange must use the same redirect URI as authorization.
    const redirects = [...new Set([redirectUri, c.redirectUri].filter(Boolean))];
    const tokenUrls = [c.tokenUrl, ...(c.tokenUrlFallbacks || [])].filter(Boolean);

    const tokenHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (c.userAgent) tokenHeaders["User-Agent"] = c.userAgent;

    let data = null;
    let lastErr = "";
    outer: for (const ru of redirects) {
      for (const tokenUrl of tokenUrls) {
        // Keep the token payload field order stable for the upstream endpoint.
        const tokenPayload = {
          code,
          state: session.state,
          grant_type: "authorization_code",
          client_id: c.clientId,
          redirect_uri: ru,
          code_verifier: session?.codeVerifier,
        };
        logger.oauth("Claude token exchange attempt", {
          tokenUrl,
          redirect_uri: ru,
          hasCode: !!code,
          hasState: true,
          hasVerifier: !!session?.codeVerifier,
        });
        const res = await fetchImpl(tokenUrl, {
          method: "POST",
          headers: tokenHeaders,
          body: JSON.stringify(tokenPayload),
        });
        if (res.ok) {
          data = await res.json();
          logger.oauth("Claude token exchange SUCCESS", {
            tokenUrl,
            redirect_uri: ru,
            hasAccess: !!data.access_token,
            hasRefresh: !!data.refresh_token,
          });
          break outer;
        }
        const bodyText = await res.text().catch(() => "");
        lastErr = `${res.status} ${bodyText}`.slice(0, 400);
        logger.error("Claude token exchange FAILED", {
          tokenUrl,
          redirect_uri: ru,
          status: res.status,
          body: bodyText.slice(0, 400),
        });
      }
    }
    if (!data) {
      const msg =
        `Token exchange failed: ${lastErr}. ` +
        `Paste the FULL code from the success page (include everything after # if present). ` +
        `Open Logs for full details.`;
      logger.error(msg);
      throw new Error(msg);
    }
    const profile = await fetchClaudeProfile(data.access_token, { fetchImpl });
    const identity = mergeIdentity(
      identityFromProfile("claude", profile),
      identityFromProfile("claude", data)
    );
    tokens = {
      type: "claude",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: "Claude",
      ...identity,
    };
  } else if (t === "antigravity") {
    const c = OAUTH.antigravity;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: c.clientId,
      client_secret: c.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetchImpl(c.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    let profile;
    try {
      const ui = await fetchImpl(`${c.userInfoUrl}?alt=json`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (ui.ok) {
        profile = await ui.json();
      }
    } catch {
      /* ignore */
    }
    const identity = identityFromProfile("antigravity", profile);
    tokens = {
      type: "antigravity",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: "Antigravity",
      ...identity,
    };
  } else if (t === "xai") {
    const c = OAUTH.xai;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: c.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: session.codeVerifier,
    });
    const res = await fetchImpl(c.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const identity = identityFromTokens("xai", data);
    tokens = {
      type: "xai",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: "xAI (Grok)",
      ...identity,
    };
  } else {
    throw new Error(`Unknown type ${type}`);
  }

  clearPending(type);
  return {
    id: generateId("prov"),
    enabled: true,
    createdAt: Date.now(),
    ...tokens,
  };
}

async function fetchClaudeProfile(
  accessToken,
  { fetchImpl = fetch, timeoutMs = 5000 } = {}
) {
  if (!accessToken) return null;
  const controller = new AbortController();
  let timeout;
  try {
    // Claude Code's profile call uses OAuth bearer auth with JSON/no-cache headers,
    // not the versioned inference headers used for /v1/messages.
    const request = (async () => {
      const response = await fetchImpl(OAUTH.claude.profileUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return response.json();
    })();
    const profile = await Promise.race([
      request,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Claude profile request timed out"));
        }, timeoutMs);
      }),
    ]);
    return profile && typeof profile === "object" ? profile : null;
  } catch {
    // Profile enrichment is best effort; valid tokens must still be saved.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function backfillClaudeProfiles(
  providers,
  { fetchImpl = fetch, timeoutMs = 5000, refreshImpl } = {}
) {
  const targets = (providers || []).filter(
    (provider) =>
      provider?.type === "claude" &&
      provider.accessToken &&
      (!provider.email || !provider.profileName)
  );
  const results = await Promise.all(
    targets.map(async (provider) => {
      let tokens = null;
      let accessToken = provider.accessToken;
      let refreshed = false;
      const refresh = async () => {
        if (!refreshImpl || !provider.refreshToken || refreshed) return;
        refreshed = true;
        try {
          tokens = await refreshImpl(provider, { fetchImpl });
          accessToken = tokens?.accessToken || accessToken;
        } catch {
          tokens = null;
        }
      };

      if (provider.expiresAt && provider.expiresAt < Date.now() + 60_000) await refresh();
      let profile = await fetchClaudeProfile(accessToken, { fetchImpl, timeoutMs });
      if (!profile && !refreshed) {
        await refresh();
        if (tokens?.accessToken) {
          profile = await fetchClaudeProfile(tokens.accessToken, { fetchImpl, timeoutMs });
        }
      }
      return { tokens, identity: identityFromProfile("claude", profile) };
    })
  );

  return targets.reduce((changed, provider, index) => {
    const result = results[index];
    if (result.tokens) Object.assign(provider, result.tokens);
    return applyIdentity(provider, result.identity) || !!result.tokens || changed;
  }, false);
}

function oauthStatus(type) {
  const s = pending.get(type);
  if (!s) return { active: false };
  return {
    active: true,
    hasCode: !!s.code,
    error: s.error || null,
    authUrl: s.authUrl,
    needsPaste: !!s.needsPaste,
  };
}

module.exports = {
  generatePkce,
  startOAuth,
  completeOAuth,
  oauthStatus,
  getPending,
  clearPending,
  buildAuthUrl,
  normalizeAuthCode,
  statesMatch,
  parseOAuthCallback,
  escapeHtml,
  fetchClaudeProfile,
  backfillClaudeProfiles,
};
