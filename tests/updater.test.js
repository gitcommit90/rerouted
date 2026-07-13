"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createUpdateService, publicError, releaseVersion } = require("../src/lib/updater");

function fixture(overrides = {}) {
  class FakeUpdater extends EventEmitter {
    setFeedURL(options) {
      this.feed = options;
    }

    checkForUpdates() {
      this.checks = (this.checks || 0) + 1;
      this.emit("checking-for-update");
    }

    quitAndInstall() {
      this.installs = (this.installs || 0) + 1;
    }
  }

  const updater = new FakeUpdater();
  const published = [];
  const service = createUpdateService({
    app: { getVersion: () => "0.3.1", isPackaged: true, isInApplicationsFolder: () => true },
    autoUpdater: updater,
    logger: { info() {}, error() {} },
    publish: (state) => published.push(state),
    platform: "darwin",
    arch: "arm64",
    ...overrides,
  });
  return { service, updater, published };
}

test("configures the stable GitHub release feed and guards duplicate checks", () => {
  const { service, updater } = fixture();
  assert.equal(service.initialize(), true);
  assert.deepEqual(updater.feed, {
    url: "https://update.electronjs.org/gitcommit90/rerouted/darwin-arm64/0.3.1",
  });

  assert.equal(service.check().ok, true);
  assert.equal(service.check().ok, true);
  assert.equal(updater.checks, 1);
  updater.emit("update-not-available");
  assert.equal(service.state().status, "current");
});

test("tracks an automatically downloaded update and installs only when ready", () => {
  const { service, updater } = fixture();
  service.initialize();
  service.check();
  updater.emit("update-available");
  assert.equal(service.state().status, "downloading");
  assert.equal(service.install().ok, false);

  updater.emit(
    "update-downloaded",
    {},
    "Release notes",
    "ReRouted v0.3.2",
    new Date(),
    "https://example.test"
  );
  assert.equal(service.state().status, "ready");
  assert.equal(service.state().version, "0.3.2");
  assert.equal(service.install().ok, true);
  assert.equal(service.state().status, "installing");
  assert.equal(updater.installs, 1);
});

test("reports unsupported builds without touching autoUpdater", () => {
  const { service, updater } = fixture({
    app: { getVersion: () => "0.3.1", isPackaged: false },
  });
  const result = service.check();
  assert.equal(result.ok, false);
  assert.equal(result.update.status, "unsupported");
  assert.equal(updater.feed, undefined);
});

test("explains that apps launched outside Applications cannot self-update", () => {
  const { service } = fixture({
    app: {
      getVersion: () => "0.3.1",
      isPackaged: true,
      isInApplicationsFolder: () => false,
    },
  });
  const result = service.check();
  assert.equal(result.ok, false);
  assert.equal(result.update.error, "Move ReRouted to Applications to enable updates.");
});

test("turns updater failures into short user-safe messages", () => {
  assert.equal(releaseVersion("v1.4.0"), "1.4.0");
  assert.equal(releaseVersion("ReRouted 2.0.1-beta.2"), "2.0.1-beta.2");
  assert.equal(
    publicError(new Error("GET https://updates.example.test/private/token failed")),
    "GET the update service failed"
  );
});

test("recovers from a failed check and allows a retry", () => {
  const { service, updater } = fixture();
  service.check();
  updater.emit("error", new Error("network unavailable"));
  assert.equal(service.state().status, "error");
  service.check();
  assert.equal(updater.checks, 2);
});
