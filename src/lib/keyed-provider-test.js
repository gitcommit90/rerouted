"use strict";

const { runProviderModelTest } = require("./model-test");
const openaiCompat = require("./providers/openai-compat");

async function testKeyedProvider(
  { baseUrl, apiKey, modelId } = {},
  { adapter = openaiCompat, logger } = {}
) {
  const finalBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const finalApiKey = String(apiKey || "").trim();
  const exactModelId = String(modelId || "").trim();

  if (!finalBaseUrl || !finalApiKey) {
    return { ok: false, error: "Base URL and API key required" };
  }

  const provider = {
    type: "openai-compat",
    name: "Custom",
    baseUrl: finalBaseUrl,
    apiKey: finalApiKey,
  };

  if (exactModelId) {
    const result = await runProviderModelTest({
      adapter,
      provider,
      model: exactModelId,
      logger,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      models: [{ id: exactModelId, name: exactModelId }],
      validation: "chat-completions",
    };
  }

  try {
    const models = await adapter.listModels(provider);
    return { ok: true, models, validation: "models" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { testKeyedProvider };
