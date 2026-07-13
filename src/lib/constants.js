"use strict";

/** Default localhost gateway port. */
const DEFAULT_PORT = 4949;

/** Per-upstream-member request timeout (ms). Timeout advances fallback/RR. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Known OpenAI-compatible keyed providers (base URLs are constants). */
const KEYED_PRESETS = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  nvidia: {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  cloudflare: {
    id: "cloudflare",
    name: "Cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    needsAccountId: true,
  },
  glm: {
    id: "glm",
    name: "GLM Coding",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
  },
};

const OAUTH = {
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    codeChallengeMethod: "S256",
    fixedPort: 1455,
    callbackPath: "/auth/callback",
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
    chatUrl: "https://chatgpt.com/backend-api/codex/responses",
    models: [
      { id: "gpt-5.6-sol-high", name: "GPT 5.6 Sol (High)" },
      { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
      { id: "gpt-5.5", name: "GPT 5.5" },
      { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
      { id: "gpt-5.4", name: "GPT 5.4" },
    ],
  },
  claude: {
    id: "claude",
    name: "Claude",
    // Claude's OAuth client uses a localhost callback and supports pasting the
    // full callback URL when the browser cannot return to the app directly.
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scopes: ["org:create_api_key", "user:profile", "user:inference"],
    codeChallengeMethod: "S256",
    // Use a dedicated loopback callback. The full URL can be pasted if needed.
    redirectUri: null,
    loopbackPort: 54545,
    callbackPath: "/callback",
    redirectUriFallbacks: [],
    tokenUrlFallbacks: [],
    userAgent: null,
    chatUrl: "https://api.anthropic.com/v1/messages",
    // Models available through the Claude OAuth account.
    models: [
      { id: "claude-fable-5", name: "Claude Fable 5" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
    ],
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    clientId:
      "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    baseUrls: [
      "https://daily-cloudcode-pa.googleapis.com",
      "https://daily-cloudcode-pa.sandbox.googleapis.com",
    ],
    models: [
      { id: "gemini-3-flash-agent", name: "Gemini 3 Flash Agent" },
      { id: "gemini-pro-agent", name: "Gemini Pro Agent" },
    ],
  },
  xai: {
    id: "xai",
    name: "xAI (Grok)",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    scope: "openid profile email offline_access grok-cli:access api:access",
    codeChallengeMethod: "S256",
    loopbackPort: 56121,
    callbackPath: "/callback",
    chatUrl: "https://cli-chat-proxy.grok.com/v1/responses",
    models: [
      { id: "grok-4.5-high", name: "Grok 4.5 (High)" },
      { id: "grok-4.5-medium", name: "Grok 4.5 (Medium)" },
      { id: "grok-4.5-low", name: "Grok 4.5 (Low)" },
      { id: "grok-4.5", name: "Grok 4.5" },
      { id: "grok-composer-2.5-fast", name: "Grok Composer 2.5 Fast" },
    ],
  },
};

// Catalog entries removed during config normalization. Only known defaults are
// removed so user-added model IDs remain intact.
const RETIRED_OAUTH_MODELS = {
  chatgpt: ["gpt-5.3-codex"],
  claude: [
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-5-20250929",
  ],
  antigravity: ["gemini-3-flash"],
  xai: ["grok-4", "grok-code-fast-1", "grok-3"],
};

const ONBOARDING_STEPS = [
  "permissions",
  "admin-password",
  "welcome",
  "auto-detect",
  "oauth-providers",
  "api-keys",
  "endpoint-ready",
  "tutorial",
  "first-combo",
  "done",
];

module.exports = {
  DEFAULT_PORT,
  REQUEST_TIMEOUT_MS,
  KEYED_PRESETS,
  OAUTH,
  RETIRED_OAUTH_MODELS,
  ONBOARDING_STEPS,
};
