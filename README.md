# SystemSculpt AI (Obsidian Plugin)

SystemSculpt AI adds AI chat, vault-aware tools, semantic note search, transcription, and workflow automations to Obsidian.

## Current release facts

- Plugin version: `5.1.1`
- Minimum Obsidian version: `1.4.0`
- Platforms: desktop and mobile (`manifest.json` sets `isDesktopOnly: false`)
- License: MIT

## What you can do

- Chat with your notes through SystemSculpt.
- Use built-in vault tools to read, search, edit, move, and organize notes.
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

### Tests

```bash
npm test
npm run test:debug
npm run test:strict
npm run test:embeddings
npm run test:leaks
npm run test:native:desktop:extended
npm run test:native:android:extended
```

Testing architecture docs:

- `testing/README.md`
- `testing/native/README.md`


### Local plugin release

```bash
npm run release:plugin                  # auto bump (major/minor/patch from commits)
npm run release:plugin -- --dry-run    # preview next version + notes only
npm run release:plugin -- --bump patch # force a specific bump
```

Release automation now runs fully on your local machine: it validates the plugin, builds the release bundle, commits the version bump, pushes `main` and the tag, and creates a draft GitHub release with `gh`.

The old tag-triggered GitHub Actions release workflow is retired. Treat `npm run release:plugin` as the canonical publish path for this repo.
That release path still builds the desktop Studio support assets the shipped plugin depends on: Pi runtime bundles plus `studio-terminal-sidecar.cjs`.

Windows still needs a human-run host pass, but the shared native runtime smoke runner is documented cross-platform. Treat Windows as an explicit validation lane, not an implicit guess.

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
