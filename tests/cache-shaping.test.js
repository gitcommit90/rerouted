"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const chatgpt = require("../src/lib/providers/chatgpt");
const claude = require("../src/lib/providers/claude");
const openaiCompat = require("../src/lib/providers/openai-compat");

const scoped = (content, cache_scope) => ({
  role: "system",
  content,
  extra_content: { openai: { cache_scope } },
});

describe("provider-selected cache shaping", () => {
  it("keeps ChatGPT instructions stable and moves volatile context behind durable history", () => {
    const payload = chatgpt.toResponsesBody({
      prompt_cache_key: "scope-key",
      messages: [
        scoped("stable identity", "stable_instruction"),
        scoped("volatile 12:34:56", "dynamic_context"),
        { role: "user", content: "old task" },
        { role: "assistant", content: "old answer" },
        scoped("prior invocation boundary", "inline_context"),
        scoped("current invocation 42", "dynamic_context"),
        { role: "user", content: "current task" },
      ],
    }, "gpt-5.6-sol", true);

    assert.equal(payload.instructions, "stable identity");
    assert.equal(payload.prompt_cache_key, "scope-key");
    assert.deepEqual(payload.input.map((item) => [item.role, item.content?.[0]?.text]), [
      ["user", "old task"],
      ["assistant", "old answer"],
      ["developer", "prior invocation boundary"],
      ["developer", "volatile 12:34:56"],
      ["developer", "current invocation 42"],
      ["user", "current task"],
    ]);
  });

  it("adds Claude base and rolling tool-result breakpoints after Claude is selected", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      ...[1, 2, 3, 4].flatMap((number) => [
        { role: "assistant", content: "", tool_calls: [{ id: `t${number}`, type: "function", function: { name: "shell", arguments: "{}" } }] },
        { role: "tool", tool_call_id: `t${number}`, content: `result ${number}` },
      ]),
    ];
    const payload = claude.toAnthropicBody({ messages }, "claude-fable-5-1", true);
    const blocks = payload.messages.flatMap((message) => message.content);
    const marked = blocks.filter((block) => block.cache_control);
    assert.equal(marked.length, 4);
    assert.equal(blocks.find((block) => block.type === "text" && block.text === "task").cache_control.type, "ephemeral");
    assert.equal(blocks.find((block) => block.type === "tool_result" && block.tool_use_id === "t1").cache_control, undefined);
    for (const id of ["t2", "t3", "t4"]) {
      assert.equal(blocks.find((block) => block.type === "tool_result" && block.tool_use_id === id).cache_control.type, "ephemeral");
    }
  });

  it("keeps Claude volatile context behind durable history and preserves OAuth cache boundaries", () => {
    const payload = claude.toAnthropicBody({
      messages: [
        scoped("stable identity", "stable_instruction"),
        scoped("volatile 12:34:56", "dynamic_context"),
        { role: "user", content: "old task" },
        { role: "assistant", content: "old answer" },
        scoped("prior invocation boundary", "inline_context"),
        scoped("current invocation 42", "dynamic_context"),
        { role: "user", content: "current task" },
      ],
    }, "claude-opus-5-5", true);

    const cloaked = claude.applyCloaking(payload, "sk-ant-oat-test", "00000000-0000-4000-8000-000000000000");
    const blocks = cloaked.messages.flatMap((message) => message.content);
    const stableIndex = blocks.findIndex((block) => block.text?.includes("stable identity"));
    const oldTaskIndex = blocks.findIndex((block) => block.text === "old task");
    const oldAnswerIndex = blocks.findIndex((block) => block.text === "old answer");
    const inlineIndex = blocks.findIndex((block) => block.text?.includes("prior invocation boundary"));
    const volatileIndex = blocks.findIndex((block) => block.text?.includes("volatile 12:34:56"));
    const currentIndex = blocks.findIndex((block) => block.text === "current task");

    assert.ok(stableIndex >= 0 && stableIndex < oldTaskIndex);
    assert.ok(oldTaskIndex < oldAnswerIndex && oldAnswerIndex < inlineIndex);
    assert.ok(inlineIndex < volatileIndex && volatileIndex < currentIndex);
    assert.equal(blocks[stableIndex].cache_control.type, "ephemeral", "stable identity remains a reusable OAuth breakpoint");
    assert.equal(blocks[inlineIndex].cache_control.type, "ephemeral", "the durable history tail is cached before volatile context");
    assert.equal(blocks[volatileIndex].cache_control, undefined);
    assert.doesNotMatch(blocks.slice(0, inlineIndex + 1).map((block) => block.text || "").join("\n"), /volatile 12:34:56|current invocation 42/);
  });

  it("reserves Claude breakpoints for stable/history prefixes before rolling tool results", () => {
    const messages = [
      scoped("stable identity", "stable_instruction"),
      scoped("volatile", "dynamic_context"),
      { role: "user", content: "old task" },
      { role: "assistant", content: "old answer" },
      scoped("current invocation", "dynamic_context"),
      { role: "user", content: "current task" },
      ...[1, 2, 3].flatMap((number) => [
        { role: "assistant", content: "", tool_calls: [{ id: `t${number}`, type: "function", function: { name: "shell", arguments: "{}" } }] },
        { role: "tool", tool_call_id: `t${number}`, content: `result ${number}` },
      ]),
    ];
    const payload = claude.toAnthropicBody({ messages }, "claude-opus-5-5", true);
    const blocks = [...(Array.isArray(payload.system) ? payload.system : []), ...payload.messages.flatMap((message) => message.content)];
    const marked = blocks.filter((block) => block.cache_control);
    assert.equal(marked.length, 4);
    assert.equal(blocks.find((block) => block.text === "stable identity").cache_control.type, "ephemeral");
    assert.equal(blocks.find((block) => block.text === "old answer").cache_control.type, "ephemeral");
    assert.equal(blocks.find((block) => block.type === "tool_result" && block.tool_use_id === "t1").cache_control, undefined);
    for (const id of ["t2", "t3"]) {
      assert.equal(blocks.find((block) => block.type === "tool_result" && block.tool_use_id === id).cache_control.type, "ephemeral");
    }
  });

  it("does not leak provider-selected cache keys to arbitrary compatible servers", async () => {
    let sent;
    await openaiCompat.chat({ baseUrl: "https://custom.test/v1", apiKey: "key" }, {
      model: "custom-model",
      body: { prompt_cache_key: "scoped-key", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [] }), { status: 200 }); },
    });
    assert.equal(sent.prompt_cache_key, undefined);
  });

  it("preserves explicit Claude cache policy without adding automatic breakpoints", () => {
    const payload = claude.toAnthropicBody({ messages: [{ role: "user", content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] }] }, "claude-fable-5-1", false);
    assert.equal(JSON.stringify(payload).match(/cache_control/g)?.length, 1);
  });
});
