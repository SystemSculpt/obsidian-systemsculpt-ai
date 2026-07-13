# Testing coverage map

Verified against the managed-only architecture in July 2026.

## Unit modules

- Chat request, streaming, persistence, export, and resume: `src/**/__tests__/`
- Settings and schema migration: `src/core/settings/__tests__/` and settings tests
- Embeddings and Similar Notes: embeddings service and processor tests
- Product integrations and transcription: focused service, tool, and UI tests
- Billing, admission, cancellation, and durable recovery: focused managed-client
  and job modules

## Compiled integration

`testing/integration/` proves:

- production bundle load in the desktop host mock;
- managed API and job contract hashes;
- managed client composition and import safety;
- Studio harness composition.

Run it with `npm run test:integration`. The suite is deterministic and does not
use provider credentials or live services.

## Repository policy

- `npm run check`: types, production artifacts, CSS, tiny policy.
- `npm run check:full`: Obsidian lint plus all local artifact, unit, embeddings,
  compiled integration, and release-script gates.
- `npm test`: full unit suite.
- `npm run test:release-script`: semantic version and three-artifact release policy.

CI preserves the required `unit` and `desktop-baselines` status names as
secret-free Ubuntu compatibility jobs: fast checks and compact compiled
integration respectively.
