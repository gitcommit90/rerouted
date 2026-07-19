# Release lifecycle

End-to-end path from idea to installed build. Command-level packaging steps live in [release-checklist.md](./release-checklist.md). This page is the **process contract** every future change is expected to follow.

```text
  issue / intent
       │
       v
  branch from origin/main
       │
       v
  implement + tests + CHANGELOG (Unreleased)
       │
       v
  npm test · git diff --check · PR (or maintainer review)
       │
       v
  squash/merge to main · delete branch · CI green on main
       │
       v
  version bump on release commit (if not already on the PR)
       │
       v
  package macOS (sign/notarize/staple) + Linux CLI from exact main SHA
       │
       v
  draft GitHub Release · verify asset digests · publish
       │
       v
  update feed check · install on macair · Linux CLI smoke
       │
       v
  done (evidence recorded)
```

## 1. Plan the change

- Prefer a GitHub Issue for user-visible bugs and features so history is searchable.
- Scope one PR to one concern. Do not mix unrelated refactors with a hotfix.
- Decide version impact early: patch vs minor vs major ([GOVERNANCE.md](./GOVERNANCE.md)).

## 2. Branch and implement

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c feat/short-slug   # or fix/ docs/ chore/
```

- Keep the worktree free of host-only files and secrets.
- Add or update tests under `tests/` for behavior changes.
- Update `CHANGELOG.md` under `## [Unreleased]` as you go (not after packaging).

## 3. Verify before review

```bash
npm ci          # when deps changed
npm test
git diff --check
```

For UI: inspect real panel/dashboard states; capture when layout changes.

## 4. Pull request

Use the repository PR template. Maintainers fill:

- **Maintainer change** — problem and outcome
- **Verification** — checklist items actually run
- **Release notes** — paste the Unreleased bullets that belong with this PR

CI must be green. External PRs remain closed per CONTRIBUTING until that policy changes.

## 5. Merge

- Prefer **squash merge** into `main`.
- Delete the head branch (repo setting + manual cleanup of leftovers).
- Confirm Actions on `main` still pass.

## 6. Version and changelog for a ship

When the change will be published as a binary/CLI release:

1. Ensure `package.json` version is unique and not already tagged.
2. Move `CHANGELOG.md` `Unreleased` notes into `## [x.y.z] - YYYY-MM-DD`.
3. Commit on `main` (or as the final squash commit of the release PR).
4. Tag only the exact commit that will be packaged: `vX.Y.Z`.

Docs-only or governance-only merges may wait for the next product release before a version bump, but still update `CHANGELOG.md` under Unreleased so notes are not lost.

## 7. Package and publish

Follow [release-checklist.md](./release-checklist.md) without skipping:

| Artifact | Required |
| --- | --- |
| `ReRouted-<ver>-arm64.dmg` | Developer ID, notarized, stapled |
| `ReRouted-<ver>-mac-arm64.zip` | Same app bits; update.electronjs.org channel |
| `ReRouted-<ver>-linux-node.tgz` | Headless CLI + dashboard |
| `ReRouted-linux-node.tgz` | Stable alias, identical bytes to versioned tarball |

Publish a **draft** release first, verify GitHub asset digests match local SHA-256, then undraft and mark latest.

## 8. Post-publish verification

- Update feed: older app version receives the ZIP; current version returns HTTP 204.
- Install public DMG on `macair`; preserve Application Support.
- Smoke Linux CLI from the public URL.
- Completion report includes version, merged SHA, all artifact digests, release URL, and verification evidence.

## 9. What “done” means

| Claim | Minimum evidence |
| --- | --- |
| Code landed | Commit on `origin/main`, CI green |
| Fix verified | Tests + reproduction no longer fails |
| Release shipped | Checklist §9 evidence block complete |
| Site updated | Snapshot deploy from the intended `main` commit when landing content changed |

If packaging, notarization, publish, or install verification was skipped, say so. Do not call the iteration done.

## Related docs

- [release-checklist.md](./release-checklist.md) — exact commands
- [signing.md](./signing.md) — code signing notes
- [architecture.md](./architecture.md) — runtime map
- [GOVERNANCE.md](./GOVERNANCE.md) — authority and repo policy
