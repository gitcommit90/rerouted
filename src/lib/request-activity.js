"use strict";

const { randomUUID } = require("node:crypto");

function createRequestActivity({ now = Date.now, idFactory = randomUUID } = {}) {
  const active = new Map();
  const listeners = new Set();

  function snapshot() {
    return [...active.values()].map((request) => ({ ...request }));
  }

  function publish(type, request) {
    const event = { type, request: { ...request }, active: snapshot() };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Activity is decorative telemetry and must never affect request routing.
      }
    }
  }

  function begin({ model, stream = false } = {}) {
    const request = {
      id: idFactory(),
      model: String(model || ""),
      stream: !!stream,
      startedAt: now(),
      providerId: null,
      providerType: null,
      providerName: null,
    };
    active.set(request.id, request);
    publish("started", request);
    return request.id;
  }

  function route(id, provider = {}) {
    const current = active.get(id);
    if (!current) return false;
    const request = {
      ...current,
      providerId: provider.providerId || null,
      providerType: provider.providerType || null,
      providerName: provider.providerName || null,
      upstreamModel: provider.upstreamModel || provider.model || null,
      routedAt: now(),
    };
    active.set(id, request);
    publish("routed", request);
    return true;
  }

  function end(id, { status = 200, outcome = "success" } = {}) {
    const current = active.get(id);
    if (!current) return false;
    active.delete(id);
    publish("finished", {
      ...current,
      status,
      outcome,
      finishedAt: now(),
    });
    return true;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { begin, route, end, snapshot, subscribe };
}

module.exports = { createRequestActivity };
