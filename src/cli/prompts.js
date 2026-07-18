"use strict";

const readline = require("node:readline");
const { Writable } = require("node:stream");

function createPrompts({ input = process.stdin, output = process.stdout } = {}) {
  let muted = false;
  const terminalOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({
    input,
    output: terminalOutput,
    terminal: !!input.isTTY && !!output.isTTY,
  });

  async function text(message, { defaultValue = "", required = false } = {}) {
    while (true) {
      const suffix = defaultValue ? ` (${defaultValue})` : "";
      const answer = (await new Promise((resolve) => rl.question(`${message}${suffix}: `, resolve))).trim();
      const value = answer || defaultValue;
      if (value || !required) return value;
      output.write("Please enter a value.\n");
    }
  }

  async function confirm(message, { defaultValue = true } = {}) {
    const hint = defaultValue ? "Y/n" : "y/N";
    const answer = (await text(`${message} [${hint}]`)).toLowerCase();
    if (!answer) return defaultValue;
    return answer === "y" || answer === "yes";
  }

  async function secret(message, { required = false } = {}) {
    while (true) {
      output.write(`${message}: `);
      muted = true;
      const value = await new Promise((resolve) => rl.question("", resolve)).finally(() => {
        muted = false;
      });
      output.write("\n");
      if (value || !required) return value;
      output.write("Please enter a value.\n");
    }
  }

  async function select(message, options, { defaultIndex = 0 } = {}) {
    if (!Array.isArray(options) || !options.length) throw new TypeError("Select requires options");
    output.write(`\n${message}\n`);
    options.forEach((option, index) => {
      output.write(`  ${index + 1}. ${typeof option === "string" ? option : option.label}\n`);
    });
    while (true) {
      const value = await text("Choose", { defaultValue: String(defaultIndex + 1) });
      const index = Number(value) - 1;
      if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
      output.write(`Choose a number from 1 to ${options.length}.\n`);
    }
  }

  async function multiSelect(message, options, { defaultAll = false } = {}) {
    if (!Array.isArray(options) || !options.length) return [];
    output.write(`\n${message}\n`);
    options.forEach((option, index) => {
      output.write(`  ${index + 1}. ${typeof option === "string" ? option : option.label}\n`);
    });
    const hint = defaultAll ? "all" : "none";
    while (true) {
      const answer = (await text("Choose comma-separated numbers", { defaultValue: hint })).toLowerCase();
      if (answer === "none" || answer === "skip") return [];
      if (answer === "all") return options.map((_, index) => index);
      const indexes = [...new Set(answer.split(",").map((item) => Number(item.trim()) - 1))];
      if (indexes.length && indexes.every((index) => Number.isInteger(index) && index >= 0 && index < options.length)) {
        return indexes;
      }
      output.write(`Enter numbers from 1 to ${options.length}, "all", or "none".\n`);
    }
  }

  function close() {
    rl.close();
  }

  return { text, secret, confirm, select, multiSelect, close };
}

module.exports = { createPrompts };
