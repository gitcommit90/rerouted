<div align="center">
  <img src="./resources/readme-logo.svg" width="64" height="64" alt="ReRouted logo" />
  <h1>ReRouted</h1>
  <p><strong>Stop rewiring your AI tools every time an account hits quota.</strong></p>
  <p>
    A local router for macOS and Linux that puts your connected accounts,
    models, API keys, and fallback routes behind one endpoint.
  </p>
  <p>
    <a href="https://rerouted.dev">Website</a> |
    <a href="https://github.com/gitcommit90/rerouted/releases/latest">Download</a> |
    <a href="#quick-start">Quick start</a> |
    <a href="./docs/architecture.md">Architecture</a> |
    <a href="./SECURITY.md">Security</a> |
    <a href="./PRIVACY.md">Privacy</a> |
    <a href="./LICENSE">License</a>
  </p>
  <p>
    <a href="https://github.com/gitcommit90/rerouted/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/gitcommit90/rerouted?color=ef5b2a&label=release" /></a>
    <img alt="macOS Apple Silicon" src="https://img.shields.io/badge/macOS-Apple%20Silicon-1b1d18?logo=apple&logoColor=white" />
    <img alt="Linux headless" src="https://img.shields.io/badge/Linux-headless%20%2B%20dashboard-1b1d18?logo=linux&logoColor=white" />
    <img alt="Local first" src="https://img.shields.io/badge/gateway-local--first-247454" />
    <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-ef5b2a" /></a>
  </p>
</div>

<p align="center">
  <img src="./docs/images/product-tour.gif" width="900" alt="ReRouted Status panel — local gateway, providers, and live traffic" />
</p>

## One URL. The routing decision lives somewhere sane.

Your editor should not need to know which account still has quota, which provider is having a bad morning, or which model you want to try next.

ReRouted gives compatible OpenAI and Anthropic clients the same local contract:

```text
Base URL   http://127.0.0.1:4949/v1
API key    rr-your-generated-key
Model      coding
```

`coding` is a route you own. Put your preferred model first, another account second, and a backup provider third. When an upstream rate-limits, times out, or returns a retryable failure before output begins, ReRouted advances through the route without changing the URL or model name your client uses.

The promise is deliberately focused: ReRouted exposes model discovery, OpenAI-style chat completions and Responses requests, plus Anthropic Messages compatibility for Claude Code and similar clients. It is a routing layer, not a clone of either platform API.

## Why ReRouted exists

| Without ReRouted | With ReRouted |
| --- | --- |
| Provider URLs and credentials are repeated across tools | One localhost URL and one generated gateway key |
| A model name hard-codes a provider or account | A named route describes intent: `coding`, `fast`, `review` |
| Quota means stopping to edit settings | The next route member is attempted automatically |
| Multiple OAuth accounts are managed by hand | OAuth accounts share a provider pool and fall through in order |
| Requests and failures are scattered | Activity, quota, token counts, and logs live in one control plane |

No hosted control plane and no ReRouted account. On macOS, the gateway and panel run together in the menu bar. On Linux, one headless process serves the gateway, interactive CLI setup, and the same control plane at `/dashboard/`.

## How it works

```text
 editor / agent / script
          |
          | POST /v1/chat/completions or /v1/messages
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
 response in the client's original API shape
```

Routes support two strategies:

- **Fallback:** try members in the order you chose.
- **Round robin:** rotate the starting member on each request, then retain fallback through the rest.

Timeouts and retryable `408`, `429`, and `5xx` responses can advance the route. Streaming failures are inspected before output begins; once client-visible output has started, ReRouted does not replay the request behind the client's back.

## What connects

- **OAuth accounts:** ChatGPT, Claude, Antigravity, and xAI.
- **API-key presets:** OpenRouter, NVIDIA NIM, Cloudflare, and GLM Coding.
- **Custom upstreams:** any service that exposes the OpenAI chat-completions shape ReRouted expects.
- **Local credential discovery:** supported credentials already stored in known files, or in the macOS Keychain where available, can be imported instead of re-entered.
- **Multiple accounts:** connect more than one account for the same provider and use shared or account-specific model routes.

OAuth accounts and keyed providers can live in the same route. ReRouted handles request translation and normalizes supported upstream responses back into the shape your client expects.

ReRouted is an independent project and is not affiliated with or endorsed by any upstream provider.

> **OAuth notice:** This provider's subscription or OAuth session is not officially licensed for proxy or router use. Using it this way may result in account restrictions or bans. Proceed at your own risk. Provider behavior and policies can change without notice; API-key integrations are the more stable choice where available.

## Quick start

### 1. Install on macOS

[Download the latest ReRouted release for Apple Silicon](https://github.com/gitcommit90/rerouted/releases/latest), open the DMG, and drag ReRouted to Applications.

ReRouted requires Apple Silicon and macOS 12 Monterey or newer.

The macOS release is Developer ID signed, notarized by Apple, and stapled for a normal Gatekeeper launch.

After the first install, ReRouted checks stable releases in the background. You can also use **Settings → Software updates** at any time; new versions download inside the app and install on restart.

### Or install the headless Linux CLI

ReRouted requires Node.js 22.13 or newer. Install the current CLI tarball from the stable GitHub Release; it provides the short `rerouted` command:

```bash
npm install --global https://github.com/gitcommit90/rerouted/releases/latest/download/ReRouted-linux-node.tgz
rerouted
```

The first run opens the interactive terminal setup when a TTY is attached and prints both local URLs:

```text
Gateway   http://127.0.0.1:4949/v1
Dashboard http://127.0.0.1:4949/dashboard/
```

When started by systemd, Docker, SSH automation, or another non-interactive process, open the printed dashboard URL from the same machine to finish first-time setup. The browser flow covers the same providers, routes, activity, quota, keys, and settings as the menu-bar app. Dashboard sessions require the local admin password after onboarding. Run `rerouted help` for bind, port, and data-directory options.

For a persistent user service after setup:

```ini
# ~/.config/systemd/user/rerouted.service
[Unit]
Description=ReRouted local AI gateway

[Service]
ExecStart=%h/.local/bin/rerouted --no-interactive
Restart=on-failure

[Install]
WantedBy=default.target
```

Use the actual path from `command -v rerouted` if npm installed it elsewhere, then run `systemctl --user enable --now rerouted`.

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

Then enter the same base URL, gateway key, and route name in a configurable OpenAI-style client. Setting names vary by client. Switch providers, accounts, models, and route order inside ReRouted; leave the client configuration alone.

Claude Code uses the Anthropic Messages route. Point it at the gateway with its generated key and map each alias to a ReRouted model or named route:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4949/v1",
    "ANTHROPIC_AUTH_TOKEN": "rr-your-generated-key",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "coding",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "coding",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "fast"
  }
}
```

ReRouted accepts both `/v1/messages` and `/v1/v1/messages`, so current Claude Code versions work whether they append `/messages` or `/v1/messages` to that base URL.

## One control plane, two shells

- **Status:** gateway health, endpoint, latest route, and recent traffic.
- **Accounts:** OAuth sessions, imported credentials, API keys, and model availability.
- **Routes:** named fallback or round-robin model groups with explicit ordering controls.
- **Activity:** requests, failures, token counts, route choices, and account usage.
- **Quota:** provider-specific subscription windows where supported.
- **Settings:** gateway keys, localhost or network binding, security controls, and platform-appropriate startup/update information.

<p align="center">
  <img src="./docs/images/status.png" width="400" alt="ReRouted status panel" />
  <img src="./docs/images/route-editor.png" width="400" alt="ReRouted route editor" />
</p>

On macOS, hiding the panel leaves the gateway running. On Linux, keep the `rerouted` process or your service manager running; closing the dashboard tab does not stop it.

## API surface

| Endpoint | Purpose |
| --- | --- |
| `GET /` | Same unauthenticated local health response as `/health` |
| `GET /health` | Local gateway health and listening port |
| `GET /dashboard/` | Local web control plane in the headless runtime |
| `GET /v1/models` | Enabled direct models and named routes |
| `POST /v1/chat/completions` | Streaming or non-streaming routed chat completions |
| `POST /v1/responses` | Streaming or non-streaming routed Responses API requests |
| `POST /v1/messages` | Streaming or non-streaming Anthropic Messages requests |
| `POST /v1/messages/count_tokens` | Local best-effort Anthropic input-token estimate |

Requests require a generated gateway key except for `/` and `/health`. OpenAI routes accept `Authorization: Bearer`; Anthropic routes accept that header or `x-api-key`. OpenAI-style image inputs inside chat-completion messages and Anthropic image blocks are supported when the selected upstream model accepts them. The separate `/v1/images` generation API, embeddings, audio, Anthropic Batches, and the rest of both platform APIs are outside ReRouted's scope.

## Local-first, with the boundaries stated plainly

- The gateway binds to `127.0.0.1` by default.
- Configuration, credentials, request metadata, usage, and logs are stored locally.
- Usage history is stored in an uncapped local SQLite database so all-time statistics do not silently discard older requests.
- Prompt bodies are not intentionally persisted.
- Local config and usage files are written with restrictive permissions where supported.
- Provider credentials are not encrypted at rest.
- Requests and the credentials needed to authorize them are sent to the upstream services you choose.
- Enabling network access binds the gateway to `0.0.0.0`; only do that on a network you trust.
- The dashboard uses a separate, per-browser session protected by the local admin password. First-time browser setup is restricted to loopback.

See [Privacy](./PRIVACY.md) for the local files ReRouted keeps, the network services it contacts, and how to remove its data.

## Support, security, and project status

- For questions, reproducible bugs, and feature requests, use [GitHub Issues](https://github.com/gitcommit90/rerouted/issues).
- For a suspected vulnerability, follow [the security policy](./SECURITY.md) and do not post credentials or sensitive details in a public issue.
- Before sharing diagnostics, remove API keys, gateway keys, OAuth callback URLs or codes, account identifiers, email addresses, and any provider response that may contain private data.

ReRouted is open source under the [MIT License](./LICENSE). External code contributions are not currently accepted while the contribution process is finalized; focused issues and sanitized reproduction reports are welcome. See [Contributing](./CONTRIBUTING.md) for the current policy.

## Build or run from source

Requires Node.js 22.13 or newer. The test suite and headless runtime run on Linux; DMG packaging remains a separate macOS-only path.

```bash
git clone https://github.com/gitcommit90/rerouted.git
cd rerouted
npm ci
npm test
npm start
```

Run the headless CLI instead:

```bash
npm run start:headless
```

Package the macOS app and DMG:

```bash
npm run package:dmg
```

The shared implementation uses Node's built-in HTTP server and a vanilla HTML/CSS/JavaScript control plane. Electron supplies the macOS menu-bar shell; the Linux CLI supplies the headless shell and serves that same renderer from `/dashboard/`. See [the architecture document](./docs/architecture.md) for the runtime, routing, persistence, and packaging details.

## Current release

macOS builds are Developer ID signed, notarized, stapled, and distributed through stable GitHub Releases with in-app updates. The Linux CLI is a separate npm-compatible tarball on the same stable release and is updated by rerunning its npm install command. The public API is intentionally limited to health, model discovery, chat completions, Responses, and Anthropic Messages compatibility; a published third-party client compatibility matrix is still forthcoming.

## License

ReRouted is licensed under the [MIT License](./LICENSE).

ReRouted is an independent personal project.

## Thanks

- Thanks to [9Router](https://github.com/decolua/9router) and its contributors for pushing local multi-provider routing forward.
- Thanks to [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and its contributors for advancing local provider connectivity and the ecosystem around it.
