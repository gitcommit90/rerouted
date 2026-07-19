## External contributions

ReRouted is MIT licensed. **External pull requests are not accepted yet.** Read [CONTRIBUTING.md](../CONTRIBUTING.md). External code or docs PRs may be closed without review until that policy changes.

Never include real API keys, gateway keys, OAuth tokens or codes, callback URLs, cookies, account identifiers, email addresses, private prompts, provider responses, or unreviewed logs.

## Summary

<!-- User-visible problem and resulting behavior. One concern per PR. -->

## Type of change

- [ ] Fix
- [ ] Feature
- [ ] Docs / governance
- [ ] Refactor (no intended behavior change)
- [ ] Chore / CI

## Release notes (required for user-visible changes)

Paste the bullets that should land in `CHANGELOG.md` under Unreleased / the next version:

```markdown
### Fixed
- …

### Added
- …
```

- [ ] `CHANGELOG.md` updated (or N/A: internal-only with no user impact)

## Version

- [ ] No release this PR (docs/governance/chore only)
- [ ] Version bump included (`package.json`) — unique, not previously tagged

## Verification

- [ ] Focused validation for the changed area
- [ ] `npm test` passes
- [ ] `git diff --check` passes
- [ ] UI changes inspected or captured where applicable
- [ ] No credentials, private user data, or generated release artifacts committed
- [ ] Packaging/signing left to [docs/release-checklist.md](../docs/release-checklist.md)

## Post-merge (maintainers)

- [ ] Head branch deleted
- [ ] CI green on `main`
- [ ] If shipping: follow [docs/release-lifecycle.md](../docs/release-lifecycle.md) end-to-end
