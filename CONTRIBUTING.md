# Contributing

## Branch workflow

`master` is the single integration and release branch. Create a short-lived
feature, fix, documentation, or chore branch from the latest `master`, then open
a pull request back to `master`. Do not base new work on `develop`.

Keep commits compatible with [Conventional Commits](https://www.conventionalcommits.org/),
because release-please derives release notes and version changes from commit
messages reaching `master`.

## Local checks

Install the locked dependencies and run the same checks used by CI:

```bash
npm ci
npm run lint
npm run check
npm test
```

CI validates the exact minimum supported Node.js versions (22.23.4, 24.22.1,
and 26.12.1) on Linux and Node.js 24.22.1 on macOS and Windows. Use a supported
patched runtime for local development (see the README). Pull requests must pass the required CI checks before merge.

## Releases

Merging normal pull requests into `master` lets release-please maintain the
release pull request. Merging that release pull request creates the tag and
GitHub release and publishes the package. Do not run `npm version` manually.
