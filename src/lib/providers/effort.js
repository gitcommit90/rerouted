"use strict";

const LEVEL_TO_BUDGET = {
  minimal: 1024,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 63000,
};

function normalizeLevel(value) {
  if (typeof value !== "string") return null;
  const level = value.trim().toLowerCase();
  if (!level) return null;
  if (level === "off" || level === "disabled") return "none";
  if (level === "on" || level === "enabled" || level === "thinking") return "high";
  if (["none", "auto", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
    return level;
  }
  return null;
}

function budgetToLevel(value) {
  const budget = Number(value);
  if (!Number.isFinite(budget)) return null;
  if (budget === 0) return "none";
  if (budget < 0) return "auto";
  if (budget <= 1024) return "low";
  if (budget <= 16384) return "medium";
  if (budget <= 28672) return "high";
  if (budget <= 32768) return "xhigh";
  return "max";
}

function extractEffort(body = {}) {
  const outputEffort = normalizeLevel(body.output_config?.effort);
  if (outputEffort) return { level: outputEffort };

  const thinking = body.thinking;
  if (thinking && typeof thinking === "object") {
    if (thinking.type === "disabled") return { level: "none" };
    if (thinking.type === "adaptive") return { level: "auto" };
    if (thinking.type === "enabled") {
      const budget = Number(thinking.budget_tokens);
      if (Number.isFinite(budget) && budget > 0) {
        return { level: budgetToLevel(budget), budget };
      }
      return { level: "auto" };
    }
  }

  const responseEffort = normalizeLevel(body.reasoning?.effort);
  if (responseEffort) return { level: responseEffort };

  const openAiEffort = normalizeLevel(body.reasoning_effort);
  if (openAiEffort) return { level: openAiEffort };

  const thinkingConfig =
    body.thinkingConfig ||
    body.generationConfig?.thinkingConfig ||
    body.request?.generationConfig?.thinkingConfig;
  if (thinkingConfig && typeof thinkingConfig === "object") {
    const geminiLevel = normalizeLevel(thinkingConfig.thinkingLevel);
    if (geminiLevel) return { level: geminiLevel };
    if (thinkingConfig.thinkingBudget !== undefined) {
      const budget = Number(thinkingConfig.thinkingBudget);
      const level = budgetToLevel(budget);
      if (level) return { level, ...(budget > 0 ? { budget } : {}) };
    }
  }

  return null;
}

function clearForeignEffortFields(body) {
  delete body.output_config;
  delete body.thinking;
  delete body.thinkingConfig;
  delete body.reasoning;
  if (body.generationConfig?.thinkingConfig) delete body.generationConfig.thinkingConfig;
  if (body.request?.generationConfig?.thinkingConfig) {
    delete body.request.generationConfig.thinkingConfig;
  }
}

function applyResponsesEffort(target, source) {
  const intent = extractEffort(source);
  if (!intent) return target;
  const summary = source.reasoning?.summary || "auto";
  target.reasoning = { effort: intent.level === "max" ? "xhigh" : intent.level, summary };
  return target;
}

function applyOpenAIEffort(target, source, { omit = false } = {}) {
  const intent = extractEffort(source);
  clearForeignEffortFields(target);
  delete target.reasoning_effort;
  if (!omit && intent) {
    target.reasoning_effort = intent.level === "max" ? "xhigh" : intent.level;
  }
  return target;
}

function applyGlmEffort(target, source) {
  const nativeThinking =
    source.thinking && typeof source.thinking === "object" ? { ...source.thinking } : null;
  const intent = extractEffort(source);
  clearForeignEffortFields(target);
  delete target.reasoning_effort;
  if (nativeThinking) {
    target.thinking = nativeThinking;
  } else if (intent) {
    target.thinking = { type: intent.level === "none" ? "disabled" : "enabled" };
  }
  return target;
}

function claudeAdaptiveEffort(level) {
  if (level === "minimal") return "low";
  if (level === "xhigh") return "high";
  return level;
}

function applyClaudeEffort(target, source, model) {
  const intent = extractEffort(source);
  if (!intent) return target;
  if (intent.level === "none") {
    target.thinking = { type: "disabled" };
    return target;
  }

  if (!/haiku/i.test(String(model))) {
    target.output_config = { effort: claudeAdaptiveEffort(intent.level) };
    return target;
  }

  if (intent.level === "auto") {
    target.thinking = { type: "enabled" };
    return target;
  }

  let budget = intent.budget || LEVEL_TO_BUDGET[intent.level] || LEVEL_TO_BUDGET.medium;
  budget = Math.max(1024, Math.min(63000, budget));
  target.max_tokens = Math.max(Number(target.max_tokens) || 0, budget + 1024);
  target.max_tokens = Math.min(64000, target.max_tokens);
  budget = Math.min(budget, target.max_tokens - 1);
  target.thinking = { type: "enabled", budget_tokens: budget };
  return target;
}

function geminiThinkingLevel(level) {
  if (level === "none" || level === "minimal") return "minimal";
  if (level === "xhigh" || level === "max" || level === "auto") return "high";
  return level;
}

function applyGeminiEffort(generationConfig, source) {
  const intent = extractEffort(source);
  if (!intent) return generationConfig;
  const thinkingLevel = geminiThinkingLevel(intent.level);
  generationConfig.thinkingConfig = {
    thinkingLevel,
    includeThoughts: intent.level !== "none",
  };
  return generationConfig;
}

module.exports = {
  LEVEL_TO_BUDGET,
  normalizeLevel,
  budgetToLevel,
  extractEffort,
  applyResponsesEffort,
  applyOpenAIEffort,
  applyGlmEffort,
  applyClaudeEffort,
  applyGeminiEffort,
};
