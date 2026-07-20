# Changelog

All notable changes to ReRouted are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release tags use the form `vX.Y.Z` and match `package.json`. GitHub Releases carry the installable artifacts; this file is the durable narrative for humans and agents.

## [Unreleased]

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

[Unreleased]: https://github.com/gitcommit90/rerouted/compare/v0.5.5...HEAD
[0.5.5]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.5
[0.5.4]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.4
[0.5.3]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.3
[0.5.2]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.2
[0.5.1]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.1
[0.5.0]: https://github.com/gitcommit90/rerouted/releases/tag/v0.5.0
[0.4.18]: https://github.com/gitcommit90/rerouted/releases/tag/v0.4.18
