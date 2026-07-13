# ReRouted repository instructions

## Non-negotiable definition of done

Never describe a fix, feature, refactor, UI pass, documentation update, or other iteration as "done" until every item below is true:

1. The relevant automated tests pass.
2. The package version is bumped so the shipped app has a unique identity.
3. The change is committed on a branch and pushed to `origin`.
4. The branch is merged into `main` and the merged `main` is pushed.
5. The Apple Silicon DMG is rebuilt from that exact merged `main` commit.
6. The newest DMG is transferred to and installed on the host named `macair`.
7. `/Applications/ReRouted.app` is launched on `macair` and its installed version is verified.
8. The final report records the version, merged commit, DMG filename, DMG SHA-256, and MacBook Air verification.

If any item is missing, say exactly what remains. Do not use "done" as shorthand for code-complete, tests-passing, committed, or pushed.

Follow [docs/release-checklist.md](docs/release-checklist.md) for commands and ordering.

## Repository basics

- Target branch: `main`.
- DMG target: Apple Silicon macOS (`arm64`).
- Test command: `npm test`.
- Package command: `npm run package:dmg` on macOS.
- Preserve user data in `~/Library/Application Support/ReRouted` or the existing lowercase `rerouted` directory during app replacement.
- Do not claim broad OpenAI API compatibility beyond the routes implemented in `src/lib/gateway.js`.
- Same-provider OAuth accounts use automatic fill-first fallback. Explicit combos still control
  cross-provider/model fallback and round-robin behavior.
