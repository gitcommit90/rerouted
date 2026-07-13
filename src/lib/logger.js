"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX = 500;
const REDACTED = "[REDACTED]";
const entries = [];
let filePath = null;
let seq = 0;

const SAFE_TOKEN_KEYS = new Set([
  "cachedtokens",
  "inputtokens",
  "maxtokens",
  "outputtokens",
  "tokencount",
  "totaltokens",
]);

function isSensitiveKey(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!normalized) return false;
  if (SAFE_TOKEN_KEYS.has(normalized)) return false;
  if (["authorization", "proxyauthorization", "cookie", "setcookie"].includes(normalized)) {
    return true;
  }
  if (
    [
      "authorizationcode",
      "codeprefix",
      "codeverifier",
      "oauthcode",
      "oauthstate",
    ].includes(normalized)
  ) {
    return true;
  }
  if (normalized.includes("apikey") || normalized.includes("credential")) return true;
  if (normalized.includes("password") || normalized.includes("passphrase")) return true;
  if (normalized.includes("secret") || normalized.includes("privatekey")) return true;
  return normalized === "token" || normalized === "tokens" || normalized.endsWith("token");
}

function redactString(value) {
  return String(value || "")
    .replace(/(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*)(?:Bearer\s+)?([^\s,;"']+)/gi,
      `$1${REDACTED}`
    )
    .replace(/(\bBearer\s+)([^\s,;"']+)/gi, `$1${REDACTED}`)
    .replace(
      /([?&#]|\b)(code|state|token|password|passphrase|secret|access_token|refresh_token|id_token|api_key|client_secret|code_verifier)=([^&#\s]+)/gi,
      `$1$2=${REDACTED}`
    )
    .replace(
      /(["']?(?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|api_key|apiKey|client_secret|clientSecret|code_verifier|codeVerifier)["']?\s*:\s*["'])([^"']+)(["'])/g,
      `$1${REDACTED}$3`
    )
    .replace(
      /(["']?(?:authorization|proxy_authorization|proxyAuthorization|cookie|set_cookie|setCookie|token|password|passphrase|secret|private_key|privateKey)["']?\s*:\s*["'])([^"']+)(["'])/gi,
      `$1${REDACTED}$3`
    )
    .replace(/\brr-[a-f0-9]{16,}\b/gi, REDACTED)
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, REDACTED)
    .replace(/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi, REDACTED);
}

function redactValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (value instanceof Date) return value.toISOString();

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, seen);
  }
  return result;
}

function configure(logFile) {
  filePath = logFile || null;
  if (filePath) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} level info|warn|error|oauth|debug
 * @param {string} msg
 * @param {object} [meta]
 */
function log(level, msg, meta) {
  const entry = {
    id: ++seq,
    at: Date.now(),
    level: level || "info",
    msg: redactString(msg),
    meta: meta && typeof meta === "object" ? redactValue(meta) : undefined,
  };
  entries.unshift(entry);
  if (entries.length > MAX) entries.length = MAX;

  const line = formatLine(entry);
  // Always stdout for packaged app Console / Console.app if launched from terminal
  try {
    console.log(line);
  } catch {
    /* ignore */
  }

  if (filePath) {
    try {
      fs.appendFileSync(filePath, line + "\n", { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }
  return entry;
}

function formatLine(e) {
  const ts = new Date(e.at).toISOString();
  let extra = "";
  if (e.meta) {
    try {
      extra = " " + JSON.stringify(redactValue(e.meta));
    } catch {
      extra = " [meta]";
    }
  }
  return `[${ts}] [${e.level}] ${redactString(e.msg)}${extra}`;
}

function list(limit = 200) {
  return entries.slice(0, limit);
}

function clear() {
  entries.length = 0;
  seq = 0;
  if (filePath) {
    try {
      fs.writeFileSync(filePath, "", { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }
}

function getFilePath() {
  return filePath;
}

const info = (m, meta) => log("info", m, meta);
const warn = (m, meta) => log("warn", m, meta);
const error = (m, meta) => log("error", m, meta);
const oauth = (m, meta) => log("oauth", m, meta);
const debug = (m, meta) => log("debug", m, meta);

module.exports = {
  configure,
  log,
  list,
  clear,
  getFilePath,
  info,
  warn,
  error,
  oauth,
  debug,
  formatLine,
  isSensitiveKey,
  redactString,
  redactValue,
};
