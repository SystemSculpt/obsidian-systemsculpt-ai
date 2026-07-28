# SystemSculpt AI Obsidian Plugin

Canonical repository guidance for the SystemSculpt Obsidian client. CLAUDE.md
is a symlink to this file; edit this file only.

## Repository boundary

The SystemSculpt workspace has three sibling repositories:

- ~/gits/systemsculpt/plugin — this Obsidian client.
- ~/gits/systemsculpt/website — the customer website and first-party API.
- ~/gits/systemsculpt/systemsculpt-os — growth and operator automation.

The plugin is a thin, vault-native client. It owns Obsidian integration,
presentation, local vault tools, approvals, durable local state, and portable
Studio behavior. It does not own provider SDKs, provider credentials, model
catalogs, marketing operations, server sessions, or a local AI runtime.

All AI traffic uses the first-party SystemSculpt API at
https://systemsculpt.com/api/plugin. OpenRouter and server agent
implementation details stay behind that interface.

## Architecture

- Prefer one deep module with a narrow interface over adapters that simply
  rename or forward calls.
- Keep ownership local to the capability. Views render and coordinate; domain
  modules own state transitions, persistence, policy, and transport.
- The compiled plugin is the integration seam. Tests under
  testing/integration import the production bundle in an Obsidian host mock.
- Managed-service contracts and fixtures live under
  testing/fixtures/managed. Tests and CI remain credential-free.
- Built-in tool names describe user actions, not transport history. Do not add
  MCP or provider terminology to product code.
- Obsidian Community Plugins owns plugin updates. Do not restore a custom
  version checker or update modal.
- Studio is portable. Every built-in node declares
  requiredHostCapabilities, including an explicit empty list for portable
  nodes. Registry presentation, run preflight, and runtime enforcement all use
  the same declaration.

## Desktop and mobile product contract

Desktop and mobile are one adaptive product, not separate feature trees. Keep
shared state, services, views, and components together. Adapt through these
three independent seams:

1. Host capability: src/platform/hostCapabilities.ts owns device capability
   checks and Electron resolution. Feature code uses hasHostCapability and
   never reads Platform to decide behavior or loads Electron directly.
   src/platform/desktopOnly.ts remains the only Node built-in loader.
2. Surface geometry: every plugin-owned view, modal, or transient mounts
   PluginSurface. Use container queries for available width and pointer:
   coarse for touch ergonomics. Do not infer host capability from viewport
   width.
3. Mobile host chrome: src/platform/mobileLayout.ts owns the mobile-host
   predicate. src/platform/mobileHostLayout.ts is the only code allowed to
   know Obsidian's private mobile navbar DOM; it publishes the owned
   ss-mobile-layout, ss-mobile-navbar-visible, and ss-mobile-navbar-hidden
   body classes. Feature CSS must not target .is-mobile or
   .mobile-navbar-action.

Commands, settings, and card actions must either work on both hosts, provide a
useful portable fallback, or disappear when their required capability is
absent. Never leave a control that only produces a desktop-only error on
mobile. Fixed and bottom-aligned surfaces consume the shared safe-area and
mobile-bottom-clearance tokens. Resolve layout, clipboard, focus, timers, and
Electron from the initiating element's owner window so pop-out windows remain
correct.

Obsidian 1.13 treats getSettingDefinitions as the complete settings renderer
and skips display() when it exists. SystemSculpt remains on its full imperative
renderer until every dynamic control has declarative parity. Never add partial
definitions: that turns mobile settings into heading-only rows.

## Working loop

~~~bash
npm run check
npm run test:related -- <changed source files>
~~~

check is the canonical fast gate: Obsidian lint, metadata lint, production
bundle, CSS contracts, cheap architecture policy tests, focused mobile
interactions, the ChatView critical-risk coverage gate, and an exact built
bundle smoke in a mobile Obsidian host.

Use broader gates only when the affected seam requires them:

~~~bash
npm run check:ui
npm run check:mobile
npm run test:integration
npm run test:chatview:critical
npm run test:chatview:mutants
npm run check:plugin
npm run check:ci
npm run check:compat
npm run check:full
~~~

- check:mobile runs the static mobile-safety policy, rebuilds the artifact, and
  runs focused narrow-pane, touch, accessibility, and Studio capability tests
  before opening settings, Chat, Similar Notes, and Studio from that artifact
  with desktop adapters unavailable.
- check:plugin adds TypeScript, mobile compatibility, sync, artifact, and
  release guards.
- test:chatview:critical runs the persistence, managed-request projection,
  controller/runtime/transport, storage, and restored-history UI suites with
  strict console, randomized order, open-handle detection, seeded generative
  histories, and per-file uncovered-code budgets.
- test:chatview:mutants creates an isolated source mirror, applies 13 curated
  compatibility, projection, session, durability, controller, replay, and
  restored-history regressions, and requires focused tests to kill every one.
- check:ci is the exact exhaustive PR gate. It adds strict-console randomized
  mobile interactions, critical ChatView coverage, curated mutation testing,
  the partitioned unit remainder, embeddings, already-built integration,
  open-handle detection, and release-script contracts. Focused mobile and
  ChatView paths are excluded from the unit remainder so they are not run a
  third time. check:full is its local alias.
- check:compat is the smaller compatibility contract used on Node 20.10,
  Node 24, macOS, and Windows after the exhaustive Ubuntu/Node 22 job. It runs
  the same critical ChatView suites without repeating coverage instrumentation.
- CI is credential-free. It runs check:ci on Ubuntu/Node 22 and check:compat
  across the compatibility matrix. It has no provider or native-device lane.
- The installed pre-push hook runs check:ci before a push. Hosted CI remains
  authoritative and branch protection must require the stable `required` job,
  which fails unless every exhaustive and compatibility lane succeeds.
- Top-level hosted Jest gates record replay-oriented child argv and seed.
  Failed jobs retain those records, ChatView coverage, artifact inspection,
  build provenance, and exact plugin artifact bytes for 14 days. The exhaustive
  plugin lane also records mutation results when that gate is reached.
- Release validation records the SHA-256 and size of manifest.json, main.js,
  and styles.css plus the source revision and build environment identity.
- Saved chat parsing fails closed. A malformed or truncated history must never
  become a shortened request. Leave the source note unchanged, open a fresh
  unsaved chat, and keep a visible corruption banner.

## Local Obsidian loop

systemsculpt-sync.config.json is an ignored machine-local file. List Obsidian
plugin folders under pluginTargets, then use:

~~~bash
./run.sh --headless
npm run sync:local
npm run dev:watch:install
~~~

On the normal macOS development machine, install the persistent watcher once.
It stays running across logins, rebuilds on source changes, atomically replaces
each artifact before reload, and hot reloads configured vaults.
Re-running the install from another
worktree intentionally transfers watcher ownership to that worktree. Synced
development manifests include a visible local-only build identity without
changing the release version used by server contracts. Use the official
Obsidian CLI or Computer Use for live reload, errors, DOM inspection, and
visual verification.

For mobile-sensitive changes, npm run check:mobile and npm run check:full are
the release gates. They validate the exact built main.js, manifest.json, and
styles.css across narrow-pane, touch, keyboard, accessibility, and Studio
capability scenarios with desktop adapters unavailable. Simulator, emulator,
browser-emulation, or physical-device runs may provide supplemental evidence
when explicitly requested, but they are not release gates and must not replace
or weaken the deterministic checks. Record the host and artifact hashes when
manual mobile exploration is performed.

## Product contracts

- Approval modes are Ask Approval and Full Access.
- Read-only vault tools may run immediately; mutating tools follow the selected
  approval policy.
- File and folder paths are vault-relative unless a desktop-only Studio node
  explicitly accepts an external path.
- The API base is a build-time value. Settings never expose routing,
  credentials, providers, or model selection.
- Release artifacts are exactly manifest.json, main.js, and styles.css.

## Repository hygiene

- Never commit, push, open a PR, merge, publish, or release without explicit
  operator approval.
- Preserve unrelated dirty work.
- Do not commit generated main.js or styles.css unless the release workflow
  explicitly requires them.
- Do not keep plans, research snapshots, device harnesses, status dumps, or
  provider experiments in this repository.
- Keep user docs aligned with current commands and settings whenever those
  surfaces change.

See docs/development.md for detailed checks and local QA.
