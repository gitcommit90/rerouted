# Privacy

ReRouted is a local macOS application and Linux headless service. It has no ReRouted account, hosted control plane, or third-party product analytics service.

This document describes the application as shipped. The upstream providers and clients you connect have their own privacy policies and data practices.

## Website

The public `rerouted.dev` website is a static site delivered through Cloudflare and loads its display fonts from Google Fonts. Those services may receive ordinary web-request metadata such as your IP address, browser headers, and requested asset URLs under their own privacy policies. The website does not include ReRouted product analytics or an account system.

## Data stored on your machine

On macOS, ReRouted stores application data in its Application Support directory, normally `~/Library/Application Support/ReRouted`; existing installations may use `~/Library/Application Support/rerouted`. On Linux, the headless runtime uses `$XDG_CONFIG_HOME/rerouted`, normally `~/.config/rerouted`. `REROUTED_USER_DATA` or the CLI `--data-dir` option can override the headless location.

Local data includes:

- Provider settings, OAuth credentials, API keys, gateway keys, routes, and application preferences in `config.json`.
- Request metadata, provider and route selections, statuses, timestamps, and token counts in the uncapped `usage.sqlite` database.
- Gateway, OAuth, update, and routing diagnostics in `rerouted.log`.

Prompt bodies are not intentionally persisted. Provider credentials and gateway keys are not encrypted at rest. ReRouted restricts local file permissions where the operating system supports doing so, but anyone who can access your local user account or its files may be able to read them.

Diagnostics can contain provider error text, model and route names, account identifiers, and OAuth metadata. Treat logs as sensitive and review every line before sharing an excerpt.

## Local credential discovery

Credential discovery happens when you choose to scan or import accounts. Depending on the providers installed on the machine, ReRouted may inspect supported entries in the Codex configuration, the Claude Code macOS Keychain or supported local auth files, ReRouted auth-profile folders, and Antigravity-named JSON files in supported folders including `~/Downloads`. ReRouted summarizes discoveries before import; selected credentials are copied into its own configuration.

At startup, ReRouted may also read the local `~/.grok/auth.json` file to attach a human-readable identity to an xAI account that is already connected. This startup lookup only updates local account labeling; it does not import a new account by itself.

## Network activity

ReRouted makes network requests only as needed to operate features you choose:

- Completion requests, credentials, and supported image inputs are sent to the selected upstream provider.
- OAuth authorization and token refresh requests are sent to the relevant provider.
- Quota checks are sent to supported providers when you open the Quota page, every 60 seconds while that page remains open, or when you manually refresh it.
- The macOS app checks `update.electronjs.org` shortly after launch and about every six hours; signed update downloads come from GitHub Releases. The Linux CLI does not perform automatic update checks and is updated through its package manager.

The gateway binds to `127.0.0.1` by default. If you enable network access, it binds to `0.0.0.0`; devices that can reach the machine can attempt to access it. Gateway API routes require a generated gateway key. In the headless runtime, `/dashboard/` uses a separate browser session and the local admin password; first-time browser setup is allowed only over loopback.

## OAuth and subscription notice

ReRouted is independent and is not affiliated with or endorsed by any upstream provider. This provider's subscription or OAuth session is not officially licensed for proxy or router use. Using it this way may result in account restrictions or bans. Proceed at your own risk, review the provider's current terms, and prefer a documented API-key integration when you need a stable production path.

## Retention and deletion

Usage history is not automatically pruned and remains on the machine until the local data directory is removed. Existing installations may also retain the former `usage.json` as a one-time migration backup. Logs can be cleared from the Activity diagnostics view.

Uninstalling the application bundle does not automatically remove Application Support data. To remove ReRouted and its stored credentials completely:

1. Stop ReRouted.
2. On macOS, delete `/Applications/ReRouted.app`; on Linux, uninstall `@gitcommit90/rerouted` through npm.
3. Delete the relevant ReRouted data directory listed above.

Deleting the Application Support directory permanently removes connected accounts, keys, routes, settings, usage history, and logs. Back up only the data you intentionally want to retain.

## Sharing diagnostics

Never post `config.json` or an unreviewed log file. Remove API keys, gateway keys, tokens, OAuth codes and callback URLs, cookies, email addresses, account identifiers, private provider responses, and prompt content before sharing a reproduction or log excerpt.

See [Security](./SECURITY.md) for reporting a suspected vulnerability and [Contributing](./CONTRIBUTING.md) for safe bug-report guidance.
