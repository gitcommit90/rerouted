# Project governance

ReRouted is an independent personal project maintained by [@gitcommit90](https://github.com/gitcommit90). This document defines how the public repository is run so every change is reviewable, tested, versioned, and released the same way.

## Authority

| Role | Who | Authority |
| --- | --- | --- |
| Maintainer | Repository owner (`gitcommit90`) | Merge to `main`, publish releases, change policy, close issues/PRs |
| Agent / automation | Local maintainers and CI | May open branches, run tests, draft PRs; may not publish a release without following [release-checklist.md](./release-checklist.md) |
| External contributors | Anyone else | Issues and sanitized reports only until external PRs are explicitly enabled in [CONTRIBUTING.md](../CONTRIBUTING.md) |

There is no separate legal entity, community board, or multi-maintainer vote. Policy lives in this repository. Host-local packaging credentials and machine aliases stay outside git (see maintainer handoff on the build hosts, not in this repo).

## Source of truth

| Artifact | Canonical location |
| --- | --- |
| Product code | `main` on `https://github.com/gitcommit90/rerouted` |
| Public site | `https://rerouted.dev` (deployed from a versioned snapshot of `main`, never a dirty worktree) |
| Version number | `package.json` `version` field |
| User-facing history | `CHANGELOG.md` plus the GitHub Release body for that tag |
| Ship procedure | [release-checklist.md](./release-checklist.md) and [release-lifecycle.md](./release-lifecycle.md) |
| Architecture | [architecture.md](./architecture.md) |
| Security contact | [SECURITY.md](../SECURITY.md) |

## Branch model

- **Default branch:** `main` only. There is no long-lived `develop`.
- **Work branches:** short-lived, named for intent:
  - `feat/<slug>` — user-visible capability
  - `fix/<slug>` — defect
  - `docs/<slug>` — documentation only
  - `chore/<slug>` — tooling, governance, CI, repo hygiene
  - `refactor/<slug>` — internal structure without intended behavior change
  - `release/<version>` — optional packaging-only branch (usually unnecessary)
- **Merge method:** squash merge preferred for feature work so `main` stays linear and each PR becomes one reviewable commit. Merge commits are allowed when preserving multi-commit history is intentional.
- **Delete on merge:** remote head branches are deleted after merge.
- **No direct force-push to `main`.** History rewrites of published tags or releases require an explicit maintainer decision.

## Required quality bar (every change)

No change lands on `main` without:

1. A focused description of the user-visible problem and outcome (PR body or commit body for direct maintainer merges).
2. Tests for behavioral changes (`tests/*.test.js`) or an explicit justification when the change is docs/governance only.
3. `npm test` green on the branch (local and GitHub Actions).
4. `git diff --check` clean.
5. No secrets, private prompts, real OAuth material, generated DMGs/ZIPs, or host-only files (`AGENTS.md` and similar).

UI changes should include current captures when the control plane layout changes in a way users would notice.

## Versioning and releases

- Semantic versioning on `package.json`: **MAJOR** for breaking local API or data migrations users must handle; **MINOR** for backward-compatible features; **PATCH** for fixes and small safe improvements.
- Every shipped macOS/Linux build has a **unique** version. Never rebuild and republish the same version number with different bits.
- A release is **not** “done” when code merges. It is done only when [release-checklist.md](./release-checklist.md) is complete: signed notarized macOS DMG + updater ZIP, Linux CLI tarball, published GitHub Release, update-feed check, and install verification.
- Draft and prerelease GitHub Releases are not update channels for the stable app.

## Communication surfaces

| Surface | Use for |
| --- | --- |
| GitHub Issues | Bugs, feature requests, questions (sanitized) |
| GitHub Security Advisories | Vulnerabilities only |
| GitHub Releases + `CHANGELOG.md` | What shipped |
| https://rerouted.dev | Product marketing and download entry |
| Pull requests | Maintainer (and future external) code review |

## Repository settings (expected)

Maintainers should keep these GitHub settings true:

- Default branch `main`
- Delete head branches on merge: **on**
- Squash merge: **on** (preferred)
- Merge commit / rebase: optional
- Wiki: **off** (docs live in-repo)
- Issues: **on**
- Secret scanning + push protection: **on**
- Actions: run tests on `push` to `main` and on pull requests
- Branch protection on `main`: require status check **Tests / test** when the plan allows required checks; disallow force-push

## Local clone naming

- GitHub repository name: `rerouted` (lowercase).
- Canonical maintainer clone path on ProxUI: `/root/rerouted`.
- Product display name: **ReRouted**.
- npm package name: `@gitcommit90/rerouted`.
- macOS app bundle / DMG product name: `ReRouted`.

Do not invent alternate public product names. Side folders such as release worktrees, site snapshots, or historical sandboxes are not the product root.

## Policy changes

Governance changes land through the same branch + test + merge path as code (docs-only PRs still use the PR template). Material policy shifts (accepting external PRs, changing license, moving ownership) require an explicit maintainer commit message and a `CHANGELOG.md` entry under the next release.
