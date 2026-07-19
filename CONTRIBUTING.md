# Contributing

Thank you for helping improve ReRouted.

## Current contribution status

ReRouted is open source under the [MIT License](./LICENSE). **External code and documentation pull requests are not accepted** while the maintainer finalizes a review process.

Do not open a pull request with code or documentation changes yet. It may be closed without review. Focused issues, feature requests, compatibility reports, and sanitized reproduction cases are welcome.

When external PRs open, this file will describe CLA/DCO (if any), coding standards, and the review SLA. Until then, assume maintainer-only merges.

## Project governance (maintainers)

Authoritative policy:

| Doc | Purpose |
| --- | --- |
| [docs/GOVERNANCE.md](./docs/GOVERNANCE.md) | Authority, branch model, quality bar, repo settings |
| [docs/release-lifecycle.md](./docs/release-lifecycle.md) | Idea → branch → PR → release process |
| [docs/release-checklist.md](./docs/release-checklist.md) | Packaging, notarization, publish, install verification |
| [CHANGELOG.md](./CHANGELOG.md) | User-facing history (Keep a Changelog) |
| [docs/architecture.md](./docs/architecture.md) | Runtime and data flow |

**Every product change that ships must:**

1. Live on a short-lived branch off current `origin/main`.
2. Include tests for behavior changes.
3. Pass `npm test` and `git diff --check`.
4. Update `CHANGELOG.md` under Unreleased when users will notice the change.
5. Use a unique `package.json` version for each published build.
6. Complete the release checklist before anyone calls the work “done.”

Preferred merge method: **squash merge**, with **delete branch on merge**.

## Before opening an issue

1. Install the latest stable release and check existing issues.
2. Confirm the behavior with the smallest route and request that reproduce it.
3. Record the ReRouted version, operating system, installation method, provider type, authentication method, model, client, and whether the request streamed.
4. Replace account names, model identifiers, or request content when they are not essential to the report.

Never attach `config.json` or paste full, unreviewed diagnostics. Remove API keys, gateway keys, tokens, OAuth callback URLs or codes, cookies, account IDs, email addresses, prompts, and private provider responses.

Use the repository's bug or feature request form so maintainers receive the context needed to reproduce the report.

## Reproduction cases

Good reports distinguish between:

- A response produced by the upstream provider and a response produced by ReRouted.
- A direct provider/model request and a named-route request.
- Streaming and non-streaming behavior.
- One connected account and an OAuth account pool.

Include exact status codes and sanitized error text when available. Do not include credentials to make a reproduction executable.

## Local verification

These commands document the baseline used by maintainers and may help when investigating an issue locally:

```bash
npm ci
npm test
git diff --check
```

Node.js 22.13 or newer is required. The headless runtime is supported on Linux. The packaged desktop application targets Apple Silicon and macOS 12 Monterey or newer.

Canonical clone directory name matches the GitHub repo: `rerouted` (for example `/root/rerouted` on the maintainer Linux host). The product display name is **ReRouted**.

Maintainers handle package version changes, signing, notarization, release publication, and installation verification. Reproduction branches should not include generated release artifacts or real provider credentials.

## Security reports

Do not use a public issue for a vulnerability or credential exposure. Follow [Security](./SECURITY.md) instead.

This policy will be updated when an external pull-request process is in place.
