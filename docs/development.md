# Development, testing, and release

## Build and checks

```bash
npm run dev
npm run build
npm run check
npm run check:plugin
npm run check:full
```

The default check is deliberately bounded to TypeScript, a production build,
CSS, and tiny policy tests. Pair it with focused tests for the touched module.
`check:plugin` adds bounded release/script guards without changing the normal
edit loop. `check:full` is the explicit exhaustive path: Obsidian source and
metadata lint, artifact guards, full unit and embeddings suites, compiled
integration, and release-script verification.

`npm run build` accepts `SYSTEMSCULPT_API_BASE_URL` and
`SYSTEMSCULPT_WEBSITE_API_BASE_URL` as build-time local-QA overrides. The URLs
are compiled into `main.js`; they are never read from plugin settings or the
Obsidian runtime. When only the first variable points at a loopback `/api/v1`,
the website API safely follows the same origin at `/api/plugin`.

```bash
SYSTEMSCULPT_API_BASE_URL=http://127.0.0.1:3001/api/v1 npm run build
```

Set `SYSTEMSCULPT_WEBSITE_API_BASE_URL` separately only when the website API is
served from a different local origin.

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

`release:plugin` verifies semantic version consistency, forces
`https://api.systemsculpt.com/api/v1` and
`https://systemsculpt.com/api/plugin` even when the shell contains local QA
overrides, builds the plugin, and validates exactly `manifest.json`, `main.js`,
and `styles.css`. Artifact inspection requires both canonical production APIs,
rejects loopback API bases and retired client AI runtimes/provider SDKs, and
rejects inline source maps. Publishing still requires the applicable human approval.

## Canonical source files for docs

- Settings tabs: `src/settings/SettingsTabRegistry.ts`
- Commands: `src/core/plugin/commands.ts`, `src/main.ts`
- Ribbon icons: `src/core/plugin/ribbons.ts`
- First-party tool service: `src/tools/FirstPartyToolService.ts`
- Vault tools: `src/tools/vault/toolDefinitions.ts`
- YouTube transcript tool: `src/tools/youtube/YouTubeToolModule.ts`
