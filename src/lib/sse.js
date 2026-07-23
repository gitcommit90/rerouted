"use strict";

/**
 * Minimal SSE helpers for OpenAI chat.completion.chunk passthrough / synthesis.
 */

function openaiChunk({ id, model, content, finishReason = null, role, tool_calls, extra_content }) {
  const delta = {};
  if (role) delta.role = role;
  if (content !== undefined && content !== null) delta.content = content;
  if (tool_calls) delta.tool_calls = tool_calls;
  if (extra_content) delta.extra_content = extra_content;
  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "unknown",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function formatSseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const SSE_DONE = "data: [DONE]\n\n";
const SSE_KEEPALIVE = ": keepalive\n\n";
const DEFAULT_SSE_HEARTBEAT_MS = 25_000;

/**
 * Wrap a client-facing SSE sink and emit the configured liveness frame whenever
 * the stream has otherwise been silent for the configured interval.
 */
function createSseHeartbeat(
  res,
  { intervalMs = DEFAULT_SSE_HEARTBEAT_MS, heartbeat = SSE_KEEPALIVE } = {}
) {
  let timer = null;
  let stopped = false;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || intervalMs <= 0) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || res.writableEnded || res.destroyed) return;
      res.write(heartbeat);
      schedule();
    }, intervalMs);
    timer.unref?.();
  }

  const sink = {
    write(...args) {
      const written = res.write(...args);
      schedule();
      return written;
    },
    get writableEnded() {
      return res.writableEnded;
    },
    get destroyed() {
      return res.destroyed;
    },
  };

  schedule();
  return {
    sink,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Parse SSE text stream lines into { event, data } objects.
 * Handles partial buffers via returned remainder.
 */
function chunkToString(chunk) {
  if (chunk == null) return "";
  if (typeof chunk === "string") return chunk;
  // Web streams yield Uint8Array — Buffer.from is required (Uint8Array#toString is wrong)
  if (typeof Buffer !== "undefined" && (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) {
    return Buffer.from(chunk).toString("utf8");
  }
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk).toString("utf8");
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("utf8");
  return String(chunk);
}

function createSseParser() {
  let buf = "";
  return {
    push(chunk) {
      buf += chunkToString(chunk);
      const events = [];
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
        }
        if (data) events.push({ event, data });
      }
      return events;
    },
    flush() {
      if (!buf.trim()) return [];
      const leftover = buf;
      buf = "";
      return leftover.startsWith("data:")
        ? [{ event: "message", data: leftover.replace(/^data:\s?/, "").trim() }]
        : [];
    },
  };
}

/**
 * Pipe an upstream OpenAI-compatible SSE body to a Node response, with optional transform.
 * transformChunk(parsedObj) → obj | null (null = skip).
 */
async function pipeOpenAiSse(upstreamBody, res, { transformChunk, onDone } = {}) {
  const parser = createSseParser();
  const reader = upstreamBody.getReader ? upstreamBody.getReader() : null;

  if (!reader && upstreamBody[Symbol.asyncIterator]) {
    for await (const chunk of upstreamBody) {
      await emit(parser.push(chunk));
    }
  } else if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await emit(parser.push(value));
    }
  } else if (typeof upstreamBody.on === "function") {
    await new Promise((resolve, reject) => {
      upstreamBody.on("data", (chunk) => {
        emit(parser.push(chunk)).catch(reject);
      });
      upstreamBody.on("end", resolve);
      upstreamBody.on("error", reject);
    });
  }

  async function emit(events) {
    for (const ev of events) {
      if (ev.data === "[DONE]") {
        res.write(SSE_DONE);
        if (onDone) onDone();
        continue;
      }
      let obj;
      try {
        obj = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const out = transformChunk ? transformChunk(obj) : obj;
      if (out) res.write(formatSseData(out));
    }
  }

  res.write(SSE_DONE);
  if (onDone) onDone();
}

module.exports = {
  openaiChunk,
  formatSseData,
  SSE_DONE,
  SSE_KEEPALIVE,
  DEFAULT_SSE_HEARTBEAT_MS,
  createSseHeartbeat,
  createSseParser,
  chunkToString,
  pipeOpenAiSse,
};
