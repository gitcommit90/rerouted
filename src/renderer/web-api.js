(function () {
  "use strict";

  if (window.rerouted) return;

  const listeners = new Map();
  let events = null;

  function emit(channel, payload) {
    for (const listener of listeners.get(channel) || []) {
      try {
        listener(payload);
      } catch {
        // A dashboard event listener must not stop the transport.
      }
    }
  }

  function ensureEvents() {
    if (events || typeof EventSource !== "function") return;
    events = new EventSource("api/events");
    for (const channel of [
      "app:update-state",
      "app:session-lock-changed",
      "app:provider-identities-updated",
      "app:request-activity",
      "app:open-settings",
    ]) {
      events.addEventListener(channel, (event) => {
        try {
          emit(channel, JSON.parse(event.data));
        } catch {
          // Ignore malformed or stale server events.
        }
      });
    }
  }

  async function invoke(channel, ...args) {
    const oauthWindow = channel === "app:oauth-start"
      ? window.open("about:blank", "_blank")
      : null;
    const response = await fetch("api/invoke", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, args }),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      result = { ok: false, error: `Dashboard request failed (HTTP ${response.status})` };
    }
    if (!response.ok && !result?.error) {
      result = { ok: false, error: `Dashboard request failed (HTTP ${response.status})` };
    }
    if (channel === "app:oauth-start" && result?.ok && result.authUrl) {
      if (oauthWindow) {
        oauthWindow.opener = null;
        oauthWindow.location.replace(result.authUrl);
      } else {
        window.open(result.authUrl, "_blank", "noopener,noreferrer");
      }
    } else if (oauthWindow) {
      oauthWindow.close();
    } else if (channel === "app:open-external" && result?.ok && args[0]) {
      window.open(String(args[0]), "_blank", "noopener,noreferrer");
    }
    return result;
  }

  window.rerouted = {
    invoke,
    on(channel, callback) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(callback);
      ensureEvents();
      return () => listeners.get(channel)?.delete(callback);
    },
  };

  document.documentElement.classList.add("dashboard-runtime");
})();
