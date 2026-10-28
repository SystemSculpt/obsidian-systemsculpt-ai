# Tests and CI

Repository instructions for verification gates, coverage, CI partitions,
release validation and failure evidence. Read with [the core](../../AGENTS.md),
which retains the everyday commands and pre-push requirement. Mobile release
gates also apply in [Adaptive UI](adaptive-ui.md).

## Selecting gates

check is the canonical fast gate: Obsidian lint, community-directory lint, metadata lint, production
bundle, CSS contracts, cheap architecture policy tests, focused mobile
interactions, the ChatView critical-risk coverage gate, and an exact built
bundle smoke in a mobile Obsidian host.

Use broader gates only when the affected seam requires them:

`npm run test:billing` is the focused credential-free license, credits,
checkout, and hosted billing suite. It reports coverage for the direct money
boundary owners, including settings and modals omitted by the root Jest
coverage defaults. It does not call live checkout or bill model providers.

~~~bash
npm run check:ui
npm run check:mobile
npm run test:integration
npm run test:chatview:critical
npm run check:plugin
npm run check:ci
npm run check:compat
~~~

## Gate contents

- check:ui runs the CSS and UI architecture policy tests, then test:ui:focused:
  one Jest path pattern over the UI-owned suites (surface, modals, progress,
  audio processor, recorder, history, editor, and Studio directories plus the
  named settings, context-menu, main-initialize, and chat-workspace tests).
- check:mobile runs the static mobile-safety policy, rebuilds the artifact, and
  runs focused narrow-pane, touch, accessibility, and Studio capability tests
  before opening settings, Chat, Similar Notes, and Studio from that artifact
  with desktop adapters unavailable.
- check:plugin adds TypeScript for sources and tests (tsconfig.test.json),
  mobile compatibility, sync, artifact, and release guards.
- test:chatview:critical runs the persistence, managed-request projection,
  controller/runtime/transport, storage, and restored-history UI suites with
  strict console, randomized order, open-handle detection, seeded generative
  histories, and a global coverage floor over the critical ChatView modules
  (the small identity and tool-execution modules stay at 100%).
- check:ci is the exact exhaustive PR gate. It adds the production Knip audit of
  unused files, dependencies and exports (check:knip), strict-console randomized mobile interactions, critical ChatView coverage, the partitioned unit
  remainder, embeddings, already-built integration, and open-handle detection.
  Each source suite runs exactly once: the mobile CI subset excludes
  critical-owned suites, and the unit remainder excludes both focused sets
  and the embeddings service tree. Standalone mobile checks retain all scenarios. The release-script contracts (build
  provenance, build options, artifacts, release-plugin) run inside check:plugin
  and remain available standalone as test:release-script.
- check:compat is the smaller compatibility contract used on Node 22.18,
  Node 24, macOS, and Windows after the exhaustive Ubuntu/Node 22 job. It runs
  the same critical ChatView suites without repeating coverage instrumentation
  or OS-independent ESLint. The exhaustive lane still runs every lint pass
  uncached, since per-file caches cannot see imported type changes.
- CI is credential-free. It runs check:ci on Ubuntu/Node 22 and check:compat
  across the compatibility matrix. It has no provider or native-device lane.

## Release rules

- Release validation records the SHA-256 and size of manifest.json, main.js, and styles.css plus the source revision and build environment identity. The published-release workflow rebuilds the tag, requires exact asset bytes, and attests those published bytes before announcing the release through first-party metadata.

## Failure evidence

- Top-level hosted Jest gates record replay-oriented child argv and seed.
  Failed jobs retain those records, ChatView coverage, artifact inspection,
  build provenance, and exact plugin artifact bytes for 14 days.
