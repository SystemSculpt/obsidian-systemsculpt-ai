# Development, testing, and release

Build, test, sync, and release reference for this repo. Contributor gates and test-layer guidance live in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Build and checks

```bash
npm run dev               # watch build
npm run build             # production build
npm run check:plugin      # typecheck + bundle resolution
npm run check:plugin:fast # faster local check
npm run check:all         # plugin check + Jest suite
```

If you keep a local-only `systemsculpt-sync.config.json`, the dev watcher auto-syncs every successful rebuild into all configured `pluginTargets` plus any `mirrorTargets`, including remote Windows SSH mirrors declared as `"type": "windows-ssh"`.
`./run.sh --headless` remains the canonical background entrypoint because it enables the same build-integrated sync path and also asks the already-open desktop vault to hot-reload the plugin after local sync succeeds.

## Tests

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

## Local plugin release

```bash
npm run check:release:windows         # require the GitHub Windows E2E check on the current commit
npm run check:release:windows:local   # optional maintained Windows host/dev helper
npm run check:release:native          # required native release matrix
npm run check:release-surfaces -- --version <version> --require-notes
npm run release:plugin                  # auto bump (major/minor/patch from commits)
npm run release:plugin -- --dry-run    # preview next version + notes only
npm run release:plugin -- --bump patch # force a specific bump
```

Release automation runs fully on your local machine: it validates the plugin, builds the release bundle, commits the version bump, pushes `main` and the tag, and creates a draft GitHub release with `gh`.
Before it tags anything, the release script runs a safety preflight that blocks tracked local-only files, unignored local-only files that should probably go into `.gitignore`, hardcoded local paths, hardcoded desktop vault selectors, and secret-looking tokens.
If `GITHUB_TOKEN` or `GH_TOKEN` is present but weaker than your stored `gh` login, the release script automatically falls back to the stored auth for push and draft-release steps.
The native release matrix is explicit instead of implicit: macOS desktop baselines, the GitHub Windows E2E check, and Android runtime smoke must all pass before release creation can continue. The Windows E2E check runs a fresh Obsidian install, clean-install parity, and desktop baselines on `windows-latest` for the exact commit being released. iOS runtime smoke is included automatically when a paired physical device is available on the host and is otherwise skipped honestly.
Use `npm run check:release:windows:local` only when you want the optional Windows-only dev helper on a maintained Windows host before waiting on the canonical GitHub check.

The old tag-triggered GitHub Actions release workflow is retired. Treat `npm run release:plugin` as the canonical publish path for this repo.
That release path packages the standard Obsidian plugin artifact set only: `manifest.json`, `main.js`, and `styles.css`.
Before release, `npm run check:release-surfaces -- --version <version> --require-notes` verifies the exact version surfaces and release notes file. After a production build, add `--check-artifacts` to verify the release asset set too.
Desktop validation is bridge-based and no-focus by default; the old renderer-driving desktop lane is retired.
When multiple synced desktop vaults exist, use `--vault-name <vault-name>` or `--vault-path <absolute-path>` to pin one explicitly. Otherwise the desktop runner prefers the latest live bridge target automatically.

## Canonical source files for docs

These files define the user-facing surfaces and are the source of truth:

- Settings tabs: `src/settings/SettingsTabRegistry.ts`
- Commands: `src/core/plugin/commands.ts`, `src/main.ts`
- Ribbon icons: `src/core/plugin/ribbons.ts`
- Filesystem MCP tools: `src/mcp-tools/filesystem/toolDefinitions/*.ts`
- YouTube MCP tool: `src/mcp-tools/youtube/MCPYouTubeServer.ts`
- Web research tools: `src/services/web/registerWebResearchTools.ts`
