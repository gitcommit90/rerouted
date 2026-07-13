"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, it } = require("node:test");
const logger = require("../src/lib/logger");

afterEach(() => {
  logger.configure(null);
  logger.clear();
});

it("redacts credentials from messages, nested metadata, memory, and disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-logger-redaction-"));
  const logPath = path.join(dir, "rerouted.log");
  const secrets = {
    accessToken: "access-super-secret",
    refreshToken: "refresh-super-secret",
    apiKey: "rr-0123456789abcdef0123456789abcdef",
    code: "oauth-code-secret",
    state: "oauth-state-secret",
    clientSecret: "client-secret-value",
    bearer: "bearer-secret-value",
  };
  logger.configure(logPath);

  const entry = logger.oauth(
    `callback?code=${secrets.code}&state=${secrets.state} Authorization: Bearer ${secrets.bearer}`,
    {
      accessToken: secrets.accessToken,
      nested: {
        refresh_token: secrets.refreshToken,
        apiKey: secrets.apiKey,
        clientSecret: secrets.clientSecret,
        oauthCode: secrets.code,
        oauthState: secrets.state,
      },
      metrics: { inputTokens: 12, output_tokens: 4 },
    }
  );

  const serialized = JSON.stringify(entry);
  const disk = fs.readFileSync(logPath, "utf8");
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false);
    assert.equal(disk.includes(secret), false);
  }
  assert.match(serialized, /\[REDACTED\]/);
  assert.equal(entry.meta.metrics.inputTokens, 12);
  assert.equal(entry.meta.metrics.output_tokens, 4);
  assert.deepEqual(logger.list(1), [entry]);
});

it("redacts sensitive strings passed directly to formatLine", () => {
  const line = logger.formatLine({
    at: 0,
    level: "error",
    msg: "x-api-key: sk-example123456789 and api_key=url-secret",
    meta: { Authorization: "Bearer metadata-secret", password: "password-secret" },
  });

  assert.equal(line.includes("sk-example123456789"), false);
  assert.equal(line.includes("url-secret"), false);
  assert.equal(line.includes("metadata-secret"), false);
  assert.equal(line.includes("password-secret"), false);
});

it("redacts credential fields embedded in serialized upstream bodies", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJzb24ifQ.signature123456";
  const body = JSON.stringify({
    access_token: "json-access-secret",
    authorization: "Bearer json-bearer-secret",
    token: "json-token-secret",
    detail: jwt,
  });
  const redacted = logger.redactString(body);

  assert.equal(redacted.includes("json-access-secret"), false);
  assert.equal(redacted.includes("json-bearer-secret"), false);
  assert.equal(redacted.includes("json-token-secret"), false);
  assert.equal(redacted.includes(jwt), false);
});

it("handles circular metadata without retaining sensitive source objects", () => {
  const meta = { apiKey: "rr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  meta.self = meta;
  const entry = logger.info("circular", meta);

  assert.equal(entry.meta.apiKey, "[REDACTED]");
  assert.equal(entry.meta.self, "[Circular]");
  meta.apiKey = "changed-after-log";
  assert.equal(JSON.stringify(entry).includes("changed-after-log"), false);
});

it("preserves ordinary provider error codes and application state labels", () => {
  const entry = logger.error("provider failed", {
    code: "usage_limit_reached",
    state: "ready",
  });

  assert.equal(entry.meta.code, "usage_limit_reached");
  assert.equal(entry.meta.state, "ready");
});

it("redacts cookie headers and generic sensitive URL parameters", () => {
  const redacted = logger.redactString(
    "Cookie: session=private; theme=dark\nSet-Cookie: auth=private2; Secure\n/callback?token=url-token&password=url-password&secret=url-secret"
  );

  assert.equal(redacted.includes("session=private"), false);
  assert.equal(redacted.includes("auth=private2"), false);
  assert.equal(redacted.includes("url-token"), false);
  assert.equal(redacted.includes("url-password"), false);
  assert.equal(redacted.includes("url-secret"), false);
});
