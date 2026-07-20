"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createSessionAuth } = require("./session-auth");
const { hasAdminPassword } = require("./ipc-security");

const SESSION_COOKIE = "rerouted_dashboard";
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_ATTEMPTS = 6;
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_SESSIONS = 512;
const MAX_EVENT_CLIENTS = 128;
const VERIFY_CHANNEL = "app:verify-admin-password";
const PUBLIC_ONBOARDING_CHANNELS = new Set([
  "app:get-state",
  "app:set-onboarding-step",
  "app:set-admin-password",
  "app:oauth-start",
  "app:oauth-status",
  "app:oauth-cancel",
  "app:oauth-complete",
  "app:add-keyed-provider",
  "app:test-keyed-provider",
  "app:save-combo",
  "app:complete-onboarding",
  "app:open-external",
]);

const ASSETS = new Map([
  ["", ["index.html", "text/html; charset=utf-8"]],
  ["index.html", ["index.html", "text/html; charset=utf-8"]],
  ["styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["web-api.js", ["web-api.js", "text/javascript; charset=utf-8"]],
  ["app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["account-identity.js", ["account-identity.js", "text/javascript; charset=utf-8"]],
  ["number-format.js", ["number-format.js", "text/javascript; charset=utf-8"]],
  ["lock-state.js", ["lock-state.js", "text/javascript; charset=utf-8"]],
  ["provider-catalog.js", ["provider-catalog.js", "text/javascript; charset=utf-8"]],
  ["route-picker.js", ["route-picker.js", "text/javascript; charset=utf-8"]],
  ["oauth-prompt.js", ["oauth-prompt.js", "text/javascript; charset=utf-8"]],
  ["assets/brandMark.png", ["assets/brandMark.png", "image/png"]],
  ["assets/brandMark@2x.png", ["assets/brandMark@2x.png", "image/png"]],
  ["assets/providers/chatgpt.svg", ["assets/providers/chatgpt.svg", "image/svg+xml"]],
  ["assets/providers/claude.svg", ["assets/providers/claude.svg", "image/svg+xml"]],
  ["assets/providers/antigravity.svg", ["assets/providers/antigravity.svg", "image/svg+xml"]],
  ["assets/providers/xai.svg", ["assets/providers/xai.svg", "image/svg+xml"]],
  ["assets/providers/openrouter.svg", ["assets/providers/openrouter.svg", "image/svg+xml"]],
  ["assets/providers/nvidia.svg", ["assets/providers/nvidia.svg", "image/svg+xml"]],
  ["assets/providers/cloudflare.svg", ["assets/providers/cloudflare.svg", "image/svg+xml"]],
  ["assets/providers/glm.svg", ["assets/providers/glm.svg", "image/svg+xml"]],
  ["assets/providers/custom.svg", ["assets/providers/custom.svg", "image/svg+xml"]],
]);

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || "");
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function requestOriginMatches(req) {
  const origin = String(req.headers.origin || "");
  const host = String(req.headers.host || "");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

function safeHeaders(res, { html = false } = {}) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (html) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    );
  }
}

function json(res, status, body) {
  safeHeaders(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let complete = false;
    const fail = (message, code) => {
      const error = new Error(message);
      error.code = code;
      return error;
    };
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_RPC_BYTES) {
      req.resume();
      reject(fail("Dashboard request is too large", "BODY_TOO_LARGE"));
      return;
    }
    req.on("data", (chunk) => {
      if (complete) return;
      size += chunk.length;
      if (size > MAX_RPC_BYTES) {
        complete = true;
        chunks.length = 0;
        reject(fail("Dashboard request is too large", "BODY_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (complete) return;
      complete = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(fail("Dashboard request must be valid JSON", "INVALID_JSON"));
      }
    });
    req.on("error", reject);
  });
}

function createDashboard({
  store,
  controlPlane,
  rendererRoot = path.join(__dirname, "..", "renderer"),
  logger,
  now = () => Date.now(),
} = {}) {
  if (!store || !controlPlane || !logger) {
    throw new TypeError("Dashboard requires store, controlPlane, and logger");
  }
  const sessions = new Map();
  const loginAttempts = new Map();
  const eventClients = new Set();

  function prune() {
    const current = now();
    for (const [token, session] of sessions) {
      if (current - session.lastSeen > SESSION_IDLE_MS || current - session.createdAt > SESSION_MAX_MS) {
        sessions.delete(token);
      }
    }
    for (const [address, attempts] of loginAttempts) {
      const fresh = attempts.filter((at) => current - at < LOGIN_WINDOW_MS);
      if (fresh.length) loginAttempts.set(address, fresh);
      else loginAttempts.delete(address);
    }
  }

  function sessionFor(req, res) {
    prune();
    const supplied = cookieValue(req, SESSION_COOKIE);
    let session = supplied && sessions.get(supplied);
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) {
        let oldestToken = null;
        let oldestSeen = Infinity;
        for (const [candidate, value] of sessions) {
          if (value.lastSeen < oldestSeen) {
            oldestToken = candidate;
            oldestSeen = value.lastSeen;
          }
        }
        if (oldestToken) sessions.delete(oldestToken);
      }
      const token = crypto.randomBytes(32).toString("base64url");
      session = {
        token,
        auth: createSessionAuth({ platform: "linux" }),
        passwordHash: store.load().adminPasswordHash || null,
        createdAt: now(),
        lastSeen: now(),
      };
      sessions.set(token, session);
      res.setHeader(
        "Set-Cookie",
        `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=86400`
      );
    }
    const currentHash = store.load().adminPasswordHash || null;
    if (session.passwordHash !== currentHash) {
      session.auth.setManualUnlocked(false);
      session.passwordHash = currentHash;
    }
    session.lastSeen = now();
    return session;
  }

  function canAttemptLogin(req) {
    const address = String(req.socket?.remoteAddress || "unknown");
    const current = now();
    const recent = (loginAttempts.get(address) || []).filter((at) => current - at < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_ATTEMPTS) return false;
    recent.push(current);
    loginAttempts.set(address, recent);
    return true;
  }

  async function serveAsset(res, name) {
    const asset = ASSETS.get(name);
    if (!asset) return false;
    const [relativePath, contentType] = asset;
    let body;
    try {
      body = await fs.promises.readFile(path.join(rendererRoot, relativePath));
    } catch (error) {
      logger.error("Dashboard asset unavailable", { asset: relativePath, error: error.message });
      json(res, 500, { error: "Dashboard asset unavailable" });
      return true;
    }
    safeHeaders(res, { html: contentType.startsWith("text/html") });
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
    return true;
  }

  function publish(channel, payload) {
    const cfg = store.load();
    const password = hasAdminPassword(cfg);
    for (const client of [...eventClients]) {
      if (client.res.writableEnded || client.res.destroyed) {
        eventClients.delete(client);
        continue;
      }
      if (password && !client.session.auth.isUnlocked(true)) continue;
      client.res.write(`event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
  }

  async function handle(req, res, { path: requestPath }) {
    const relative = decodeURIComponent(requestPath.slice("/dashboard".length)).replace(/^\/+/, "");
    if (requestPath === "/dashboard") {
      safeHeaders(res);
      res.writeHead(308, { Location: "/dashboard/" });
      res.end();
      return true;
    }

    if (req.method === "GET" && relative === "api/events") {
      if (eventClients.size >= MAX_EVENT_CLIENTS) {
        json(res, 503, { ok: false, error: "Too many dashboard event connections" });
        return true;
      }
      if (req.headers.origin && !requestOriginMatches(req)) {
        json(res, 403, { ok: false, error: "Dashboard origin check failed" });
        return true;
      }
      const session = sessionFor(req, res);
      safeHeaders(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": ReRouted dashboard events\n\n");
      const client = { res, session };
      eventClients.add(client);
      const cleanup = () => eventClients.delete(client);
      req.once("close", cleanup);
      res.once("close", cleanup);
      return true;
    }

    if (req.method === "POST" && relative === "api/invoke") {
      if (!requestOriginMatches(req)) {
        json(res, 403, { ok: false, error: "Dashboard origin check failed" });
        return true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        json(res, error.code === "BODY_TOO_LARGE" ? 413 : 400, {
          ok: false,
          error: error.message,
        });
        return true;
      }
      const channel = String(body.channel || "");
      const args = Array.isArray(body.args) ? body.args : [];
      const session = sessionFor(req, res);
      const cfg = store.load();
      if (!cfg.onboardingComplete && !isLoopback(req)) {
        json(res, 403, {
          ok: false,
          error: "Initial setup is available only from this machine.",
        });
        return true;
      }
      if (!cfg.onboardingComplete && !PUBLIC_ONBOARDING_CHANNELS.has(channel)) {
        json(res, 403, { ok: false, error: "That action is unavailable during setup." });
        return true;
      }
      if (
        cfg.onboardingComplete &&
        !hasAdminPassword(cfg) &&
        channel !== "app:get-state" &&
        channel !== "app:set-admin-password"
      ) {
        json(res, 403, {
          ok: false,
          error: "Create an admin password before using the dashboard.",
        });
        return true;
      }
      if (channel === VERIFY_CHANNEL && !canAttemptLogin(req)) {
        json(res, 429, {
          ok: false,
          error: "Too many unlock attempts. Wait a minute and try again.",
        });
        return true;
      }
      let result = await controlPlane.invoke(channel, args, {
        sessionAuth: session.auth,
        harness: false,
      });
      if (channel === "app:get-state" && cfg.onboardingComplete && !hasAdminPassword(cfg)) {
        result = {
          onboardingComplete: false,
          onboardingStep: "admin-password",
          appVersion: result.appVersion,
          runtime: result.runtime,
          platform: result.platform,
          update: result.update,
          port: result.port,
          openAtLogin: false,
          bindHost: result.bindHost,
          endpoint: result.endpoint,
          listenHint: result.listenHint,
          serverEnabled: result.serverEnabled,
          serverListening: result.serverListening,
          providers: [],
          combos: [],
          stats: { totalRequests: 0, sessionRequests: 0, recent: [] },
          usage: {
            period: "24h",
            requests: 0,
            ok: 0,
            errors: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            total_tokens: 0,
            byModel: [],
            byProvider: [],
            recent: [],
          },
          activeRequests: [],
          oauthProviders: [],
          keyedPresets: [],
          unlocked: true,
          hasAdminPassword: false,
          steps: result.steps || [],
        };
      }
      if (channel === "app:set-admin-password" || channel === "app:change-admin-password") {
        session.passwordHash = store.load().adminPasswordHash || null;
      }
      json(res, 200, result);
      return true;
    }

    if (req.method === "GET") {
      if (relative === "" || relative === "index.html") sessionFor(req, res);
      if (await serveAsset(res, relative)) return true;
    }
    json(res, 404, { error: "Not found" });
    return true;
  }

  const heartbeat = setInterval(() => {
    prune();
    for (const client of [...eventClients]) {
      if (client.res.writableEnded || client.res.destroyed) eventClients.delete(client);
      else client.res.write(": keepalive\n\n");
    }
  }, 25_000);
  heartbeat.unref?.();

  function disconnect() {
    for (const client of eventClients) client.res.end();
    eventClients.clear();
  }

  function close() {
    clearInterval(heartbeat);
    disconnect();
    sessions.clear();
  }

  return { handle, publish, disconnect, close };
}

module.exports = {
  createDashboard,
  cookieValue,
  isLoopback,
  requestOriginMatches,
  SESSION_COOKIE,
  MAX_SESSIONS,
  MAX_EVENT_CLIENTS,
  PUBLIC_ONBOARDING_CHANNELS,
};
