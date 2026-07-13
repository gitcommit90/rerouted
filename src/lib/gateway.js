"use strict";

const http = require("node:http");
const { DEFAULT_PORT } = require("./constants");
const logger = require("./logger");

const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/**
 * OpenAI-compatible HTTP gateway.
 * Auth: Authorization: Bearer <apiKey>
 * Routes: GET /v1/models, POST /v1/chat/completions, GET /health
 */
function createGateway({
  store,
  router,
  port = DEFAULT_PORT,
  host = "127.0.0.1",
  maxBodyBytes = MAX_JSON_BODY_BYTES,
} = {}) {
  let server = null;
  let listeningPort = null;
  let listeningHost = null;

  function unauthorized(res) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "Invalid API key",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      })
    );
  }

  /** Accept any enabled gateway API key (multi-key). */
  function validKeys(cfg) {
    const keys = new Set();
    if (Array.isArray(cfg.apiKeys)) {
      for (const k of cfg.apiKeys) {
        if (k && k.enabled !== false && k.key) keys.add(String(k.key).trim());
      }
    }
    if (cfg.apiKey) keys.add(String(cfg.apiKey).trim());
    return keys;
  }

  function checkAuth(req) {
    const cfg = store.load();
    const hdr = req.headers.authorization || req.headers.Authorization || "";
    const m = String(hdr).match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    return validKeys(cfg).has(m[1].trim());
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
    const path = url.pathname;

    // CORS for local tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
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
      unauthorized(res);
      return;
    }

    const cfg = store.load();
    if (cfg.serverEnabled === false) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Server disabled", type: "api_error", code: "server_disabled" },
        })
      );
      return;
    }

    try {
      if (req.method === "GET" && (path === "/v1/models" || path === "/v1/models/")) {
        const models = router.listModels();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(models));
        return;
      }

      if (req.method === "POST" && path === "/v1/chat/completions") {
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          if (error?.code === "REQUEST_BODY_TOO_LARGE") {
            logger.warn("chat/completions: request body too large");
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: `Request body exceeds the ${Math.floor(maxBodyBytes / (1024 * 1024))} MiB limit`,
                  type: "invalid_request_error",
                  code: "request_body_too_large",
                },
              })
            );
            return;
          }
          logger.warn("chat/completions: invalid JSON body");
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "Invalid JSON body", type: "invalid_request_error" },
            })
          );
          return;
        }
        if (!body.model) {
          logger.warn("chat/completions: missing model");
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "model is required", type: "invalid_request_error" },
            })
          );
          return;
        }

        logger.info("chat/completions request", {
          model: body.model,
          stream: !!body.stream,
        });
        const clientAbort = new AbortController();
        const onClientAbort = () => {
          if (!clientAbort.signal.aborted) clientAbort.abort(new Error("Client disconnected"));
        };
        req.once("aborted", onClientAbort);
        res.once("close", onClientAbort);
        try {
          const result = await router.chatCompletions({ body, signal: clientAbort.signal });
          if (!result.ok) {
            logger.error("chat/completions failed", {
              model: body.model,
              status: result.status,
              error: result.error?.error?.message || result.error,
            });
            res.writeHead(result.status || 502, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.error));
            return;
          }
          logger.info("chat/completions ok", {
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
              await result.streamPipe(res);
            } catch (e) {
              if (!res.writableEnded) {
                res.write(
                  `data: ${JSON.stringify({ error: { message: e.message } })}\n\n`
                );
              }
            }
            if (!res.writableEnded) res.end();
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.openAiJson));
          return;
        } finally {
          req.removeListener("aborted", onClientAbort);
          res.removeListener("close", onClientAbort);
        }
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: e.message || "Internal error", type: "api_error" },
        })
      );
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
