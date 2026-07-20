# ReRouted architecture

This document describes the implementation in this repository today. It is the code map for maintainers, not a future-product proposal.

## Runtime shape

ReRouted has two shells around one shared runtime:

1. The macOS Electron shell owns the menu-bar icon, native panel, login-item preference, and signed updater.
2. The Linux headless shell owns the terminal lifecycle, interactive setup, and dashboard HTTP transport.
3. Both create the same store, router, gateway, usage, request-activity, quota, and control-plane services.

There is no hosted control plane. On macOS, closing or hiding the panel does not stop the gateway; quitting ReRouted does. On Linux, closing the dashboard does not stop the gateway; stopping the `rerouted` process does.

```text
OpenAI-style or Anthropic Messages client
        |
        | rr-... + /v1/chat/completions, /v1/responses, or /v1/messages
        v
src/lib/gateway.js
        |
        | resolve model/combo
        v
src/lib/router.js
        |
        | select provider + translate request
        v
src/lib/providers/*  --->  upstream provider API
        |
        | normalize response/SSE
        v
Response in the client's original API shape
```

## Shared control plane and platform shells

`src/lib/control-plane.js` owns the platform-neutral actions used by onboarding and the Status, Accounts, Routes, Activity, Quota, and Settings pages. Provider additions, OAuth completion, named routes, model controls, gateway keys, admin authentication, quota, usage, and logs pass through that one contract.

`src/main.js` wires the contract to allowlisted Electron IPC and adds the single-instance lock, tray, frameless panel window, login-item preference, macOS session authentication, and updater.

`src/cli/index.js` wires the same contract to a headless process created by `src/lib/headless-runtime.js`. The CLI performs interactive first-run setup when attached to a TTY. `src/lib/dashboard.js` serves the shared renderer and a JSON action transport at `/dashboard/`.

The panel is a local file loaded from `src/renderer/index.html`. `src/preload.js` exposes an allowlisted IPC bridge to `src/renderer/app.js`; context isolation and the renderer sandbox are enabled, and renderer Node integration is disabled.

The renderer is vanilla HTML, CSS, and JavaScript. It renders onboarding and the Status, Accounts, Routes, Activity, and Settings pages from state returned by the shared control plane. `src/renderer/web-api.js` provides the browser transport when Electron's preload bridge is absent.

Each browser receives an independent, HttpOnly, same-site dashboard session. After onboarding, sensitive state and mutations require the scrypt-hashed admin password for that browser session. Browser action requests require an exact same-origin match, repeated password failures are throttled, dashboard assets are allowlisted, and first-time browser setup is accepted only over loopback. The gateway's `rr-` bearer keys and dashboard sessions are separate authentication boundaries.

## Gateway contract

`src/lib/gateway.js` uses Node's built-in HTTP server.

| Route | Auth | Behavior |
| --- | --- | --- |
| `GET /` | None | Same process health response as `/health` |
| `GET /health` | None | App name and current listening port |
| `GET /dashboard/` | Browser session | Headless control-plane renderer and same-origin action transport |
| `GET /v1/models` | Bearer key | Enabled provider models plus named route IDs |
| `POST /v1/chat/completions` | Bearer key | Streaming or non-streaming routed chat completion |
| `POST /v1/responses` | Bearer key | Responses requests adapted through the chat-completions router |
| `POST /v1/messages` | Bearer key or `x-api-key` | Anthropic Messages requests adapted through the chat-completions router |
| `POST /v1/messages/count_tokens` | Bearer key or `x-api-key` | Local best-effort input-token estimate without an upstream request |

The default bind is `127.0.0.1:4949`. Settings or CLI options can switch the host to `0.0.0.0` for LAN or Tailscale access. CORS for `/v1` is currently `*`, so the bearer key is the API boundary when network binding is enabled. Dashboard control requests do not use that CORS policy and require same-origin browser requests plus the dashboard session/password boundary above.

JSON request bodies are limited to 32 MiB. Oversized requests receive a JSON `413` response before routing begins.

Anthropic Messages requests are normalized into the same internal OpenAI chat-completions shape used by the router, so account pools, named routes, retries, fallback, round robin, activity, and usage all follow the existing path. Responses are converted back to Anthropic JSON or SSE, including text, tool use, tool results, stop reasons, and token usage. Native Claude thinking, signatures, cache-control blocks, and stop sequences are preserved in memory when a Messages request routes back to Claude, while the private metadata is not serialized to non-Claude providers. Both `/v1/messages` and the duplicate-prefix `/v1/v1/messages` form are accepted for compatibility with Claude Code versions and base-URL conventions that each add `/v1`.

## Model IDs and routes

Provider model IDs are generated by `src/lib/providers/index.js`. Custom OpenAI-compatible connections use the readable form `<connection name>/custom/<upstream model>` while legacy hash-qualified IDs remain resolvable. A direct model resolves to one enabled provider/model pair.

A route is a persisted virtual model. Standard providers are represented by a
provider/model destination, not by an individual credential:

```json
{
  "providerType": "chatgpt",
  "model": "upstream-model-id"
}
```

Custom OpenAI-compatible connections remain connection-specific because their
base URLs can represent different services, so those members retain a
`providerId`.

The router supports:

- `fallback`: members are attempted in their configured order.
- `round-robin`: each request rotates the starting member, then retains fallback behavior through the remaining members.

Named routes and OAuth account pools continue through every untried target until an upstream returns a usable `2xx` response. Any non-`2xx` status advances fallback regardless of error type. A `2xx` response that contains an immediate stream error, ends without usable output, exceeds the bounded pre-output inspection budget, has no response body, contains invalid JSON, or carries an explicit error payload also advances fallback. Failure classification controls account cooldown locks and diagnostics; it never stops routing. Capability failures do not create account cooldown locks. The per-member timeout defaults to 60 seconds. Caller cancellation stops immediately, and a stream cannot be transparently rerouted after output has already reached the client.

Standard providers add an account-pool layer beneath model routing. The route
editor and terminal setup select Provider, then Model; individual OAuth or
API-key accounts are internal to that member. Every eligible account for the
selected provider/model is tried before routing advances to the next member.
Round robin rotates these outer members only, retaining the account-pool retry
inside each one. OAuth accounts receive monotonic, never-reused aliases
(`oauth1`, `oauth2`, ...). Model discovery advertises one canonical pooled id
such as `chatgpt/gpt-5.4`; account-qualified ids such as
`chatgpt/oauth2/gpt-5.4` and legacy stored-account ids remain resolvable but
are not advertised. Quota failures create an account-wide lock using provider
reset hints when available; authentication and transient failures use shorter
model-scoped cooldowns. Early streaming quota events are inspected before the
client stream starts so fallback can still occur. Selection, failure, fallback,
locked-account skips, and terminal exhaustion are written as structured logs.

## Provider adapters

`src/lib/providers/index.js` selects an adapter by provider type.

- `openai-compat.js` handles OpenAI-shaped keyed services.
- `cloudflare.js` discovers runnable Workers AI models through the paginated `/ai/models/search` API and delegates requests to Cloudflare's OpenAI-compatible chat endpoint.
- `chatgpt.js` translates chat-completion requests to the ChatGPT Codex Responses surface and normalizes Responses SSE.
- `claude.js` translates OpenAI messages and tools to Anthropic Messages, applies the current OAuth client contract, and converts JSON/SSE back to OpenAI shapes.
- `antigravity.js` translates Gemini-style upstream requests and SSE.
- `xai.js` translates chat-completion requests to the xAI subscription Responses surface and normalizes its forced SSE stream.

OAuth access-token refreshes are persisted back to the provider record when an adapter returns updated tokens.

## OAuth and credential discovery

`src/lib/oauth.js` implements PKCE browser flows and loopback callbacks. Some providers require the user to paste a callback URL or code into the panel, dashboard, or interactive terminal setup.

`src/lib/detect.js` performs read-only discovery of supported provider credentials already stored in known local files or, on macOS, the Keychain.

Selected credentials are copied into ReRouted's config. ReRouted does not continue reading the original source on each request.

## Persistence

The macOS Electron `userData` directory or Linux `$XDG_CONFIG_HOME/rerouted` directory contains:

| File | Contents |
| --- | --- |
| `config.json` | Providers, credentials, models, routes, gateway keys, bind settings, onboarding state, admin password hash |
| `usage.sqlite` | Uncapped local request metadata and token counts, indexed by timestamp for period and all-time statistics |
| `rerouted.log` | Gateway, OAuth, and operational diagnostics |

The Quota page probes subscription windows directly for ChatGPT/Codex, Claude, and Antigravity. Probe failures remain isolated per account and do not disable chat routing.

Config writes use a temporary file followed by rename. Usage inserts use SQLite WAL mode with prepared statements. The primary files are written with mode `0600`; parent directories are created with mode `0700` where supported.

On the first `0.4.2` launch, every row still present in the legacy `usage.json` file is imported transactionally into `usage.sqlite`. The legacy file remains as a migration backup, and a database marker prevents duplicate imports. New history is not automatically pruned.

The admin password is scrypt-hashed. Provider credentials and gateway keys are not encrypted at rest.

## Packaging

The Linux CLI is packaged separately as an npm-compatible tarball named `ReRouted-<version>-linux-node.tgz`, plus the stable alias `ReRouted-linux-node.tgz`; both install the `rerouted` executable. This is intentionally separate from the DMG and native updater path, and the CLI performs no automatic update checks.

`scripts/package-mac-dmg.js` must run on macOS. It:

1. Packages Electron for `darwin/arm64`.
2. Adds the tray resources and menu-bar-only bundle settings.
3. Applies hardened-runtime Electron signing with a Developer ID identity when available.
4. For release builds, notarizes and staples the app.
5. For release builds, creates an updater ZIP from the stapled app and verifies the extracted bundle.
6. Creates and signs a compressed UDZO DMG with an Applications shortcut.
7. For release builds, notarizes and staples the DMG.

The output name is derived from `package.json`:

```text
dist/ReRouted-<version>-arm64.dmg
dist/ReRouted-<version>-mac-arm64.zip
```

Official release builds require `REROUTED_NOTARY_PROFILE` and fail if Developer ID signing or notarization is unavailable. See [signing.md](signing.md).

Packaged builds use Electron's native macOS updater and the public stable GitHub Release feed. Checks run shortly after launch and every six hours, with a manual control in Settings. The native updater downloads the post-stapling ZIP, verifies the replacement application through macOS code signing, and installs it on restart. Draft and prerelease GitHub releases are not update channels.

## Tests and current gaps

`tests/gateway.test.js` covers password hashing, config persistence, bearer auth, request-size enforcement, model listing, streaming and non-streaming completion paths, fallback, round-robin ordering, timeouts, OAuth request behavior, token refresh, format translation, SSE decoding, multiple gateway keys, disabled models, and usage aggregation. `tests/control-plane.test.js`, `tests/dashboard.test.js`, and `tests/cli.test.js` cover the shared action contract, session isolation, redaction, same-origin boundaries, login throttling, asset serving, Linux paths, the process lock, and real headless startup.

Important gaps to keep visible:

- No automated renderer or end-to-end Electron tests.
- The Node test suite runs in GitHub Actions, but there is no macOS packaging test in CI.
- No gateway request-rate limit.
- No automated release publication or CI-hosted signing/notarization.
- No commit SHA embedded in the app bundle.
- No compatibility matrix for third-party OpenAI clients.

## Maintenance rules

Read [docs/release-checklist.md](release-checklist.md) before changing the app. A merged commit is only one stage of a ReRouted iteration; the DMG, Linux tarball, and target-system installation checks are part of the deliverable.
