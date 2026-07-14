# Contributing

Work from `~/gits/systemsculpt/plugin`. The sibling website/API and operator
repositories live at `~/gits/systemsculpt/website` and
`~/gits/systemsculpt/systemsculpt-os`; do not copy their implementation into this client.

## Put each test at the interface it proves

| Layer | Use it for | Command |
|---|---|---|
| Unit (`src/**/__tests__/`) | Logic and modules with mockable seams | `npm test` |
| Compiled integration (`testing/integration/`) | Production bundle loading, managed contracts, host composition, and import safety | `npm run test:integration` |
| Script policy (`scripts/*.test.mjs`) | Build, release, sync, workflow, and repository invariants | `node --test <test>` |

Start behavioral fixes with a failing test at the cheapest layer that observes
the real failure. Keep managed-service tests deterministic and credential-free;
extend `testing/fixtures/managed/` when a contract needs another fixture.

## Normal edit loop

```bash
npm run check
npm run test:related -- <changed src files>
```

Use the focused test command for the module being changed instead of the full
suite. Add compiled integration only for bundle/composition changes. Run
`npm run check:plugin` at substantial checkpoints and `npm run check:full`
before release.

## Conventions

- Match surrounding style; avoid drive-by formatting.
- Never edit generated `main.js` or `styles.css` by hand.
- Follow existing registries for new commands and user-facing capabilities.
- Keep local sync configuration untracked and use local `pluginTargets` only.
