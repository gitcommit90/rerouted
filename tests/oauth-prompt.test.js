"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { oauthPrompt } = require("../src/renderer/oauth-prompt");

describe("OAuth renderer prompts", () => {
  it("treats xAI's displayed code as the primary completion input", () => {
    const prompt = oauthPrompt("xai");

    assert.equal(prompt.primaryPaste, true);
    assert.match(prompt.instruction, /paste the code xAI shows you/i);
    assert.match(prompt.fieldLabel, /authorization code/i);
    assert.match(prompt.placeholder, /code shown by xAI/i);
  });

  it("keeps callback URL guidance for providers that return through the browser", () => {
    assert.equal(oauthPrompt("claude").primaryPaste, false);
    assert.match(oauthPrompt("claude").placeholder, /callback URL/i);
    assert.equal(oauthPrompt("chatgpt").primaryPaste, false);
  });
});
