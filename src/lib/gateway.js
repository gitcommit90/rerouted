"use strict";

const http = require("node:http");
const { DEFAULT_PORT } = require("./constants");
const logger = require("./logger");
const {
  toChatCompletionsBody,
  fromChatCompletion,
  pipeChatCompletionsSseToResponses,
  toResponsesError,
} = require("./responses-api");
const {
  toChatCompletionsBody: toAnthropicChatCompletionsBody,
  fromChatCompletion: fromChatCompletionToAnthropic,
  pipeChatCompletionsSseToAnthropic,
  toAnthropicError,
  estimateInputTokens,
} = require("./anthropic-api");

const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/**
 * OpenAI-compatible HTTP gateway.
 * Auth: Authorization: Bearer <apiKey>
 * Routes: GET /v1/models, POST /v1/chat/completions, POST /v1/responses,
 * POST /v1/messages, POST /v1/messages/count_tokens, GET /health
 */
function createGateway({
  store,
  router,
  port = DEFAULT_PORT,
  host = "127.0.0.1",
  maxBodyBytes = MAX_JSON_BODY_BYTES,
  requestActivity,
} = {}) {
  let server = null;
  let listeningPort = null;
  let listeningHost = null;

  function unauthorized(res, anthropic = false) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(anthropic
      ? {
          type: "error",
          error: { message: "Invalid API key", type: "authentication_error" },
        }
      : {
          error: {
            message: "Invalid API key",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }));
  }

  /** Accept any enabled gateway API key (multi-key). */
  function validKeys(cfg) {
    const keys = new Set();
    if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length) {
      for (const k of cfg.apiKeys) {
        if (k && k.enabled !== false && k.key) keys.add(String(k.key).trim());
      }
    } else if (cfg.apiKey) {
      // Legacy configurations are migrated to apiKeys on load.
      keys.add(String(cfg.apiKey).trim());
    }
    return keys;
  }

  function checkAuth(req) {
    const cfg = store.load();
    const hdr = req.headers.authorization || req.headers.Authorization || "";
    const m = String(hdr).match(/^Bearer\s+(.+)$/i);
    const supplied = m?.[1] || req.headers["x-api-key"] || req.headers["X-Api-Key"];
    return !!supplied && validKeys(cfg).has(String(supplied).trim());
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const tooLarge = () => {
        const error = new Error("Request body is too large");
        error.code = "REQUEST_BODY_TOO_LARGE";
        return error;
      };
      const declaredLength = Number(req.headers["content-length"]);
      if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
        req.resume();
        reject(tooLarge());
        return;
      }
      req.on("data", (c) => {
        if (settled) return;
        size += c.length;
        if (size > maxBodyBytes) {
          settled = true;
          chunks.length = 0;
          reject(tooLarge());
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${host}`);
    const path = url.pathname.replace(/^\/v1\/v1(?=\/|$)/, "/v1");
    const anthropicPath = path === "/v1/messages" || path === "/v1/messages/count_tokens";

    // CORS for local tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, X-Api-Key, Anthropic-Version, Anthropic-Beta"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === "/health" || path === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          name: "ReRouted",
          port: listeningPort,
        })
      );
      return;
    }

    if (!path.startsWith("/v1")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
      return;
    }

    if (!checkAuth(req)) {
      unauthorized(res, anthropicPath);
      return;
    }

    const cfg = store.load();
    if (cfg.serverEnabled === false) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicPath
        ? toAnthropicError({ message: "Server disabled", type: "api_error" })
        : {
            error: { message: "Server disabled", type: "api_error", code: "server_disabled" },
          }));
      return;
    }

    try {
      if (req.method === "GET" && (path === "/v1/models" || path === "/v1/models/")) {
        const models = router.listModels();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(models));
        return;
      }

      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          const tooLarge = error?.code === "REQUEST_BODY_TOO_LARGE";
          res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(toAnthropicError({
            type: "invalid_request_error",
            message: tooLarge
              ? `Request body exceeds the ${Math.floor(maxBodyBytes / (1024 * 1024))} MiB limit`
              : "Invalid JSON body",
          })));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: estimateInputTokens(body) }));
        return;
      }

      if (
        req.method === "POST" &&
        ["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(path)
      ) {
        const responsesRequest = path === "/v1/responses";
        const anthropicRequest = path === "/v1/messages";
        const routeName = responsesRequest
          ? "responses"
          : anthropicRequest
            ? "messages"
            : "chat/completions";
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            logger.warn(`${routeName}: request body too large`);
            res.writeHead(413, { "Content-Type": "application/json" });
            const message = `Request body exceeds the ${Math.floor(maxBodyBytes / (1024 * 1024))} MiB limit`;
            res.end(JSON.stringify(anthropicRequest
              ? toAnthropicError({ type: "invalid_request_error", message })
              : {
                  error: {
                    message,
                    type: "invalid_request_error",
                    code: "request_body_too_large",
                  },
                }));
            return;
          }
          logger.warn(`${routeName}: invalid JSON body`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(anthropicRequest
            ? toAnthropicError({ type: "invalid_request_error", message: "Invalid JSON body" })
            : {
                error: { message: "Invalid JSON body", type: "invalid_request_error" },
              }));
          return;
        }
        if (!body.model) {
          logger.warn(`${routeName}: missing model`);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(anthropicRequest
            ? toAnthropicError({ type: "invalid_request_error", message: "model is required" })
            : {
                error: { message: "model is required", type: "invalid_request_error" },
              }));
          return;
        }

        let routerBody;
        try {
          routerBody = responsesRequest
            ? toChatCompletionsBody(body)
            : anthropicRequest
              ? toAnthropicChatCompletionsBody(body)
              : body;
        } catch (error) {
          logger.warn(`${routeName}: invalid request`, { error: error.message });
          res.writeHead(error.status || 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify(anthropicRequest
            ? toAnthropicError(error.error || error)
            : toResponsesError(error)));
          return;
        }
        logger.info(`${routeName} request`, {
          model: body.model,
          stream: !!body.stream,
        });
        const activityId = requestActivity?.begin({
          model: body.model,
          stream: !!body.stream,
        });
        let activityStatus = 500;
        let activityOutcome = "error";
        const clientAbort = new AbortController();
        const onClientAbort = () => {
          if (!clientAbort.signal.aborted) clientAbort.abort(new Error("Client disconnected"));
        };
        req.once("aborted", onClientAbort);
        res.once("close", onClientAbort);
        try {
          const result = await router.chatCompletions({
            body: routerBody,
            signal: clientAbort.signal,
            onProviderSelected: (provider) => requestActivity?.route(activityId, provider),
          });
          if (!result.ok) {
            activityStatus = result.status || 502;
            activityOutcome = result.status === 499 ? "canceled" : "error";
            logger.error(`${routeName} failed`, {
              model: body.model,
              status: result.status,
              error: result.error?.error?.message || result.error,
            });
            res.writeHead(result.status || 502, { "Content-Type": "application/json" });
            res.end(JSON.stringify(
              responsesRequest
                ? toResponsesError(result.error)
                : anthropicRequest
                  ? toAnthropicError(result.error, "Request failed", result.status)
                  : result.error
            ));
            return;
          }
          logger.info(`${routeName} ok`, {
            model: body.model,
            stream: !!result.stream,
            providerId: result.providerId,
            upstream: result.model,
          });

          if (result.stream && result.streamPipe) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            try {
              if (responsesRequest) {
                await pipeChatCompletionsSseToResponses(result.streamPipe, res, body.model, body);
              } else if (anthropicRequest) {
                await pipeChatCompletionsSseToAnthropic(result.streamPipe, res, body.model);
              } else {
                await result.streamPipe(res);
              }
              activityStatus = 200;
              activityOutcome = "success";
            } catch (e) {
              activityStatus = clientAbort.signal.aborted ? 499 : 502;
              activityOutcome = clientAbort.signal.aborted ? "canceled" : "error";
              if (!res.writableEnded) {
                 if (!responsesRequest && !anthropicRequest) {
                   res.write(
                     `data: ${JSON.stringify({ error: { message: e.message } })}\n\n`
                   );
                 }
              }
            }
            if (!res.writableEnded) res.end();
            return;
          }

           res.writeHead(200, { "Content-Type": "application/json" });
           res.end(
              JSON.stringify(
                responsesRequest
                  ? fromChatCompletion(result.openAiJson, body.model, body)
                  : anthropicRequest
                    ? fromChatCompletionToAnthropic(result.openAiJson, body.model)
                 : result.openAiJson
             )
           );
          activityStatus = 200;
          activityOutcome = "success";
          return;
        } finally {
          req.removeListener("aborted", onClientAbort);
          res.removeListener("close", onClientAbort);
          requestActivity?.end(activityId, {
            status: activityStatus,
            outcome: activityOutcome,
          });
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicPath
        ? toAnthropicError({ message: "Not found", type: "not_found_error" })
        : { error: { message: "Not found", type: "invalid_request_error" } }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicPath
        ? toAnthropicError({ message: e.message || "Internal error", type: "api_error" })
        : {
            error: { message: e.message || "Internal error", type: "api_error" },
          }));
    }
  }

  function resolveHost(h) {
    const cfg = store.load();
    return h || cfg.bindHost || host || "127.0.0.1";
  }

  function start(preferredPort, preferredHost) {
    const p = preferredPort ?? store.load().port ?? port;
    const h = resolveHost(preferredHost);
    return new Promise((resolve, reject) => {
      if (server) {
        resolve({ port: listeningPort, host: listeningHost || h });
        return;
      }
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
          }
          res.end(JSON.stringify({ error: { message: e.message } }));
        });
      });
      server.on("error", reject);
      server.listen(p, h, () => {
        listeningPort = server.address().port;
        listeningHost = h;
        resolve({ port: listeningPort, host: h });
      });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      server.close(() => {
        server = null;
        listeningPort = null;
        listeningHost = null;
        resolve();
      });
    });
  }

  async function restart() {
    await stop();
    return start();
  }

  function isListening() {
    return !!server && listeningPort != null;
  }

  function getAddress() {
    // Always advertise loopback for copy-paste; LAN/Tailscale uses the machine IP
    return listeningPort ? `http://127.0.0.1:${listeningPort}/v1` : null;
  }

  return { start, stop, restart, isListening, getAddress, checkAuth, handle, validKeys };
}

module.exports = { createGateway, MAX_JSON_BODY_BYTES };
