# SystemSculpt AI Obsidian Plugin

Canonical repository guidance for every coding agent working on the SystemSculpt Obsidian client. Edit `AGENTS.md` directly.

## What SystemSculpt is for (read first)

1. Mission: everything a person captures and creates with AI, on any device, ends up as plain Markdown in their own Obsidian vault, on their own machine.
2. The vault is the home and the source of truth. The plugin, the iPhone app, the desktop app (next) and our servers exist to get data into it and to put AI to work on it there. None of them is a second home.
3. Plain Markdown always: every feature's output is a readable .md file (plus ordinary attachments) in the vault. No proprietary format or hidden state a person would need to keep their work.
4. Every device, one vault: a capture is finished only when it's a file in the vault. Say "In your vault" only on a verified receipt.
5. AI where the data lives: Claude Code or Codex (the person's own account) or SystemSculpt AI reads only what the person allows and writes back as files, with approval before edits.
6. No lock-in: cancelling, uninstalling or deleting an account never takes anyone's notes. What's in the vault stays.
7. Be exact about what leaves the machine: hosted AI goes through our server, OpenRouter and model providers; local agents talk to Anthropic or OpenAI; iPhone captures pass through our server. Never write "private AI", "local AI", "offline", "nothing leaves your device", "end-to-end encrypted" or "zero retention". The privacy policy is the source of truth.
8. "Open source" means the Obsidian plugin (MIT) and the Markdown format. The iPhone app and server are closed; Obsidian is free but not open source.
9. Rank work by one question: does it get a person's data into their vault as Markdown, or make it more useful there?
10. Full text: vault "02 Areas/SystemSculpt Business/Product/Mission and positioning 2026-10.md".

## Repository boundary

The SystemSculpt workspace has three sibling repositories:

- ~/gits/systemsculpt/plugin — this Obsidian client.
- ~/gits/systemsculpt/systemsculpt-website — the customer website and first-party API.
- ~/gits/systemsculpt/systemsculpt-os — growth and operator automation.

The plugin is a thin, vault-native client. It owns Obsidian integration,
presentation, local vault tool implementations, approval UX and enforcement,
a reconnecting server-protocol client, user-visible local cache/export state,
and portable Studio behavior. It does not own an agent loop, continuation
policy, provider retry, compaction, prompt caching, authoritative chat
sessions, provider SDKs, provider credentials, model catalogs, marketing
operations, or a local AI runtime.

Managed AI traffic uses the first-party SystemSculpt API at
https://systemsculpt.com/api/plugin. OpenRouter and server agent
implementation details stay behind that interface.

- The managed API base is a build-time value. The text execution selector may choose
  SystemSculpt API, on-machine Codex or on-machine Claude Code; it never exposes
  managed API routing or credentials.

## Safe checkout and live-vault watcher

Do plugin work in a task-private ordinary clone, on a branch from current
`origin/main`. The canonical checkout at `~/gits/systemsculpt/plugin` has a
persistent watcher that deploys into a live vault; leave that checkout and its
watcher alone. Never install or run the watcher from a task clone. Never switch
branches, stash or reset another worker's checkout. Never force-push.

## Read the topic before changing it

These topic files are repository instructions, not optional background. Read
all topics that apply before changing an area; commands run from the repo root.
Keep shared rules here and area-specific detail in its topic, with this index
kept current.

- [Managed execution](docs/dev/managed-execution.md) — Read before changing any
  hosted AI feature (Chat, audio/transcription, documents, images, embeddings or
  Studio AI), API/protocol negotiation, local vault tools/approvals, reconnect,
  saved-chat parsing or managed compatibility/release behavior.
- [Native agents](docs/dev/native-agents.md) — Read before changing Chat backend
  choice or detection, native Claude Code/Codex execution, models or approval
  modes, native chat lifetime/history, Studio native tasks, run boards or
  Command Center orchestration.
- [Adaptive UI](docs/dev/adaptive-ui.md) — Read before changing any view, modal,
  transient, command, setting, card action, CSS, platform/desktop adapter,
  pop-out behavior, mobile layout or Studio node/capability declaration.
- [Tests and CI](docs/dev/tests.md) — Read before selecting broader gates or
  changing tests, coverage, CI partitioning, replay records or failure evidence.
  The everyday commands, required pre-push gate and release rules stay below.

## Architecture

Read [CONTEXT.md](CONTEXT.md) for domain language and
[docs/architecture.md](docs/architecture.md) for source ownership and entry points.
Use [CONTRIBUTING.md](CONTRIBUTING.md) for change and review standards. Durable
decisions live in [docs/adr](docs/adr); audit reports and temporary plans stay
outside this repository.

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
- SystemSculpt may detect and announce published releases. Obsidian Community
  Plugins exclusively owns download, installation, activation, and rollback.

- File and folder paths are vault-relative unless a desktop-only Studio node
  explicitly accepts an external path.

## Working loop

~~~bash
npm run check
npm run test:related -- <changed source files>
~~~

check is the canonical fast gate: Obsidian lint, community-directory lint, metadata lint, production
bundle, CSS contracts, cheap architecture policy tests, focused mobile
interactions, the ChatView critical-risk coverage gate, and an exact built
bundle smoke in a mobile Obsidian host.

Use broader gates only when the affected seam requires them:

~~~bash
npm run check:ui
npm run check:mobile
npm run test:integration
npm run test:chatview:critical
npm run check:plugin
npm run check:ci
npm run check:compat
~~~

- The installed pre-push hook runs check:ci before a push. Hosted CI remains
  authoritative and branch protection must require the stable `required` job,
  which requires every exhaustive and compatibility lane to succeed. A main
  push may reuse a successful PR/merge-group run only when GitHub job records
  prove all lanes tested the identical Git tree. Missing proof or API errors
  run full CI; manual dispatch always runs it. Release publication remains
  independently triggered by a published release and validates exact tag bytes.

## Release rules

- Release validation records the SHA-256 and size of manifest.json, main.js, and styles.css plus the source revision and build environment identity. The published-release workflow rebuilds the tag, requires exact asset bytes, and attests those published bytes before announcing the release through first-party metadata.

- Release artifacts are exactly manifest.json, main.js, and styles.css.

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
Re-running the install from the canonical checkout transfers watcher ownership
back to that checkout. Never install or run the watcher from a git worktree. Synced
development manifests include a visible local-only build identity without
changing the release version used by server contracts. Use the official
Obsidian CLI or Computer Use for live reload, errors, DOM inspection, and
visual verification.

For mobile-sensitive changes, npm run check:mobile and npm run check:ci are
the release gates. They validate the exact built main.js, manifest.json, and
styles.css across narrow-pane, touch, keyboard, accessibility, and Studio
capability scenarios with desktop adapters unavailable. Simulator, emulator,
browser-emulation, or physical-device runs may provide supplemental evidence
when explicitly requested, but they are not release gates and must not replace
or weaken the deterministic checks. Record the host and artifact hashes when
manual mobile exploration is performed.

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
