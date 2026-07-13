#!/usr/bin/env node
"use strict";
// Minimal static file server for the ReRouted landing page.
// Serves site/ over loopback for the cloudflared apex tunnel.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "site");
const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  try {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
    let visitorScheme = "";
    try {
      visitorScheme = JSON.parse(String(req.headers["cf-visitor"] || "{}"))?.scheme || "";
    } catch {
      /* ignore malformed proxy metadata */
    }
    const requestHost = String(req.headers.host || "").split(":")[0].toLowerCase();
    if (requestHost === "www.rerouted.dev" || forwardedProto === "http" || visitorScheme === "http") {
      res.writeHead(308, { location: `https://rerouted.dev${req.url || "/"}` });
      res.end();
      return;
    }

    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    let rel = urlPath === "/" ? "/index.html" : urlPath;
    // resolve inside ROOT only — block traversal
    const abs = path.normalize(path.join(ROOT, rel));
    if (!abs.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(abs, (err, st) => {
      let file = abs;
      if (!err && st.isDirectory()) file = path.join(abs, "index.html");
      fs.readFile(file, (e, buf) => {
        if (e) {
          res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
          res.end("<h1>404</h1>");
          return;
        }
        const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, {
          "content-type": type,
          "cache-control": "public, max-age=300",
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
        });
        res.end(buf);
      });
    });
  } catch {
    res.writeHead(500).end("error");
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`serving ${ROOT} at http://${HOST}:${PORT}\n`);
});
