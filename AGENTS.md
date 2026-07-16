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
bundle, CSS contracts, cheap architecture policy tests, and an exact built
bundle smoke in a mobile Obsidian host.

Use broader gates only when the affected seam requires them:

~~~bash
npm run check:ui
npm run check:mobile
npm run test:integration
npm run check:plugin
npm run check:full
~~~

- check:mobile runs the static mobile-safety policy, rebuilds the artifact, and
  opens settings, Chat, Similar Notes, and Studio from that artifact with
  desktop adapters unavailable.
- check:plugin adds TypeScript, mobile compatibility, sync, artifact, and
  release guards.
- check:full adds unit, embeddings, compiled integration, and release-script
  suites.
- CI has one secret-free Ubuntu/Node job and runs npm run check. There is no
  Windows, Android, iOS, provider, or native-device matrix.

## Local Obsidian loop

systemsculpt-sync.config.json is an ignored machine-local file. List Obsidian
plugin folders under pluginTargets, then use:

~~~bash
./run.sh --headless
npm run sync:local
~~~

The watcher copies main.js, manifest.json, and styles.css after successful
builds. Use the official Obsidian CLI or Computer Use for live reload, errors,
DOM inspection, and visual verification.

For a mobile-sensitive change, automated checks are necessary but not final
proof. Sync the exact built main.js, manifest.json, and styles.css into a real
Obsidian Mobile vault, verify their hashes, then exercise settings, Chat,
Similar Notes, Studio portable and blocked nodes, commands, modals, and fixed
transients. Cover portrait and landscape, keyboard open and closed, light and
dark themes, enlarged interface text, and phone plus tablet or equivalent
widths. Record which Android/iOS hosts were physically tested; desktop mobile
emulation does not count as native-host proof.

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
