"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_EVENTS = 20_000;
const RECENT_UI = 80;

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

/**
 * Persistent + in-memory usage store for gateway requests.
 */
function createUsageStore(filePath) {
  let events = [];
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const data = JSON.parse(raw);
      events = Array.isArray(data.events) ? data.events : [];
    } catch {
      events = [];
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.tmp`;
      // Keep last MAX_EVENTS
      if (events.length > MAX_EVENTS) events = events.slice(0, MAX_EVENTS);
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, events }, null, 0), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      try {
        fs.chmodSync(filePath, 0o600);
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.error("usage save failed:", e.message);
    }
  }

  function record(entry) {
    load();
    const row = {
      at: Date.now(),
      model: entry.model || null,
      upstream: entry.upstream || null,
      providerId: entry.providerId || null,
      providerType: entry.providerType || null,
      providerName: entry.providerName || null,
      status: entry.status || 0,
      stream: !!entry.stream,
      prompt_tokens: entry.prompt_tokens || 0,
      completion_tokens: entry.completion_tokens || 0,
      cached_tokens: entry.cached_tokens || 0,
      total_tokens: entry.total_tokens || 0,
      error: entry.error || null,
    };
    events.unshift(row);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    // Persist each event so recent activity survives an unexpected exit.
    save();
    return row;
  }

  function recent(limit = RECENT_UI) {
    load();
    return events.slice(0, limit);
  }

  function inPeriod(periodKey) {
    load();
    const ms = PERIODS[periodKey];
    if (ms == null) return events.slice();
    const cutoff = Date.now() - ms;
    return events.filter((e) => e.at >= cutoff);
  }

  function aggregate(periodKey = "24h") {
    const rows = inPeriod(periodKey);
    const byModel = new Map();
    const byProvider = new Map();
    let prompt = 0;
    let completion = 0;
    let cached = 0;
    let total = 0;
    let ok = 0;
    let err = 0;

    for (const e of rows) {
      prompt += e.prompt_tokens || 0;
      completion += e.completion_tokens || 0;
      cached += e.cached_tokens || 0;
      total += e.total_tokens || 0;
      if (e.status >= 200 && e.status < 400) ok++;
      else err++;

      const mk = e.model || "unknown";
      const m = byModel.get(mk) || {
        model: mk,
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cached_tokens: 0,
      };
      m.requests++;
      m.prompt_tokens += e.prompt_tokens || 0;
      m.completion_tokens += e.completion_tokens || 0;
      m.cached_tokens += e.cached_tokens || 0;
      byModel.set(mk, m);

      const pk = e.providerName || e.providerType || e.providerId || "unknown";
      const p = byProvider.get(pk) || {
        provider: pk,
        requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      };
      p.requests++;
      p.prompt_tokens += e.prompt_tokens || 0;
      p.completion_tokens += e.completion_tokens || 0;
      byProvider.set(pk, p);
    }

    return {
      period: periodKey,
      requests: rows.length,
      ok,
      errors: err,
      prompt_tokens: prompt,
      completion_tokens: completion,
      cached_tokens: cached,
      total_tokens: total,
      byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
      byProvider: [...byProvider.values()].sort((a, b) => b.requests - a.requests),
      recent: rows.slice(0, RECENT_UI),
    };
  }

  function totalsAllTime() {
    load();
    return {
      allTimeRequests: events.length,
    };
  }

  return { record, recent, aggregate, extractUsage, totalsAllTime, PERIODS };
}

module.exports = { createUsageStore, extractUsage, PERIODS };
