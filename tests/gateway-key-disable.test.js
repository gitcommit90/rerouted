"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { it } = require("node:test");
const { createGateway } = require("../src/lib/gateway");
const { createStore } = require("../src/lib/store");

it("revokes the legacy primary key when its apiKeys entry is disabled", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rr-disabled-key-"));
  const key = "rr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const store = createStore(path.join(directory, "config.json"));
  store.seed({
    onboardingComplete: true,
    apiKey: key,
    apiKeys: [{ id: "key_primary", key, name: "Primary", enabled: false }],
  });

  const gateway = createGateway({
    store,
    router: { listModels: () => ({ object: "list", data: [] }) },
    port: 0,
  });
  const server = http.createServer((req, res) => gateway.handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal(store.load().apiKey, "");
    assert.deepEqual([...gateway.validKeys(store.load())], []);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
