# Local development

Repository instructions for canonical-checkout sync, watcher setup and local
Obsidian QA. The [core](../../AGENTS.md) supplies task-clone verification
commands; keep task clones isolated from the live vault. Mobile verification
gates live in [Adaptive UI](adaptive-ui.md). The broader setup reference is the
[development guide](../development.md).

## Local Obsidian loop

The commands below document canonical-checkout sync/watcher setup, not a task
clone step. For task work, use the verification commands above without syncing
to a live vault or changing watcher ownership.

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

See docs/development.md for detailed checks and local QA.
