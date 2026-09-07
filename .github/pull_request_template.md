<!-- PR title should follow Conventional Commits, e.g. "fix: reject invalid --currency values" -->
<!-- Base this on `develop` unless you are syncing develop into master. -->

## Summary
<!-- What does this change and why? -->

Closes #<!-- issue number -->

## Type
- [ ] feat
- [ ] fix
- [ ] docs
- [ ] chore / refactor / test / perf

## Checklist
- [ ] `npm test` passes locally
- [ ] `npm run check` passes (type check)
- [ ] `npm run lint` passes
- [ ] Commits follow Conventional Commits
- [ ] Docs updated if behavior changed (README / flags / CLAUDE.md)
- [ ] No secrets, keys, or tenancy OCIDs in the diff

## Notes
<!-- Tradeoffs, follow-ups, manual test steps reviewers should know about. -->

<!--
Release: nothing manual. `feat:`/`fix:` commits reaching master let release-please
open a Release PR; merging that PR tags, releases, and publishes to npm.
-->
