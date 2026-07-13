"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { KEYED_PRESETS, OAUTH } = require("./constants");

const RECENT_UI = 80;
const SCHEMA_VERSION = 1;
const LEGACY_MIGRATION_KEY = "legacy_usage_json_migrated";

const PERIODS = {
  "1h": 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
  all: null,
};

/**
 * Extract OpenAI-style usage from a completion body (best-effort).
 */
function extractUsage(openAiJson) {
  const u = openAiJson?.usage || {};
  const prompt = Number(u.prompt_tokens || u.input_tokens || 0) || 0;
  const completion = Number(u.completion_tokens || u.output_tokens || 0) || 0;
  const cached =
    Number(
      u.prompt_tokens_details?.cached_tokens ||
        u.input_tokens_details?.cached_tokens ||
        u.cache_read_input_tokens ||
        u.cached_tokens ||
        0
    ) || 0;
  const total = Number(u.total_tokens || prompt + completion) || prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached, total_tokens: total };
}

function canonicalProviderType(type) {
  return type === "codex" ? "chatgpt" : type;
}

function isInternalProviderName(name) {
  return !name || /^prov_/i.test(String(name).trim());
}

function providerTypeName(type) {
  const canonical = canonicalProviderType(type);
  return OAUTH[canonical]?.name || KEYED_PRESETS[canonical]?.name || canonical || null;
}

function providerDisplayName(entry) {
  const name = isInternalProviderName(entry?.providerName) ? null : String(entry.providerName).trim();
  return name || providerTypeName(entry?.providerType) || (entry?.providerId ? "Disconnected account" : "Local route");
}

function providerAggregateKey(entry) {
  if (entry?.providerId) return `id:${entry.providerId}`;
  const type = canonicalProviderType(entry?.providerType);
  if (type || entry?.accountAlias) return `account:${type || "unknown"}:${entry.accountAlias || "default"}`;
  if (!isInternalProviderName(entry?.providerName)) return `name:${entry.providerName}`;
  return "local";
}

function providerAggregateLabel(entry) {
  const name = providerDisplayName(entry);
  return entry?.accountAlias ? `${name} · ${entry.accountAlias}` : name;
}

function hydrateUsageIdentity(entry, providers = []) {
  const current = (providers || []).find((provider) => provider.id === entry?.providerId);
  const providerType = canonicalProviderType(entry?.providerType || current?.type) || null;
  const storedName = isInternalProviderName(entry?.providerName) ? null : entry.providerName;
  const currentName = isInternalProviderName(current?.name) ? null : current?.name;
  const providerName =
    storedName ||
    currentName ||
    providerTypeName(providerType) ||
    (entry?.providerId ? "Disconnected account" : "Local route");
  const accountAlias = entry?.accountAlias || current?.accountAlias || null;
  const { providerId: _providerId, attempts: _attempts, ...safe } = entry || {};
  return {
    ...safe,
    providerType,
    providerName,
    accountAlias,
    ...(Object.hasOwn(safe, "provider")
      ? { provider: accountAlias ? `${providerName} · ${accountAlias}` : providerName }
      : {}),
  };
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizedRow(entry, at = Date.now()) {
  return {
    at,
    model: entry?.model || null,
    upstream: entry?.upstream || null,
    providerId: entry?.providerId || null,
    providerType: entry?.providerType || null,
    providerName: entry?.providerName || null,
    accountAlias: entry?.accountAlias || null,
    status: numeric(entry?.status),
    stream: !!entry?.stream,
    prompt_tokens: numeric(entry?.prompt_tokens),
    completion_tokens: numeric(entry?.completion_tokens),
    cached_tokens: numeric(entry?.cached_tokens),
    total_tokens: numeric(entry?.total_tokens),
    error: entry?.error || null,
  };
}

function insertValues(row, preservePayload = false) {
  return [
    numeric(row.at),
    row.model ?? null,
    row.upstream ?? null,
    row.providerId ?? null,
    row.providerType ?? null,
    row.providerName ?? null,
    row.accountAlias ?? null,
    numeric(row.status),
    row.stream ? 1 : 0,
    numeric(row.prompt_tokens),
    numeric(row.completion_tokens),
    numeric(row.cached_tokens),
    numeric(row.total_tokens),
    typeof row.error === "string" || row.error == null ? row.error : JSON.stringify(row.error),
    preservePayload ? JSON.stringify(row) : null,
    providerAggregateKey(row),
  ];
}

function decodeRow(row) {
  if (!row) return row;
  if (typeof row.payload_json === "string") {
    try {
      return JSON.parse(row.payload_json);
    } catch {
      // Reconstruct from indexed columns if a payload cannot be decoded.
    }
  }
  return {
    at: row.at,
    model: row.model,
    upstream: row.upstream,
    providerId: row.provider_id,
    providerType: row.provider_type,
    providerName: row.provider_name,
    accountAlias: row.account_alias,
    status: row.status,
    stream: !!row.stream,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    cached_tokens: row.cached_tokens,
    total_tokens: row.total_tokens,
    error: row.error,
  };
}

function periodWhere(periodKey) {
  const duration = PERIODS[periodKey];
  if (duration == null) return { sql: "", params: [] };
  return { sql: "WHERE at >= ?", params: [Date.now() - duration] };
}

function migrateLegacyJson(db, insert, legacyPath) {
  if (!legacyPath || !fs.existsSync(legacyPath)) return 0;
  const migrated = db.prepare("SELECT value FROM usage_meta WHERE key = ?").get(LEGACY_MIGRATION_KEY);
  if (migrated) return 0;

  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  } catch (error) {
    console.error(`usage migration failed: ${error.message}`);
    return 0;
  }
  if (!Array.isArray(legacy?.events)) {
    console.error("usage migration failed: legacy usage.json does not contain an events array");
    return 0;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    // Legacy JSON is newest-first. Reverse insertion preserves that order when
    // timestamps are equal and SQLite uses the monotonically increasing id.
    for (let index = legacy.events.length - 1; index >= 0; index--) {
      const row = legacy.events[index];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`legacy usage row ${index} is not an object`);
      }
      insert.run(...insertValues(row, true));
    }
    db.prepare("INSERT INTO usage_meta (key, value) VALUES (?, ?)").run(
      LEGACY_MIGRATION_KEY,
      JSON.stringify({ rows: legacy.events.length, migratedAt: Date.now() })
    );
    db.exec("COMMIT");
    return legacy.events.length;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    console.error(`usage migration failed: ${error.message}`);
    return 0;
  }
}

function isCorruptDatabaseError(error) {
  return /file is not a database|database disk image is malformed|malformed database schema|database corrupt/i.test(
    error?.message || ""
  );
}

function recoveryPathFor(databasePath) {
  const base = `${databasePath}.recovery-${Date.now()}`;
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate) || fs.existsSync(`${candidate}-wal`) || fs.existsSync(`${candidate}-shm`)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

function preserveCorruptDatabase(databasePath) {
  const recoveryPath = recoveryPathFor(databasePath);
  fs.renameSync(databasePath, recoveryPath);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${recoveryPath}${suffix}`);
  }
  return recoveryPath;
}

function initializeDatabase(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS usage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      model TEXT,
      upstream TEXT,
      provider_id TEXT,
      provider_type TEXT,
      provider_name TEXT,
      account_alias TEXT,
      status INTEGER NOT NULL,
      stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
      prompt_tokens INTEGER NOT NULL,
      completion_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      error TEXT,
      payload_json TEXT,
      provider_key TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS usage_events_at_idx ON usage_events (at DESC);
    CREATE INDEX IF NOT EXISTS usage_events_model_aggregate_idx
      ON usage_events (model, prompt_tokens, completion_tokens, cached_tokens);
    CREATE INDEX IF NOT EXISTS usage_events_provider_aggregate_idx
      ON usage_events (
        provider_key, provider_id, provider_type, provider_name, account_alias,
        prompt_tokens, completion_tokens
      );
  `);
  db.prepare("INSERT OR IGNORE INTO usage_meta (key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION)
  );
}

function openDatabase(databasePath) {
  let db;
  try {
    db = new DatabaseSync(databasePath);
    initializeDatabase(db);
    return { db, recovery: null };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Continue with recovery using the original initialization error.
    }
    if (!fs.existsSync(databasePath) || !isCorruptDatabaseError(error)) throw error;

    const recoveryPath = preserveCorruptDatabase(databasePath);
    console.error(
      `usage database was unreadable and has been preserved at ${recoveryPath}; ` +
        "ReRouted started a fresh usage database. Keep the recovery file if historical data may be repairable."
    );
    const fresh = new DatabaseSync(databasePath);
    initializeDatabase(fresh);
    return {
      db: fresh,
      recovery: {
        reason: error.message,
        recoveryPath,
      },
    };
  }
}

/**
 * Persistent SQLite usage store for gateway requests.
 */
function createUsageStore(databasePath, { legacyPath } = {}) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const { db, recovery } = openDatabase(databasePath);
  try {
    fs.chmodSync(databasePath, 0o600);
  } catch {
    // The containing directory remains private if the platform rejects chmod.
  }

  const insert = db.prepare(`
    INSERT INTO usage_events (
      at, model, upstream, provider_id, provider_type, provider_name, account_alias,
      status, stream, prompt_tokens, completion_tokens, cached_tokens, total_tokens,
      error, payload_json, provider_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  migrateLegacyJson(db, insert, legacyPath);

  function record(entry) {
    const row = normalizedRow(entry);
    insert.run(...insertValues(row));
    return row;
  }

  function recent(limit = RECENT_UI) {
    const safeLimit = Math.max(0, Math.trunc(numeric(limit)));
    return db
      .prepare("SELECT * FROM usage_events ORDER BY at DESC, id DESC LIMIT ?")
      .all(safeLimit)
      .map(decodeRow);
  }

  function aggregate(periodKey = "24h") {
    const period = periodWhere(periodKey);
    const totals = db
      .prepare(`
        SELECT
          COUNT(*) AS requests,
          COALESCE(SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END), 0) AS ok,
          COALESCE(SUM(CASE WHEN status >= 200 AND status < 400 THEN 0 ELSE 1 END), 0) AS errors,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM usage_events ${period.sql}
      `)
      .get(...period.params);

    const byModel = db
      .prepare(`
        SELECT
          COALESCE(model, 'unknown') AS model,
          COUNT(*) AS requests,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          COALESCE(SUM(cached_tokens), 0) AS cached_tokens
        FROM usage_events ${period.sql}
        GROUP BY COALESCE(model, 'unknown')
        ORDER BY requests DESC, MAX(id) DESC
      `)
      .all(...period.params);

    // SQLite resolves the bare identity columns from the row selected by the
    // query's single MAX(id), giving each group its newest identity cheaply.
    const byProvider = db
      .prepare(`
        SELECT
          provider_key,
          NULLIF(provider_id, '') AS providerId,
          CASE WHEN provider_type = 'codex' THEN 'chatgpt' ELSE NULLIF(provider_type, '') END AS providerType,
          CASE
            WHEN provider_name IS NULL OR trim(provider_name) = ''
              OR lower(trim(provider_name)) LIKE 'prov\\_%' ESCAPE '\\'
            THEN NULL
            ELSE provider_name
          END AS providerName,
          NULLIF(account_alias, '') AS accountAlias,
          COUNT(*) AS requests,
          COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
          COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
          MAX(id) AS newest_id
        FROM usage_events ${period.sql}
        GROUP BY provider_key
        ORDER BY requests DESC, newest_id DESC
      `)
      .all(...period.params)
      .map(({ provider_key: _providerKey, newest_id: _newestId, ...entry }) => ({
        provider: providerAggregateLabel(entry),
        ...entry,
      }));

    const recentRows = db
      .prepare(`SELECT * FROM usage_events ${period.sql} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...period.params, RECENT_UI)
      .map(decodeRow);

    return {
      period: periodKey,
      requests: totals.requests,
      ok: totals.ok,
      errors: totals.errors,
      prompt_tokens: totals.prompt_tokens,
      completion_tokens: totals.completion_tokens,
      cached_tokens: totals.cached_tokens,
      total_tokens: totals.total_tokens,
      byModel,
      byProvider,
      recent: recentRows,
    };
  }

  function totalsAllTime() {
    return {
      allTimeRequests: db.prepare("SELECT COUNT(*) AS count FROM usage_events").get().count,
    };
  }

  function close() {
    db.close();
  }

  return { record, recent, aggregate, extractUsage, totalsAllTime, close, recovery, PERIODS };
}

module.exports = {
  createUsageStore,
  extractUsage,
  hydrateUsageIdentity,
  providerAggregateKey,
  providerAggregateLabel,
  PERIODS,
};
