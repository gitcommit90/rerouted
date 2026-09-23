# Changelog

All notable changes to ReRouted are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release tags use the form `vX.Y.Z` and match `package.json`. GitHub Releases carry the installable artifacts; this file is the durable narrative for humans and agents.

## [Unreleased]

## [0.5.15] - 2026-09-23

### Changed

- Provider-specific cache shaping now runs after route selection, so Claude receives stable and rolling cache breakpoints while ChatGPT and xAI receive stable request cache keys without leaking internal metadata to arbitrary OpenAI-compatible providers.
- Claude OAuth requests now use the current Claude Code 2.1.280 client fingerprint.
- Usage normalization now reports cache reads, cache writes, uncached input, and logical input consistently across provider accounting conventions.

### Fixed

- Manual provider model validation is bounded instead of hanging indefinitely when an upstream accepts a connection but never answers.
- Claude cache prefixes remain reusable across human turns when volatile invocation context changes.
- Parallel Claude tool results, including supplemental image blocks, are serialized into one immediately following user message with all `tool_result` blocks first, preventing Anthropic request-order failures.

## [0.5.12] - 2026-08-12

### Fixed

- Proxy-generated HTTP 502/503/504 connection-reset responses now use the same retry, no-lock, and route-fallback behavior as thrown socket failures.
- Outbound connections now allow five seconds per resolved address instead of Node's 250-millisecond default, preventing healthy but moderately latent TCP handshakes from being misreported as `ETIMEDOUT` across every ChatGPT address.

## [0.5.11] - 2026-08-12

### Fixed

- Connection-level failures now retry twice at ten-second intervals, preserve their underlying network cause in logs, advance named-route fallback after exhaustion, and never create misleading OAuth account locks.

## [0.5.10] - 2026-07-29

### Fixed

- Antigravity Flash and Pro streaming responses now accept Google's CRLF-delimited SSE frames instead of completing with empty output.
- Claude Code's canonical Fable and Claude Opus 4.8 model IDs now resolve through matching `fable` and `opus-4.8` named routes, preserving configured cross-provider fallback.
- Anthropic overload responses now create short model-scoped transient cooldowns instead of misleading quota-wide account locks.

## [0.5.9] - 2026-07-23

### Fixed

- Long-running streamed responses now send protocol-safe keepalives so clients such as Claude Code do not cancel healthy requests during extended model silence.

## [0.5.8] - 2026-07-23

### Fixed

- Reasoning models no longer fail with a synthetic 408 and temporary account lock when Claude thinking or Responses reasoning is the first streamed output.

## [0.5.7] - 2026-07-20

### Changed

- Routes now select Provider, then Model instead of exposing individual accounts. ReRouted tries all eligible accounts for that provider/model before advancing to the next fallback or round-robin member.
- Existing standard-provider route members migrate to provider/model destinations; custom OpenAI-compatible endpoints remain connection-specific.

## [0.5.6] - 2026-07-20

### Fixed

- Opening a route now replaces the routes list with a full editor instead of burying an edit panel below the grid with no scroll.
- Removed the laggy route-card lift animation so clicks feel immediate.

## [0.5.5] - 2026-07-20

### Added

- Back navigation throughout onboarding with in-progress form and route state preserved.
- All On and All Off controls for every connected account's model list.
- Direct API-key links for OpenRouter and NVIDIA NIM connection forms.

### Changed

- Reworked Routes into a compact card grid with whole-card editing and a focused editor.
- Added drag-and-drop route-member ordering alongside the existing accessible arrow controls.
- Removed onboarding credential autodetection and its renderer, dashboard, CLI, and IPC paths.
- Formalized project governance, release lifecycle, PR/release note expectations, and repository hygiene (branch cleanup, merge defaults, maintainer docs).

## [0.5.4] - 2026-07-18

### Fixed

- Classify thrown context failures so they do not poison OAuth account pools.

## [0.5.3] - 2026-07-18

### Fixed

- Pre-output stream inspection pass-through and related streaming edge cases.

## [0.5.2] - 2026-07-18

### Fixed

- Bound pre-output stream inspection so inspection cannot hang the request path.

## [0.5.1] - 2026-07-18

### Fixed

- Route exhaust / fallback until a usable upstream response is obtained.

## [0.5.0] - 2026-07-18

### Added

- Headless Linux CLI and local web dashboard (`rerouted`, `/dashboard/`).
- Linux npm-compatible release tarball on stable GitHub Releases.

### Changed

- Product positioning covers macOS menu bar and Linux headless control plane.

## [0.4.18] - 2026-07-18

### Added

- Anthropic Messages compatibility (`/v1/messages`, token count, Claude Code path quirks).
- Explicit adaptive thinking support for Claude adaptive requests.

### Fixed

- Tool-use cycles and provider translation edge cases for Claude Code workflows.

## Earlier 0.4.x

See [GitHub Releases](https://github.com/gitcommit90/rerouted/releases) for artifact digests and notes prior to the Keep a Changelog narrative. Notable themes in late 0.4.x included signed/notarized distribution, in-app updates, named routes, OAuth account pools, OpenAI chat completions and Responses routing, and launch hardening.

[Unreleased]: https://github.com/gitcommit90/rerouted/compare/v0.5.11...HEAD
[0.5.11]: https://github.com/gitcommit90/rerouted/compare/v0.5.10...v0.5.11
[0.5.10]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.10
[0.5.9]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.9
[0.5.8]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.8
[0.5.7]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.7
[0.5.5]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.5
[0.5.4]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.4
[0.5.3]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.3
[0.5.2]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.2
[0.5.1]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.1
[0.5.0]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.0
[0.4.18]: https://github.com/gitcommit90/rerouted/releases/tag/v0.4.18
