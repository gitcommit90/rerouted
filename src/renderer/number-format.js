"use strict";

(function exposeNumberFormat(root) {
  const UNITS = [
    { value: 1_000, suffix: "k" },
    { value: 1_000_000, suffix: "M" },
    { value: 1_000_000_000, suffix: "B" },
    { value: 1_000_000_000_000, suffix: "T" },
  ];

  function compactNumber(value) {
    const parsed = Number(value);
    const number = Number.isFinite(parsed) ? parsed : 0;
    const absolute = Math.abs(number);
    if (absolute < 10_000) return number.toLocaleString("en-US");

    let unitIndex = 0;
    while (unitIndex < UNITS.length - 1 && absolute >= UNITS[unitIndex + 1].value) {
      unitIndex += 1;
    }

    let unit = UNITS[unitIndex];
    let rounded = Number((number / unit.value).toFixed(1));
    if (Math.abs(rounded) >= 1_000 && unitIndex < UNITS.length - 1) {
      unit = UNITS[++unitIndex];
      rounded = Number((number / unit.value).toFixed(1));
    }
    return `${rounded.toFixed(1).replace(/\.0$/, "")}${unit.suffix}`;
  }

  const api = { compactNumber };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReroutedNumberFormat = api;
})(typeof window !== "undefined" ? window : null);
