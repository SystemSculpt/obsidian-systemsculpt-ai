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
normal plugin check adds bounded script guards but does not hide the full unit,
integration, or egress suites. Use compiled integration for bundle/composition
changes; run the full unit and integration suites once at combined checkpoints
or release.

Network inventory is explicit because it is expensive:

```bash
npm run check:egress
npm run test:egress-analyzer   # analyzer changes only
npm run check:egress:verify    # final/release verification only
```

## Local Obsidian loop

Copy `systemsculpt-sync.config.json.example` to the ignored
`systemsculpt-sync.config.json` and list local Obsidian plugin folders under
`pluginTargets`. `./run.sh --headless` watches, copies successful production
artifacts, and asks an already-running plugin to reload. The reload seam never
launches or focuses Obsidian.

```bash
npm run sync:local
npm run test:reload
node scripts/reload-local-obsidian-plugin.mjs --quiet-unavailable
```

## Release verification

```bash
npm run check:release-surfaces -- --version <version> --require-notes
npm run release:plugin -- --dry-run
```

Before creating release artifacts, `release:plugin` runs fast checks, the full
unit and embeddings suites, a production build, compiled integration, egress
verification, and release-surface validation. Releases contain only
`manifest.json`, `main.js`, and `styles.css`. Publishing still requires the
applicable human approval.

## Canonical source files for docs

- Settings tabs: `src/settings/SettingsTabRegistry.ts`
- Commands: `src/core/plugin/commands.ts`, `src/main.ts`
- Ribbon icons: `src/core/plugin/ribbons.ts`
- Filesystem MCP tools: `src/mcp-tools/filesystem/toolDefinitions/*.ts`
- YouTube MCP tool: `src/mcp-tools/youtube/MCPYouTubeServer.ts`
- Web research tools: `src/services/web/registerWebResearchTools.ts`
