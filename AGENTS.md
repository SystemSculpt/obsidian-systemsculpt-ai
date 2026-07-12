# AGENTS.md

Canonical guidance for agents working on the SystemSculpt AI Obsidian plugin.
`CLAUDE.md` is a symlink to this file; edit this file only.

## Architecture

- Prefer one deep module with a small interface over compatibility wrappers and
  duplicated runners. Delete obsolete paths when the canonical path is proven.
- Keep changes local to the capability being changed and add the cheapest test
  that catches its failure mode.
- The compiled plugin is the integration seam. Tests under
  `testing/integration/` import the production bundle in desktop, simulated
  mobile, and no-Node host modes.
- Managed-service contracts and fixtures live under `testing/fixtures/managed/`.
  Tests and CI must not require hosted provider credentials or live services.

## Checks by scope

```bash
npm run check:plugin:fast # normal edit loop
npm run test:related -- <changed src files> # focused source behavior
npm run test:reload       # reload seam changes
npm run test:integration # bundle/composition changes
npm run check:egress     # network-capable source changes
```

The normal edit loop is the fast check plus focused tests for the touched
module. Run `npm run test:egress-analyzer` only when changing the analyzer
itself. Full unit, embeddings, compiled integration, and egress verification
run once at a combined checkpoint or release; the release script owns that
sequence.

CI has exactly two secret-free Ubuntu compatibility contexts: `unit` runs the
fast check, while `desktop-baselines` builds and imports the compiled artifact.
The names do not imply full-suite, native-host, or device behavior.

## Local Obsidian iteration

`./run.sh` is the local watcher. A local-only
`systemsculpt-sync.config.json` lists Obsidian plugin folders in
`pluginTargets`; successful builds copy the standard plugin artifacts and ask
an already-running Obsidian instance to reload through `scripts/obsidian-reload/`.
The reload seam exposes ping, status, and reload only. Its focused checks are
`npm run test:reload`.

## Source locations

- Contributor test-layer guidance: `CONTRIBUTING.md`
- Detailed commands: `docs/development.md`
- Test inventory: `testing/README.md` and `docs/testing-coverage-map.md`
- Release artifacts: `scripts/plugin-artifacts.mjs`
- Release policy: `scripts/check-release-surfaces.mjs`
