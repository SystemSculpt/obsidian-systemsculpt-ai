# Testing architecture

The test system has three canonical layers:

1. `src/**/__tests__/` proves module behavior with Jest.
2. `testing/integration/` imports the production bundle and proves managed
   contracts plus desktop, simulated-mobile, and no-Node host composition.
3. `scripts/*.test.mjs` proves build, release, workflow, sync, and reload policy.

Managed fixtures live in `testing/fixtures/managed/`; versioned settings inputs
live in `testing/fixtures/settings/`. No test lane requires provider keys, a
hosted service, an installed desktop app, a physical device, or a remote host.

## Commands

```bash
npm run check:plugin:fast
npm test
npm run test:embeddings
npm run test:integration
npm run test:reload
npm run check:egress
```

`check:plugin:fast` plus focused tests is the normal edit loop. It is bounded:
TypeScript, a production artifact build, CSS, and tiny deterministic policy
tests. Run compiled integration for bundle/composition work; reserve full unit
and full integration for combined checkpoints and release. The egress
analyzer's 48-case self-test is isolated behind `npm run test:egress-analyzer`.

## Local plugin reload

`./run.sh` watches the build and copies successful artifacts to local Obsidian
plugin folders listed in `systemsculpt-sync.config.json` under `pluginTargets`.
It can then ask an already-running plugin to reload. The retained
`scripts/obsidian-reload/` seam owns only discovery, ping/status, and reload
stability; it is a developer convenience, not a CI or release requirement.

## CI

`.github/workflows/ci.yml` contains two secret-free Ubuntu jobs:

- `unit`: install and fast checks only.
- `desktop-baselines`: install, production build, compiled integration suite.

Both job names are compatibility plumbing. They do not imply a full suite or a
desktop runtime.
