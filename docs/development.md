# Development, testing, and release

## Build and checks

```bash
npm run dev
npm run build
npm run check:plugin:fast
npm run check:plugin
```

The fast check is deliberately bounded to TypeScript, a production build, CSS,
and tiny policy tests. Pair it with focused tests for the touched module. The
normal plugin check adds bounded script guards but does not hide the full unit
or integration suites. Use compiled integration for bundle/composition
changes; run the full unit and integration suites once at combined checkpoints
or release.

## Local Obsidian loop

Copy `systemsculpt-sync.config.json.example` to the ignored
`systemsculpt-sync.config.json` and list local Obsidian plugin folders under
`pluginTargets`. `./run.sh --headless` watches and copies successful
production artifacts. Use the installed official Obsidian CLI for live reload,
evaluation, error inspection, DOM inspection, and screenshots.

```bash
npm run sync:local
```

## Release verification

```bash
npm run release:plugin
```

`release:plugin` verifies semantic version consistency, builds the production
plugin, and validates exactly `manifest.json`, `main.js`, and `styles.css`.
Publishing still requires the applicable human approval.

## Canonical source files for docs

- Settings tabs: `src/settings/SettingsTabRegistry.ts`
- Commands: `src/core/plugin/commands.ts`, `src/main.ts`
- Ribbon icons: `src/core/plugin/ribbons.ts`
- Filesystem MCP tools: `src/mcp-tools/filesystem/toolDefinitions/*.ts`
- YouTube MCP tool: `src/mcp-tools/youtube/MCPYouTubeServer.ts`
- Web research tools: `src/services/web/registerWebResearchTools.ts`
