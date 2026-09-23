"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const { createUsageStore } = require("../src/lib/usage");

function withTempUsage(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rerouted-usage-"));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("SQLite usage history", () => {
  it("retains more than the former 20,000-event limit", () => {
    withTempUsage((directory) => {
      const store = createUsageStore(path.join(directory, "usage.sqlite"));
      const eventCount = 20_125;
      try {
        for (let index = 0; index < eventCount; index++) {
          store.record({
            model: `model-${index % 3}`,
            providerType: "xai",
            providerName: "xAI (Grok)",
            status: index % 10 === 0 ? 429 : 200,
            prompt_tokens: 2,
            completion_tokens: 1,
            total_tokens: 3,
          });
        }

        assert.equal(store.totalsAllTime().allTimeRequests, eventCount);
        assert.equal(store.aggregate("all").requests, eventCount);
        assert.equal(store.aggregate("all").total_tokens, eventCount * 3);
        assert.equal(store.recent(eventCount).length, eventCount);
      } finally {
        store.close();
      }
    });
  });

  it("migrates every legacy JSON row exactly once without deleting the source", () => {
    withTempUsage((directory) => {
      const databasePath = path.join(directory, "usage.sqlite");
      const legacyPath = path.join(directory, "usage.json");
      const eventCount = 20_075;
      const now = Date.now();
      const events = Array.from({ length: eventCount }, (_, index) => ({
        at: now - index,
        model: `legacy-${index % 5}`,
        upstream: "legacy-upstream",
        providerId: "prov_legacy",
        providerType: "claude",
        providerName: "Claude",
        accountAlias: "oauth1",
        status: index % 7 === 0 ? 500 : 200,
        stream: index % 2 === 0,
        prompt_tokens: index % 11,
        completion_tokens: index % 13,
        cached_tokens: index % 3,
        total_tokens: (index % 11) + (index % 13),
        error: index % 7 === 0 ? "legacy failure" : null,
        legacyMarker: `row-${index}`,
      }));
      fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, events }));

      let store = createUsageStore(databasePath, { legacyPath });
      try {
        assert.equal(store.totalsAllTime().allTimeRequests, eventCount);
        assert.equal(store.aggregate("all").requests, eventCount);
        assert.deepEqual(store.recent(1)[0], events[0]);
        assert.equal(fs.existsSync(legacyPath), true);
      } finally {
        store.close();
      }

      store = createUsageStore(databasePath, { legacyPath });
      try {
        assert.equal(store.totalsAllTime().allTimeRequests, eventCount);
        assert.deepEqual(store.recent(1)[0], events[0]);
      } finally {
        store.close();
      }
    });
  });

  it("normalizes cache read, cache write, uncached, and provider token semantics", () => {
    withTempUsage((directory) => {
      const store = createUsageStore(path.join(directory, "usage.sqlite"));
      try {
        store.record({ providerType: "chatgpt", status: 200, prompt_tokens: 100, cached_tokens: 80, completion_tokens: 5, total_tokens: 105 });
        store.record({ providerType: "claude", status: 200, prompt_tokens: 20, cached_tokens: 70, cache_write_tokens: 10, completion_tokens: 5, total_tokens: 25 });
        const usage = store.aggregate("all");
        assert.equal(usage.cache_read_tokens, 150);
        assert.equal(usage.cache_write_tokens, 10);
        assert.equal(usage.uncached_input_tokens, 50);
        assert.equal(usage.logical_input_tokens, 200);
        const recent = store.recent(2);
        assert.equal(recent[0].token_semantics, "input_excludes_cache_read_write");
        assert.equal(recent[0].logical_input_tokens, 100);
        assert.equal(recent[0].uncached_input_tokens, 30);
        assert.equal(recent[1].token_semantics, "input_includes_cache_read");
        assert.equal(recent[1].uncached_input_tokens, 20);
      } finally {
        store.close();
      }
    });
  });

  it("preserves a corrupt database and starts a fresh usable history", () => {
    withTempUsage((directory) => {
      const databasePath = path.join(directory, "usage.sqlite");
      const corruptBytes = Buffer.from("this is not a sqlite database\n", "utf8");
      fs.writeFileSync(databasePath, corruptBytes);
      const originalConsoleError = console.error;
      const warnings = [];
      console.error = (...parts) => warnings.push(parts.join(" "));

      let store;
      try {
        store = createUsageStore(databasePath);
      } finally {
        console.error = originalConsoleError;
      }

      try {
        assert.ok(store.recovery);
        assert.match(store.recovery.reason, /file is not a database/i);
        assert.deepEqual(fs.readFileSync(store.recovery.recoveryPath), corruptBytes);
        assert.match(warnings.join("\n"), /preserved.*fresh usage database/i);
        assert.equal(store.totalsAllTime().allTimeRequests, 0);
        store.record({ model: "after-recovery", status: 200, total_tokens: 1 });
        assert.equal(store.totalsAllTime().allTimeRequests, 1);
      } finally {
        store.close();
      }
    });
  });
});
