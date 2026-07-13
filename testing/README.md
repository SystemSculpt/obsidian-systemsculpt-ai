# Testing architecture

The test system has three canonical layers:

1. `src/**/__tests__/` proves module behavior with Jest.
2. `testing/integration/` imports the production bundle and proves managed
   contracts plus desktop host composition.
3. `scripts/*.test.mjs` proves build, release, workflow, sync, and repository policy.

Managed fixtures live in `testing/fixtures/managed/`; versioned settings inputs
live in `testing/fixtures/settings/`. No test lane requires provider keys, a
hosted service, an installed desktop app, a physical device, or a remote host.

## Commands

```bash
npm run check
npm test
npm run test:embeddings
npm run test:integration
npm run check:full
```

`check` plus focused tests is the normal edit loop. It is bounded:
TypeScript, a production artifact build, CSS, and tiny deterministic policy
tests. `check:full` adds exhaustive Obsidian source and metadata lint, full unit
and embeddings suites, compiled integration, and release-script verification.

## Local plugin reload

`./run.sh` watches the build and copies successful artifacts to local Obsidian
plugin folders listed in `systemsculpt-sync.config.json` under `pluginTargets`.
Use the installed official Obsidian CLI for reload and live-app inspection.

## CI

`.github/workflows/ci.yml` contains two secret-free Ubuntu jobs:

- `unit`: install and fast checks only.
- `desktop-baselines`: install, production build, compiled integration suite.

Both job names are compatibility plumbing. They do not imply a full suite or a
desktop runtime.
