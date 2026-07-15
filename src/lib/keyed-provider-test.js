"use strict";

const { runProviderModelTest } = require("./model-test");
const openaiCompat = require("./providers/openai-compat");
const { getAdapter } = require("./providers");

async function testKeyedProvider(
  { baseUrl, apiKey, modelId, providerType } = {},
  { adapter, logger } = {}
) {
  const finalBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "");
  const finalApiKey = String(apiKey || "").trim();
  const exactModelId = String(modelId || "").trim();
  const selectedAdapter = adapter || getAdapter(providerType) || openaiCompat;

  if (!finalBaseUrl || !finalApiKey) {
    return { ok: false, error: "Base URL and API key required" };
  }

  const provider = {
    type: providerType || "openai-compat",
    name: "Custom",
    baseUrl: finalBaseUrl,
    apiKey: finalApiKey,
  };

  if (exactModelId) {
    const result = await runProviderModelTest({
      adapter: selectedAdapter,
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
    const models = await selectedAdapter.listModels(provider);
    return { ok: true, models, validation: "models" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = { testKeyedProvider };
