# Contributing

## Failing test first

Every bug fix and rework PR starts with a test that fails on `main` and
passes with the change. Pick the cheapest layer that can actually catch the
regression:

| Layer | When it is the right home | Run with |
|-------|---------------------------|----------|
| Unit (`src/**/__tests__/`) | Pure logic, services with mockable edges | `npm test` |
| Built-bundle integration (`testing/integration/`) | Anything that can break in the compiled artifact: externals, plugin load, settings defaults, provider listing | `npm run test:integration` |
| Release smoke (`testing/native/desktop-automation/`, runs in `macos-e2e.yml`) | Behavior that needs real Obsidian: provider dropdown, chat round-trips, recorder, embeddings | `npm run test:native:desktop:release-smoke` |
| Device lanes (`test:native:windows:*`, `test:native:android*`) | Platform-specific runtime behavior | local only |

If a regression recurs (see #201), its guard belongs in CI permanently, not
in a one-off manual check.

## Provider fixtures, not real keys

Tests never depend on real provider credentials. `testing/fixtures/providers/`
serves deterministic OpenRouter-compatible, Ollama, LM Studio, Whisper, and
embeddings endpoints on ephemeral ports; point settings at those. If a test
needs a response shape the fixtures lack, extend the fixture and lock the new
shape into `testing/integration/provider-fixtures.test.ts`.

## Gates before any PR

```
npm run check:plugin:fast   # tsc + bundle + script tests + unit tests
npm test                    # full unit suite
npm run test:integration    # production build + built-bundle suite
```

CI runs the same gates plus the macOS E2E lane on every PR. A PR is ready for
review when all of them are green locally.

## Conventions

- Match the surrounding file's style exactly (indentation, naming, idiom).
  No drive-by reformatting.
- The compiled `main.js`/`styles.css` at the repo root are build artifacts;
  never edit them by hand and only commit them when a release flow asks for it.
- New emails, providers, or commands follow registry patterns; grep for an
  existing exemplar before inventing a new shape.
