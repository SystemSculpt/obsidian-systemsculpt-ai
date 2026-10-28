# Contributing

The canonical checkout is `~/gits/systemsculpt/plugin`; its watcher deploys into a live vault. Do task work in a task-private ordinary clone on a branch from current `origin/main`, leaving the canonical checkout and watcher alone. Do not install or run the watcher from a task clone. The sibling website/API and operator repositories live at `~/gits/systemsculpt/systemsculpt-website` and `~/gits/systemsculpt/systemsculpt-os`; do not copy their implementation into this client.

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

Run the loop once for the changed area, using the focused test command instead
of the full suite. Add compiled integration only for bundle/composition
changes. `release:plugin` retains the full `check:ci` gate before release.

## Conventions

- Match surrounding style; avoid drive-by formatting.
- Never edit generated `main.js` or `styles.css` by hand.
- Follow existing registries for new commands and user-facing capabilities.
- Keep local sync configuration untracked and use local `pluginTargets` only.

## Module design

Start with [domain language](CONTEXT.md) and the [source map](docs/architecture.md).
Group code by the behavior and state it owns. A caller should request an outcome
without coordinating that module's internal ordering, mutable records, or
cleanup. Keep one owner for each state transition and persistence policy.

Before adding an abstraction, describe what knowledge it removes from callers.
If deleting it removes only forwarding, remove the abstraction. Add dependency
interfaces where something actually varies, such as the real transport and a
deterministic test transport. Avoid exposing private hooks solely for tests.
File size alone is not a reason to split a module; a coherent owner with private
helpers is easier to change than a collection of mutually dependent callbacks.

Use explicit domain names. Do not encode implementation generations in active
module names; retain version numbers where they identify a persisted or wire
contract. Move code and its behavioral tests together, update importers, and
remove old forwarding paths when compatibility does not require them.

Tests should exercise the same operations available to production callers and
assert observable results. When replacing a shallow interface, move its useful
behavioral coverage to the new interface and remove redundant internal tests.
Keep boundary failures, concurrency, cancellation, and recovery tests: fewer
lines do not justify weakening those guarantees.

## Review changes along two independent axes

Pin a comparison before review: a resolved commit for committed changes, or a
snapshot of the initial working files for an already-dirty checkout. Use the
actual request and product contracts as the specification; do not silently
compare a cleanup against unrelated historical work.

- **Standards:** check documented ownership, domain language, interface depth,
  locality, duplication, speculative abstractions, and unnecessary delegation.
  A suspected code smell is a judgment to explain, not an automatic violation.
- **Spec:** check requested behavior, omitted requirements, unintended changes,
  preservation of saved data, and whether evidence supports the claimed result.

Use two independent reviewers only for money (license/credits), secrets, or
approval/permission enforcement changes. Other changes need one review, not
a two-reviewer gate. Resolve actionable findings; green tests do not replace
review.

These conventions apply [Matt Pocock's module-design guidance](https://github.com/mattpocock/skills/blob/959a8e9f1edc3adbe2f7e3054bb6fbefa6696260/skills/engineering/codebase-design/SKILL.md)
and [independent standards/spec review](https://github.com/mattpocock/skills/blob/959a8e9f1edc3adbe2f7e3054bb6fbefa6696260/skills/engineering/code-review/SKILL.md)
to this repository. Repository product contracts remain authoritative.
