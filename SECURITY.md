# Security Policy

ReRouted handles OAuth sessions, API keys, gateway keys, and local routing data. Treat security reports and diagnostic material accordingly.

## Supported versions

Security fixes are provided for the latest stable release. Update through **Settings -> Software updates** or install the newest signed release before reporting a problem that may already be fixed.

## Reporting a vulnerability

Do not disclose a vulnerability, credential, or sensitive reproduction in a public issue.

Use GitHub's private [Report a vulnerability](https://github.com/gitcommit90/rerouted/security/advisories/new) form. Private vulnerability reporting is enabled for this repository. Do not open a public placeholder issue or disclose report details in Discussions, pull requests, or logs.

Include only the information needed to investigate:

- ReRouted version and macOS version.
- The affected feature and realistic impact.
- Reproduction steps that use placeholder credentials and sanitized data.
- Whether the gateway was bound only to localhost or exposed to a network.

Never include API keys, gateway keys, access or refresh tokens, OAuth authorization codes, callback URLs, cookies, raw `config.json`, full unreviewed logs, account identifiers, or private prompts.

## Appropriate reports

Examples include authentication bypasses, credential disclosure, unsafe network exposure, cross-account data leakage, update verification failures, or a way for untrusted local content to execute code in the application.

Provider outages, expired subscriptions, quota behavior, unsupported models, and ordinary routing failures belong in a sanitized bug report unless they expose a security boundary.

## Response expectations

ReRouted is an independently maintained personal project. Reports are handled on a best-effort basis. Please allow time to confirm the issue and coordinate a fix before public disclosure.
