<div align="center">
  <img src="./resources/brandMark@2x.png" width="64" height="64" alt="ReRouted logo" />
  <h1>ReRouted</h1>
  <p><strong>Stop rewiring your AI tools every time an account hits quota.</strong></p>
  <p>
    A macOS menu-bar router that puts your connected accounts, models,
    API keys, and fallback routes behind one local chat-completions endpoint.
  </p>
  <p>
    <a href="https://rerouted.dev">Website</a> |
    <a href="https://github.com/gitcommit90/rerouted/releases/latest">Download</a> |
    <a href="#quick-start">Quick start</a> |
    <a href="./docs/architecture.md">Architecture</a> |
    <a href="./SECURITY.md">Security</a> |
    <a href="./PRIVACY.md">Privacy</a>
  </p>
  <p>
    <a href="https://github.com/gitcommit90/rerouted/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/gitcommit90/rerouted?color=ef5b2a&label=release" /></a>
    <img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-1b1d18?logo=apple&logoColor=white" />
    <img alt="Local first" src="https://img.shields.io/badge/gateway-local--first-247454" />
  </p>
</div>

<p align="center">
  <img src="./docs/images/status.png" width="400" alt="ReRouted status panel" />
  <img src="./docs/images/route-editor.png" width="400" alt="ReRouted route editor" />
</p>

## One URL. The routing decision lives somewhere sane.

Your editor should not need to know which account still has quota, which provider is having a bad morning, or which model you want to try next.

ReRouted gives compatible chat-completions clients the same local contract:

```text
Base URL   http://127.0.0.1:4949/v1
API key    rr-your-generated-key
Model      coding
```

`coding` is a route you own. Put your preferred model first, another account second, and a backup provider third. When an upstream rate-limits, times out, or returns a retryable failure before output begins, ReRouted advances through the route without changing the URL or model name your client uses.

The promise is deliberately focused: ReRouted exposes model discovery and OpenAI-style chat completions. It is a routing layer, not a clone of every OpenAI API.

## Why ReRouted exists

| Without ReRouted | With ReRouted |
| --- | --- |
| Provider URLs and credentials are repeated across tools | One localhost URL and one generated gateway key |
| A model name hard-codes a provider or account | A named route describes intent: `coding`, `fast`, `review` |
| Quota means stopping to edit settings | The next route member is attempted automatically |
| Multiple OAuth accounts are managed by hand | OAuth accounts share a provider pool and fall through in order |
| Requests and failures are scattered | Activity, quota, token counts, and logs live in the menu bar |

No hosted control plane. No account with ReRouted. No Dock icon. The gateway and panel run together on your Mac.

## How it works

```text
 editor / agent / script
          |
          | POST /v1/chat/completions
          | model: "coding"
          v
  127.0.0.1:4949/v1
          |
          v
     ReRouted route
       1. primary model
       2. second account
       3. backup provider
          |
          v
 normalized OpenAI-style response
```

Routes support two strategies:

- **Fallback:** try members in the order you chose.
- **Round robin:** rotate the starting member on each request, then retain fallback through the rest.

Timeouts and retryable `408`, `429`, and `5xx` responses can advance the route. Streaming failures are inspected before output begins; once client-visible output has started, ReRouted does not replay the request behind the client's back.

## What connects

- **OAuth accounts:** ChatGPT, Claude, Antigravity, and xAI.
- **API-key presets:** OpenRouter, NVIDIA NIM, Cloudflare, and GLM Coding.
- **Custom upstreams:** any service that exposes the OpenAI chat-completions shape ReRouted expects.
- **Local credential discovery:** supported credentials already stored in known files or the macOS Keychain can be imported instead of re-entered.
- **Multiple accounts:** connect more than one account for the same provider and use shared or account-specific model routes.

OAuth accounts and keyed providers can live in the same route. ReRouted handles request translation and normalizes supported upstream responses back into the shape your client expects.

ReRouted is an independent project and is not affiliated with or endorsed by any upstream provider.

> **OAuth notice:** This provider's subscription or OAuth session is not officially licensed for proxy or router use. Using it this way may result in account restrictions or bans. Proceed at your own risk. Provider behavior and policies can change without notice; API-key integrations are the more stable choice where available.

## Quick start

### 1. Install

[Download ReRouted 0.4.2 for Apple Silicon](https://github.com/gitcommit90/rerouted/releases/download/v0.4.2/ReRouted-0.4.2-arm64.dmg), open the DMG, and drag ReRouted to Applications.

ReRouted requires Apple Silicon and macOS 12 Monterey or newer.

The macOS release is Developer ID signed, notarized by Apple, and stapled for a normal Gatekeeper launch.

After the first install, ReRouted checks stable releases in the background. You can also use **Settings → Software updates** at any time; new versions download inside the app and install on restart.

### 2. Connect what you already use

Import a detected credential, complete an OAuth flow, or add an API key. ReRouted keeps OAuth accounts and keyed providers side by side.

### 3. Create a route

Name it for the job rather than the vendor:

```text
coding
  1. preferred account and model
  2. second account
  3. backup provider
```

### 4. Test the route, then point your client at localhost

Use a direct request to verify the gateway and route:

```bash
curl http://127.0.0.1:4949/v1/chat/completions \
  -H "Authorization: Bearer rr-your-generated-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"coding","messages":[{"role":"user","content":"Say hello in three words."}]}'
```

Then enter the same base URL, gateway key, and route name in a configurable client that supports OpenAI-style chat completions. Setting names vary by client. Switch providers, accounts, models, and route order inside ReRouted; leave the client configuration alone.

## The menu-bar control plane

- **Status:** gateway health, endpoint, latest route, and recent traffic.
- **Accounts:** OAuth sessions, imported credentials, API keys, and model availability.
- **Routes:** named fallback or round-robin model groups with explicit ordering controls.
- **Activity:** requests, failures, token counts, route choices, and account usage.
- **Quota:** provider-specific subscription windows where supported.
- **Settings:** gateway keys, localhost or network binding, login launch, security controls, and signed software updates.

The gateway continues running when the panel is hidden. Quitting ReRouted stops both.

## API surface

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Same unauthenticated local health response as `/health` |
| `GET /health` | Local gateway health and listening port |
| `GET /v1/models` | Enabled direct models and named routes |
| `POST /v1/chat/completions` | Streaming or non-streaming routed completions |

Requests require a generated bearer key except for `/` and `/health`. OpenAI-style image inputs inside chat-completion messages are supported when the selected upstream model accepts them. The separate `/v1/images` generation API, embeddings, audio, and the rest of the OpenAI platform API are outside ReRouted's scope.

## Local-first, with the boundaries stated plainly

- The gateway binds to `127.0.0.1` by default.
- Configuration, credentials, request metadata, usage, and logs are stored locally.
- Usage history is stored in an uncapped local SQLite database so all-time statistics do not silently discard older requests.
- Prompt bodies are not intentionally persisted.
- Local config and usage files are written with restrictive permissions where supported.
- Provider credentials are not encrypted at rest.
- Requests and the credentials needed to authorize them are sent to the upstream services you choose.
- Enabling network access binds the gateway to `0.0.0.0`; only do that on a network you trust.

See [Privacy](./PRIVACY.md) for the local files ReRouted keeps, the network services it contacts, and how to remove its data.

## Support, security, and project status

- For questions, reproducible bugs, and feature requests, use [GitHub Issues](https://github.com/gitcommit90/rerouted/issues).
- For a suspected vulnerability, follow [the security policy](./SECURITY.md) and do not post credentials or sensitive details in a public issue.
- Before sharing diagnostics, remove API keys, gateway keys, OAuth callback URLs or codes, account identifiers, email addresses, and any provider response that may contain private data.

ReRouted's source is public for review and local builds, but no software license has been selected yet. The repository is therefore source-visible, not offered as open source. External code contributions are not currently accepted while licensing is finalized; focused issues and sanitized reproduction reports are welcome. See [Contributing](./CONTRIBUTING.md) for the current policy.

## Build from source

Requires Node.js 22.13 or newer. Packaging requires macOS and produces an Apple Silicon DMG.

```bash
git clone https://github.com/gitcommit90/rerouted.git
cd rerouted
npm ci
npm test
npm start
```

Package the macOS app and DMG:

```bash
npm run package:dmg
```

The implementation is intentionally small: Electron, Node's built-in HTTP server, and a vanilla HTML/CSS/JavaScript renderer. See [the architecture document](./docs/architecture.md) for the runtime, routing, persistence, and packaging details.

## Current release

ReRouted `0.4.2` ships for Apple Silicon macOS with hardened OAuth callbacks and renderer lock boundaries, uncapped SQLite usage history, 60-second quota refreshes while the Quota page is open, masked account identities, and image inputs in chat completions. Public builds are Developer ID signed, notarized, stapled, and distributed through stable GitHub Releases with in-app updates. The public API is intentionally limited to health, model discovery, and chat completions; a published third-party client compatibility matrix is still forthcoming.

ReRouted is an independent personal project.

## Thanks

- Thanks to [9Router](https://github.com/decolua/9router) and its contributors for pushing local multi-provider routing forward.
- Thanks to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and its contributors for advancing local provider connectivity and the ecosystem around it.
