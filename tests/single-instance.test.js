"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { acquireSingleInstance } = require("../src/lib/single-instance");

describe("single-instance startup gate", () => {
  it("exits a losing process before application initialization", () => {
    const exits = [];
    const acquired = acquireSingleInstance({
      requestSingleInstanceLock: () => false,
      exit: (code) => exits.push(code),
    });

    assert.equal(acquired, false);
    assert.deepEqual(exits, [0]);
  });

  it("keeps the primary process running", () => {
    let exited = false;
    const acquired = acquireSingleInstance({
      requestSingleInstanceLock: () => true,
      exit: () => {
        exited = true;
      },
    });

    assert.equal(acquired, true);
    assert.equal(exited, false);
  });
});
