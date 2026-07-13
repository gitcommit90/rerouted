"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX = 500;
const entries = [];
let filePath = null;
let seq = 0;

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
    msg: String(msg || ""),
    meta: meta && typeof meta === "object" ? meta : undefined,
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
      extra = " " + JSON.stringify(e.meta);
    } catch {
      extra = " [meta]";
    }
  }
  return `[${ts}] [${e.level}] ${e.msg}${extra}`;
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
};
