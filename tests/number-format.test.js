"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { compactNumber } = require("../src/renderer/number-format");

describe("compact usage number formatting", () => {
  it("uses the expected suffix at each magnitude", () => {
    assert.equal(compactNumber(0), "0");
    assert.equal(compactNumber(9_999), "9,999");
    assert.equal(compactNumber(10_000), "10k");
    assert.equal(compactNumber(12_345), "12.3k");
    assert.equal(compactNumber(1_000_000), "1M");
    assert.equal(compactNumber(12_345_678), "12.3M");
    assert.equal(compactNumber(1_000_000_000), "1B");
    assert.equal(compactNumber(12_345_678_901), "12.3B");
    assert.equal(compactNumber(1_000_000_000_000), "1T");
    assert.equal(compactNumber(12_345_678_901_234), "12.3T");
  });

  it("promotes values that round into the next unit", () => {
    assert.equal(compactNumber(999_949), "999.9k");
    assert.equal(compactNumber(999_950), "1M");
    assert.equal(compactNumber(999_949_999), "999.9M");
    assert.equal(compactNumber(999_950_000), "1B");
    assert.equal(compactNumber(999_949_999_999), "999.9B");
    assert.equal(compactNumber(999_950_000_000), "1T");
  });

  it("handles exact, negative, and invalid values", () => {
    assert.equal(compactNumber(2_000_000_000), "2B");
    assert.equal(compactNumber(-2_500_000_000), "-2.5B");
    assert.equal(compactNumber("1234567890"), "1.2B");
    assert.equal(compactNumber(Number.NaN), "0");
    assert.equal(compactNumber(Number.POSITIVE_INFINITY), "0");
  });
});
