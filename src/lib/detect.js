"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { OAUTH } = require("./constants");
const { generateId } = require("./password");

const execFileAsync = promisify(execFile);

function home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Detect Codex / ChatGPT OAuth tokens from known local credential locations.
 * Returns one account or an array when multiple are found.
 */
function detectCodex() {
  const found = [];
  const primary = path.join(home(), ".codex", "auth.json");
  try {
    const raw = fs.readFileSync(primary, "utf8");
    const data = JSON.parse(raw);
    const tokens = data.tokens || data;
    const access =
      tokens.access_token || tokens.accessToken || data.access_token || data.accessToken;
    const refresh =
      tokens.refresh_token || tokens.refreshToken || data.refresh_token || data.refreshToken;
    if (access || refresh) {
      found.push({
        source: "codex-cli",
        path: primary,
        type: "chatgpt",
        name: "ChatGPT",
        accessToken: access,
        refreshToken: refresh,
        accountId: tokens.account_id || tokens.accountId || data.account_id,
        idToken: tokens.id_token,
        models: OAUTH.chatgpt.models.map((m) => ({ ...m })),
        enabled: true,
      });
    }
  } catch {
    /* ignore */
  }
  const dirs = [path.join(home(), ".config", "rerouted", "auth")];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^codex/i.test(f) || !f.endsWith(".json")) continue;
        const p = path.join(dir, f);
        try {
          const data = JSON.parse(fs.readFileSync(p, "utf8"));
          const access = data.access_token || data.accessToken;
          const refresh = data.refresh_token || data.refreshToken;
          if (!access && !refresh) continue;
          // skip if same refresh already found
          if (found.some((x) => x.refreshToken && x.refreshToken === refresh)) continue;
          found.push({
            source: "codex-file",
            path: p,
            type: "chatgpt",
            name: `ChatGPT (${data.email || path.basename(p, ".json")})`,
            email: data.email,
            accessToken: access,
            refreshToken: refresh,
            accountId: data.account_id || data.accountId,
            models: OAUTH.chatgpt.models.map((m) => ({ ...m })),
            enabled: true,
          });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!found.length) return null;
  return found.length === 1 ? found[0] : found;
}

/**
 * Detect Claude credentials from the provider's macOS Keychain entry.
 */
async function detectClaudeKeychain() {
  if (process.platform !== "darwin") {
    // Fall back to supported local credential files.
    return detectClaudeFiles();
  }
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }
    );
    const secret = String(stdout || "").trim();
    if (!secret) return detectClaudeFiles();
    let data;
    try {
      data = JSON.parse(secret);
    } catch {
      // Sometimes nested JSON string
      data = JSON.parse(JSON.parse(JSON.stringify(secret)));
    }
    // Normalize the supported credential shapes.
    const oauth = data.claudeAiOauth || data.oauth || data;
    const access =
      oauth.accessToken || oauth.access_token || data.accessToken || data.access_token;
    const refresh =
      oauth.refreshToken || oauth.refresh_token || data.refreshToken || data.refresh_token;
    if (!access && !refresh) return detectClaudeFiles();
    return {
      source: "claude-keychain",
      type: "claude",
      name: "Claude",
      accessToken: access,
      refreshToken: refresh,
      expiresAt: oauth.expiresAt
        ? Number(oauth.expiresAt)
        : oauth.expires_at
          ? Number(oauth.expires_at)
          : undefined,
      models: OAUTH.claude.models.map((m) => ({ ...m })),
      enabled: true,
    };
  } catch {
    return detectClaudeFiles();
  }
}

function detectClaudeFiles() {
  const candidates = [];
  const dirs = [path.join(home(), ".config", "rerouted", "auth")];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^claude/i.test(f) || !f.endsWith(".json")) continue;
        candidates.push(path.join(dir, f));
      }
    } catch {
      /* ignore */
    }
  }
  const found = [];
  for (const p of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const access = data.access_token || data.accessToken;
      const refresh = data.refresh_token || data.refreshToken;
      if (!access && !refresh) continue;
      found.push({
        source: "claude-file",
        path: p,
        type: "claude",
        name: `Claude (${data.email || path.basename(p, ".json")})`,
        email: data.email,
        accessToken: access,
        refreshToken: refresh,
        expiresAt: data.expired
          ? Date.parse(data.expired)
          : data.expires_in
            ? Date.now() + Number(data.expires_in) * 1000
            : undefined,
        models: OAUTH.claude.models.map((m) => ({ ...m })),
        enabled: true,
      });
    } catch {
      /* ignore */
    }
  }
  return found.length === 1 ? found[0] : found.length ? found : null;
}

/**
 * Detect Antigravity tokens from known locations on the Mac.
 */
function detectAntigravity() {
  const found = [];
  const dirs = [
    path.join(home(), ".config", "rerouted", "auth"),
    path.join(home(), "ReRouted.dev", "auth_profiles"),
    path.join(home(), "Downloads"),
  ];
  const files = [];
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/antigravity/i.test(f) || !f.endsWith(".json")) continue;
        files.push(path.join(dir, f));
      }
    } catch {
      /* ignore */
    }
  }
  // Deduplicate by email/refresh token
  const seen = new Set();
  for (const p of files) {
    try {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      const access = data.access_token || data.accessToken;
      const refresh = data.refresh_token || data.refreshToken;
      if (!access && !refresh) continue;
      const key = data.email || refresh || p;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({
        source: "antigravity-file",
        path: p,
        type: "antigravity",
        name: `Antigravity (${data.email || path.basename(p, ".json")})`,
        email: data.email,
        accessToken: access,
        refreshToken: refresh,
        projectId: data.project_id || data.projectId,
        clientId: data.client_id || OAUTH.antigravity.clientId,
        clientSecret: data.client_secret || OAUTH.antigravity.clientSecret,
        expiresAt: data.expired
          ? Date.parse(data.expired)
          : data.timestamp
            ? Number(data.timestamp) + (Number(data.expires_in) || 3600) * 1000
            : undefined,
        models: OAUTH.antigravity.models.map((m) => ({ ...m })),
        enabled: true,
      });
    } catch {
      /* ignore */
    }
  }
  return found;
}

/**
 * Run all detectors. Returns flat list of importable accounts (no secrets stripped —
 * caller imports selected ones into store).
 */
async function detectAll() {
  const results = [];
  const codex = detectCodex();
  if (Array.isArray(codex)) results.push(...codex);
  else if (codex) results.push(codex);

  const claude = await detectClaudeKeychain();
  if (Array.isArray(claude)) results.push(...claude);
  else if (claude) results.push(claude);

  const ag = detectAntigravity();
  results.push(...ag);

  return results.map((r) => ({
    ...r,
    id: generateId("prov"),
    createdAt: Date.now(),
  }));
}

/**
 * Safe summary for UI (no full tokens).
 */
function summarizeDetected(list) {
  return (list || []).map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    source: r.source,
    email: r.email,
    path: r.path,
    hasAccess: !!r.accessToken,
    hasRefresh: !!r.refreshToken,
  }));
}

module.exports = {
  detectCodex,
  detectClaudeKeychain,
  detectAntigravity,
  detectAll,
  summarizeDetected,
};
