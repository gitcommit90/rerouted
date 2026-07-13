"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { OAUTH } = require("./constants");
const { generateId } = require("./password");
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
  // full URL with ?code=
  try {
    if (/^https?:\/\//i.test(s) || s.includes("code=")) {
      const u = new URL(s.includes("://") ? s : `http://local/?${s.replace(/^\?/, "")}`);
      const code = u.searchParams.get("code") || "";
      const state = u.searchParams.get("state") || "";
      if (code) return { code: decodeURIComponent(code), state: state || "" };
    }
  } catch {
    /* fall through */
  }
  // Claude: code#state
  if (s.includes("#")) {
    const i = s.indexOf("#");
    return { code: s.slice(0, i).trim(), state: s.slice(i + 1).trim() };
  }
  return { code: s, state: "" };
}

function startCallbackServer(port, callbackPath, onCode) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || "/", `http://localhost:${port}`);
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state");
        const error = u.searchParams.get("error");
        const errorDescription = u.searchParams.get("error_description");
        if (!code && !error) {
          if (u.pathname !== callbackPath && u.pathname !== callbackPath.replace(/\/$/, "")) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
        }
        // Show the full callback URL so it can be pasted back into the app.
        const fullUrl = `http://localhost:${port}${u.pathname}${u.search}`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (error) {
          res.end(
            `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:36rem">
            <h2>ReRouted</h2>
            <p style="color:#b91c1c"><b>Authorization failed</b></p>
            <p>${String(errorDescription || error)}</p>
            <p class="muted">Copy this URL and check Logs if it keeps failing:</p>
            <pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:12px;border-radius:8px">${fullUrl}</pre>
            </body></html>`
          );
        } else {
          res.end(
            `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:36rem">
            <h2>ReRouted — Authorization successful</h2>
            <p>Return to ReRouted and click <b>I'm done</b>.</p>
            <p>If the app didn't pick up the code automatically, copy this full URL and paste it there:</p>
            <pre style="white-space:pre-wrap;word-break:break-all;background:#f4f4f5;padding:12px;border-radius:8px">${fullUrl}</pre>
            </body></html>`
          );
        }
        onCode({
          code,
          state,
          error,
          error_description: errorDescription,
        });
      } catch {
        res.writeHead(500);
        res.end("Error");
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** Prefer fixed port; on EADDRINUSE bind ephemeral and return actual port. */
async function startCallbackServerFlexible(preferredPort, callbackPath, onCode) {
  try {
    const server = await startCallbackServer(preferredPort, callbackPath, onCode);
    return { server, port: preferredPort };
  } catch {
    const server = await new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        try {
          const u = new URL(req.url || "/", "http://127.0.0.1");
          const code = u.searchParams.get("code");
          const state = u.searchParams.get("state");
          const error = u.searchParams.get("error");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h2>ReRouted</h2><p>${
              error ? "Authorization failed" : "Return to ReRouted and click I'm done."
            }</p></body></html>`
          );
          onCode({ code, state, error });
        } catch {
          res.writeHead(500);
          res.end("Error");
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
    pastedState: null,
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
          if (state) session.pastedState = state;
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

  // Parse params for the log (so users can see each field)
  let paramDump = {};
  try {
    const u = new URL(authUrl);
    for (const [k, v] of u.searchParams) {
      // don't dump full verifier-related secrets beyond challenge
      paramDump[k] = v;
    }
  } catch {
    /* ignore */
  }

  logger.oauth(`AUTHORIZE URL ready type=${type}`, {
    redirectUri: session.redirectUri,
    needsPaste: !!session.needsPaste,
    authUrl,
    params: paramDump,
    altAuthUrl: altAuthUrl || undefined,
  });
  logger.info(`OAuth: open this URL for ${type}:\n${authUrl}`);

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
  if (!session && !pasteCode) {
    logger.error("completeOAuth: no session and no paste code");
    throw new Error("No OAuth session in progress. Click the provider again.");
  }

  let code = session?.code;
  let codeState = session?.pastedState || session?.state || "";
  if (pasteCode) {
    const n = normalizeAuthCode(pasteCode);
    logger.oauth("paste code normalized", {
      rawLen: String(pasteCode).length,
      codeLen: n.code?.length || 0,
      stateLen: n.state?.length || 0,
      codePrefix: (n.code || "").slice(0, 12),
    });
    code = n.code || code;
    if (n.state) codeState = n.state;
  }
  if (!code) {
    const msg = session?.error
      ? `OAuth error: ${session.error}`
      : "No authorization code yet. Finish login in the browser (paste the code if shown), then click I'm done.";
    logger.error(msg);
    throw new Error(msg);
  }

  const t = type === "codex" ? "chatgpt" : type;
  logger.oauth(`exchanging tokens type=${t}`, {
    codeLen: code.length,
    stateLen: (codeState || "").length,
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
    tokens = {
      type: "chatgpt",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: "ChatGPT",
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
          state: codeState || session?.state || "",
          grant_type: "authorization_code",
          client_id: c.clientId,
          redirect_uri: ru,
          code_verifier: session?.codeVerifier,
        };
        logger.oauth("Claude token exchange attempt", {
          tokenUrl,
          redirect_uri: ru,
          hasCode: !!code,
          hasState: !!(codeState || session?.state),
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
    tokens = {
      type: "claude",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: "Claude",
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
    let email;
    try {
      const ui = await fetchImpl(`${c.userInfoUrl}?alt=json`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (ui.ok) {
        const u = await ui.json();
        email = u.email;
      }
    } catch {
      /* ignore */
    }
    tokens = {
      type: "antigravity",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      email,
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: email ? `Antigravity (${email})` : "Antigravity",
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
    tokens = {
      type: "xai",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      models: c.models.map((m) => ({ ...m, enabled: true })),
      name: "xAI (Grok)",
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
};
