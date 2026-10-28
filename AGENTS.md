# SystemSculpt AI Obsidian Plugin

Canonical repository guidance for every coding agent working on the SystemSculpt Obsidian client. Edit `AGENTS.md` directly.

## Product boundary

The vault is the home: capture and AI output belong there as plain Markdown.
The plugin is a thin Obsidian client, not an agent runtime. Hosted execution
stays behind the first-party API; native agents own their login and execution.
Keep notes usable after uninstall or cancellation. Make no unsupported privacy
or open-source claims; the full product and architecture rules are linked below.

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

- [Product and architecture](docs/dev/product-and-architecture.md) — Read before
  changing product behavior/copy, module design or refactoring, ownership
  boundaries, vault paths or releases.
- [Managed execution](docs/dev/managed-execution.md) — Read before changing any
  hosted AI feature (Chat, audio/transcription, documents, images, embeddings or
  Studio AI), API/protocol negotiation, local vault tools/approvals, reconnect,
  saved-chat parsing or managed compatibility/release behavior.
- [Native agents](docs/dev/native-agents.md) — Read before changing Chat backend
  choice or detection, native Claude Code/Codex execution, models or approval
  modes, native chat lifetime/history, Studio native tasks, run boards,
  Command Center orchestration, Studio persistence/migrations or reuse of
  existing standalone projects, drafts and history.
- [Adaptive UI](docs/dev/adaptive-ui.md) — Read before changing any view, modal,
  transient, command, setting, card action, CSS, platform/desktop adapter,
  pop-out behavior, mobile layout or Studio node/capability declaration.
- [Tests and CI](docs/dev/tests.md) — Read before selecting broader gates or
  changing tests, coverage or CI partitioning.
  The everyday commands, PR checks and release rules stay below.
  Detailed release validation lives in this topic; the artifact rule stays here.
- [Local development](docs/dev/local-development.md) — Read before local Obsidian
  QA, canonical-checkout sync or watcher setup; this is not a task-clone step.

## Architecture

Read [CONTEXT.md](CONTEXT.md) for domain language and
[docs/architecture.md](docs/architecture.md) for source ownership and entry points.
Use [CONTRIBUTING.md](CONTRIBUTING.md) for change and review standards. Durable
decisions live in [docs/adr](docs/adr); audit reports and temporary plans stay
outside this repository.

## Working loop

~~~bash
npm run check
npm run test:related -- <changed source files>
~~~

Run the working loop once for the changed area. There is no pre-push suite;
pre-commit still scans staged files for secrets. The PR's stable `required` job
runs lint, types, build, related tests and the license/credits money suites.
The full check:ci and four compatibility lanes run after merge on main (and
on manual dispatch), not as merge requirements. Fix or revert a red main run
at once. Release publication independently validates the exact published tag bytes.

Gate contents, compatibility and release validation live in
[Tests and CI](docs/dev/tests.md). Obsidian Community Plugins owns installation
and rollback; the plugin only detects and announces published releases.

- Release artifacts are exactly manifest.json, main.js, and styles.css.

## Repository hygiene

- Publishing and releasing require operator approval. Trellis's standing
  authority covers its commits, pushes, PRs, merges, deploys and releases;
  no additional CEO round-trip is needed.
- Preserve unrelated dirty work.
- Do not commit generated main.js or styles.css unless the release workflow
  explicitly requires them.
- Do not keep plans, research snapshots, device harnesses, status dumps, or
  provider experiments in this repository.
- Keep user docs aligned with current commands and settings whenever those
  surfaces change.
