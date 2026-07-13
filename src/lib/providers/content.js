"use strict";

function imageUrlFromPart(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type !== "image_url" && part.type !== "input_image") return null;
  const value = part.image_url;
  const url = typeof value === "string" ? value : value?.url;
  if (!url || typeof url !== "string") return null;
  return {
    url,
    detail: part.detail || (typeof value === "object" ? value?.detail : undefined),
  };
}

function parseOpenAiContent(content) {
  if (!Array.isArray(content)) {
    return [{ type: "text", text: typeof content === "string" ? content : String(content ?? "") }];
  }

  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (
      part?.type === "text" ||
      part?.type === "input_text" ||
      part?.type === "output_text"
    ) {
      parts.push({ type: "text", text: String(part.text ?? "") });
      continue;
    }
    const image = imageUrlFromPart(part);
    if (image) parts.push({ type: "image", ...image });
  }
  return parts;
}

function textFromOpenAiContent(content, separator = "\n") {
  return parseOpenAiContent(content)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(separator);
}

function toResponsesContent(content, role, { collapseText = false } = {}) {
  const parts = parseOpenAiContent(content);
  if (collapseText && !parts.some((part) => part.type === "image")) {
    return parts.map((part) => part.text).join("\n");
  }
  if (!parts.length) {
    return [{ type: role === "assistant" ? "output_text" : "input_text", text: "" }];
  }
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
    }
    return {
      type: "input_image",
      image_url: part.url,
      ...(part.detail ? { detail: part.detail } : {}),
    };
  });
}

function toGeminiParts(content) {
  const parts = [];
  for (const part of parseOpenAiContent(content)) {
    if (part.type === "text") {
      parts.push({ text: part.text });
      continue;
    }
    const data = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is.exec(part.url);
    if (data) {
      parts.push({ inlineData: { mimeType: data[1], data: data[2] } });
    } else if (/^https?:\/\//i.test(part.url)) {
      parts.push({ fileData: { fileUri: part.url, mimeType: "image/*" } });
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

module.exports = {
  parseOpenAiContent,
  textFromOpenAiContent,
  toResponsesContent,
  toGeminiParts,
};
