"use strict";

(function exposeOAuthPrompt(root) {
  function oauthPrompt(type) {
    if (type === "xai") {
      return {
        instruction:
          "After authorizing, paste the code xAI shows you. A full callback URL also works.",
        status: "Paste the authorization code xAI shows you below.",
        fieldLabel: "Authorization code or callback URL",
        placeholder: "Paste the code shown by xAI",
        primaryPaste: true,
      };
    }
    if (type === "claude") {
      return {
        instruction:
          "After authorizing, paste the full localhost callback URL if the browser cannot return automatically.",
        status: "After authorizing, paste the full localhost callback URL if needed.",
        fieldLabel: "Callback URL",
        placeholder: "Paste full localhost callback URL",
        primaryPaste: false,
      };
    }
    return {
      instruction:
        "Most providers return automatically. Paste the full callback URL only if automatic return fails.",
      status: "Waiting for the browser callback.",
      fieldLabel: "Callback URL",
      placeholder: "Paste the full callback URL if prompted",
      primaryPaste: false,
    };
  }

  const api = { oauthPrompt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ReroutedOAuthPrompt = api;
})(typeof window !== "undefined" ? window : null);
