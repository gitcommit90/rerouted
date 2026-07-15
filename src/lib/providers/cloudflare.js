"use strict";

const openaiCompat = require("./openai-compat");

const MODELS_TIMEOUT_MS = 15_000;
const MODELS_PAGE_SIZE = 100;
const MAX_MODEL_PAGES = 10;

function modelsSearchUrl(baseUrl, page = 1) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const url = new URL(`${base.replace(/\/v1$/, "")}/models/search`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(MODELS_PAGE_SIZE));
  return url.toString();
}

function taskName(model) {
  const task = model?.task;
  return String(typeof task === "string" ? task : task?.name || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

function isChatModel(model) {
  const task = taskName(model);
  return task === "text generation" || task === "text to text" || task.includes("chat");
}

function cloudflareError(data) {
  const messages = (data?.errors || [])
    .map((error) => [error?.code, error?.message].filter(Boolean).join(": "))
    .filter(Boolean);
  return messages.join("; ") || "invalid Cloudflare models response";
}

async function listModels(provider, { fetchImpl = fetch, timeoutMs = MODELS_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  const timeoutError = new Error(`models fetch timed out after ${timeoutMs}ms`);
  timeoutError.name = "TimeoutError";
  timeoutError.code = "ETIMEDOUT";
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      controller.abort(timeoutError);
    }, timeoutMs);
  });
  const request = (async () => {
    const catalog = [];
    let reachedEnd = false;
    for (let page = 1; page <= MAX_MODEL_PAGES; page += 1) {
      const res = await fetchImpl(modelsSearchUrl(provider.baseUrl, page), {
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const error = new Error(`models fetch failed: ${res.status} ${text}`);
        error.status = res.status;
        throw error;
      }
      const data = await res.json();
      if (data?.success === false || !Array.isArray(data?.result)) {
        throw new Error(`models fetch failed: ${cloudflareError(data)}`);
      }
      if (!data.result.length) {
        reachedEnd = true;
        break;
      }
      catalog.push(...data.result);
    }
    if (!reachedEnd) throw new Error("models fetch failed: Cloudflare catalog exceeded 10 pages");

    const seen = new Set();
    return catalog
      .filter(isChatModel)
      .map((model) => String(model?.name || "").trim())
      .filter((id) => id && !seen.has(id) && seen.add(id))
      .map((id) => ({ id, name: id }));
  })();

  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function chat(provider, options) {
  return openaiCompat.chat(provider, options);
}

module.exports = { chat, listModels, modelsSearchUrl };
