# SystemSculpt AI (Obsidian Plugin)

SystemSculpt AI adds AI chat, vault-aware tools, semantic note search, transcription, and workflow automations to Obsidian.

## Current release facts

- Plugin version: `5.4.0`
- Minimum Obsidian version: `1.4.0`
- Platforms: desktop and mobile (`manifest.json` sets `isDesktopOnly: false`)
- License: MIT

## What you can do

- Chat with your notes through SystemSculpt.
- Toggle agent mode on/off to switch between tool-assisted and pure reasoning chat.
- Select custom system prompts from vault markdown files per conversation.
- Use built-in vault tools to read, search, edit, move, and organize notes.
- Filter models by favorites in the model selection modal.
- Find semantically similar notes with embeddings.
- Record audio and transcribe notes.
- Run capture-folder workflow automations.
- Use CanvasFlow image generation in Obsidian Canvas (experimental).

## Quick start

1. Install **SystemSculpt AI** from Obsidian Community Plugins (or use manual install below).
2. Open `Settings -> SystemSculpt AI -> Account`.
3. Activate your SystemSculpt license key.
4. Run the command `Open SystemSculpt Chat`.
5. Optional: enable embeddings in `Knowledge` for Similar Notes.

## Installation

### Community Plugins (recommended)

1. Open Obsidian `Settings -> Community plugins`.
2. Search for `SystemSculpt AI`.
3. Click `Install`, then `Enable`.

### Manual install

```bash
cd /path/to/vault/.obsidian/plugins/
git clone https://github.com/systemsculpt/obsidian-systemsculpt-ai systemsculpt-ai
cd systemsculpt-ai
npm install
npm run build
```

## Core docs

- Docs hub: `docs/README.md`
- Getting started: `docs/user/getting-started.md`
- Settings reference: `docs/user/settings.md`
- Commands: `docs/user/commands.md`
- Ribbon icons: `docs/user/ribbon-icons.md`
- Similar Notes: `docs/user/similar-notes.md`
- Audio & transcription: `docs/user/audio-transcription.md`
- Automations: `docs/user/automations.md`
- Troubleshooting: `docs/user/troubleshooting.md`

## Development

### Build and checks

```bash
npm run dev               # watch build
npm run build             # production build
npm run check:plugin      # typecheck + bundle resolution
npm run check:plugin:fast # faster local check
npm run check:all         # plugin check + Jest suite
```

If you keep a local-only `systemsculpt-sync.config.json`, the dev watcher now auto-syncs every successful rebuild into all configured `pluginTargets` plus any `mirrorTargets`, including remote Windows SSH mirrors declared as `"type": "windows-ssh"`.
`./run.sh --headless` remains the canonical background entrypoint because it enables the same build-integrated sync path and also asks the already-open desktop vault to hot-reload the plugin after local sync succeeds.

### Tests

```bash
npm test
npm run test:debug
npm run test:strict
npm run test:embeddings
npm run test:leaks
npm run test:native:desktop:extended
npm run test:native:android:extended
npm run check:pre-push              # full native gate (unit + build + Android + Windows)
npm run check:pre-push:quick        # fast gate (unit + build only)
```

Testing architecture docs:

- `testing/README.md`
- `testing/native/README.md`

Desktop validation is attach-only to an already-open Obsidian vault. Keep live sync running with `./run.sh --headless` and use the desktop bridge runner when you need real chat/model verification without taking focus.


### Local plugin release

```bash
npm run check:release:windows         # build + Windows 11 clean install + Windows baselines
npm run check:release:native          # required native release matrix
npm run release:plugin                  # auto bump (major/minor/patch from commits)
npm run release:plugin -- --dry-run    # preview next version + notes only
npm run release:plugin -- --bump patch # force a specific bump
```

Release automation now runs fully on your local machine: it validates the plugin, builds the release bundle, commits the version bump, pushes `main` and the tag, and creates a draft GitHub release with `gh`.
Before it tags anything, the release script now runs a safety preflight that blocks tracked local-only files, unignored local-only files that should probably go into `.gitignore`, hardcoded local paths, hardcoded desktop vault selectors, and secret-looking tokens.
If `GITHUB_TOKEN` or `GH_TOKEN` is present but weaker than your stored `gh` login, the release script now automatically falls back to the stored auth for push and draft-release steps.
The native release matrix is now explicit instead of implicit: macOS desktop baselines, Windows clean-install parity, Windows desktop baselines, and Android runtime smoke must all pass before release creation can continue. iOS runtime smoke is included automatically when a paired physical device is available on the host and is otherwise skipped honestly.
Use `npm run check:release:windows` when you want the fast Windows-only release gate on the online Windows VM before running the full native matrix.

The old tag-triggered GitHub Actions release workflow is retired. Treat `npm run release:plugin` as the canonical publish path for this repo.
That release path now packages the standard Obsidian plugin artifact set only: `manifest.json`, `main.js`, and `styles.css`.
Desktop validation is now bridge-based and no-focus by default; the old renderer-driving desktop lane is retired.
When multiple synced desktop vaults exist, use `--vault-name <vault-name>` or `--vault-path <absolute-path>` to pin one explicitly. Otherwise the desktop runner prefers the latest live bridge target automatically.

## Canonical source files for docs

These files define the user-facing surfaces and are the source of truth:

- Settings tabs: `src/settings/SettingsTabRegistry.ts`
- Commands: `src/core/plugin/commands.ts`, `src/main.ts`
- Ribbon icons: `src/core/plugin/ribbons.ts`
- Filesystem MCP tools: `src/mcp-tools/filesystem/toolDefinitions/*.ts`
- YouTube MCP tool: `src/mcp-tools/youtube/MCPYouTubeServer.ts`
- Web research tools: `src/services/web/registerWebResearchTools.ts`

## Support

- Website: `https://systemsculpt.com`
- Repo: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai`
- Discord: `https://discord.gg/3gNUZJWxnJ`
- Email: `support@systemsculpt.com`

## License

MIT. See `LICENSE`.
