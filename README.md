# SystemSculpt AI (Obsidian Plugin)

SystemSculpt AI adds AI chat, meeting transcription, semantic search, and agent workflows inside your Obsidian vault. Bring your own API keys or use managed models.

## Current release facts

- Plugin version: `5.7.1`
- Minimum Obsidian version: `1.4.0`
- Platforms: desktop and mobile (`manifest.json` sets `isDesktopOnly: false`)
- License: MIT

## What you can do

- Chat with your notes through SystemSculpt.
- Toggle agent mode on/off to switch between tool-assisted and pure reasoning chat.
- Select custom system prompts from vault markdown files per conversation.
- Use built-in vault tools to read, search, edit, move, and organize notes.
- Filter models by favorites in the model selection modal.
- Set up local Pi providers from the Providers tab, including clearer Ollama guidance.
- Use the redesigned Studio canvas foundation for much larger graph workspaces.
- Recover from streaming failures with clearer chat error notices and disconnect controls.
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
npm run check:release:windows         # require the GitHub Windows E2E check on the current commit
npm run check:release:ios-canary      # require the GitHub iOS canary check on the current commit
npm run test:native:ios:canary:preflight # verify the local/self-hosted iOS canary host
npm run check:release:windows:local   # optional maintained Windows host/dev helper
npm run check:release:native          # required native release matrix
npm run check:release:native -- --only-local  # local native gates before public release actions
npm run check:release:native -- --only-hosted --github-ref <sha> # hosted gates on the release SHA
npm run check:release-surfaces -- --version <version> --require-notes
npm run release:plugin                  # auto bump (major/minor/patch from commits)
npm run release:plugin -- --dry-run    # preview next version + notes only
npm run release:plugin -- --help       # show release flags and iOS canary options
npm run release:plugin -- --bump patch # force a specific bump
npm run release:plugin -- --require-ios-canary # explicit no-op reminder; iOS canary is required by default
npm run release:plugin -- --allow-missing-ios-canary "runner not provisioned yet" # explicit temporary canary exception
```

Release automation now runs fully on your local machine: it prepares release metadata, validates the plugin, builds the release bundle, commits the release metadata, runs local native gates, pushes the release commit, verifies hosted checks on that exact commit SHA, then pushes the tag and creates a draft GitHub release with `gh`.
Before it tags anything, the release script now runs a safety preflight that blocks tracked local-only files, unignored local-only files that should probably go into `.gitignore`, hardcoded local paths, hardcoded desktop vault selectors, and secret-looking tokens.
If `GITHUB_TOKEN` or `GH_TOKEN` is present but weaker than your stored `gh` login, the release script now automatically falls back to the stored auth for push and draft-release steps.
The release path now includes the built-bundle mobile startup contract through `npm run check:plugin`. The native release matrix is explicit instead of implicit: local macOS desktop baselines and Android runtime smoke must pass before the release commit is pushed, then the GitHub Windows E2E check and GitHub iOS canary check must pass on that exact pushed SHA before any tag or draft release is created. The Windows E2E check runs a fresh Obsidian install, clean-install parity, and desktop baselines on `windows-2025-vs2026` for the exact commit being released. The iOS canary check runs real App Store Obsidian on a paired physical iPhone or iPad through the self-hosted `ios-canary` runner. Local iOS runtime smoke is included automatically in the local gate phase when a paired physical device is available on the release host and is otherwise skipped honestly. Use `--allow-missing-ios-canary "<reason>"` only for a named temporary exception.
Use `npm run check:release:windows:local` only when you want the optional Windows-only dev helper on a maintained Windows host before waiting on the canonical GitHub check.

The old tag-triggered GitHub Actions release workflow is retired. Treat `npm run release:plugin` as the canonical publish path for this repo.
That release path now packages the standard Obsidian plugin artifact set only: `manifest.json`, `main.js`, and `styles.css`.
Before release, `npm run check:release-surfaces -- --version <version> --require-notes` verifies the exact version surfaces and release notes file. After a production build, add `--check-artifacts` to verify the release asset set too.
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
- Issues: `https://github.com/SystemSculpt/obsidian-systemsculpt-ai/issues`
- Email: `support@systemsculpt.com`

## License

MIT. See `LICENSE`.
