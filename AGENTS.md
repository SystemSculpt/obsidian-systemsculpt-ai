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
- Studio is portable. Nodes with hostRequirement desktop are unavailable on
  mobile; portable vault, media, and managed-generation nodes remain usable.

## Working loop

~~~bash
npm run check
npm run test:related -- <changed source files>
~~~

check is the canonical fast gate: Obsidian lint, metadata lint, production
bundle, CSS contracts, and cheap architecture policy tests.

Use broader gates only when the affected seam requires them:

~~~bash
npm run check:ui
npm run check:mobile
npm run test:integration
npm run check:plugin
npm run check:full
~~~

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
