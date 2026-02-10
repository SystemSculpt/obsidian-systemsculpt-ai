# SystemSculpt AI (Obsidian plugin) — Agent Guide

## Multi-Agent Safety (CRITICAL)

Assume multiple agents (and humans) may be working in parallel in this repo. Treat unrelated working-tree changes as someone else's work.

- NEVER run destructive git commands: `git reset`, `git checkout`, `git clean`, `git stash` (including `git pull --rebase --autostash`) unless explicitly asked.
- NEVER mass-stage/commit: `git add .`, `git add -A`, `git commit -a`.
- Only stage files you personally changed: `git add <file>`. Ignore unrelated `git status` changes.
- Do not send emails, messages, posts, broadcasts, payments, or any external side-effecting communication without explicit user approval in the current thread. Draft first, then wait for approval before sending.

## SystemSculpt Repo Map (Core 5)

For cross-repo work, read the target repo's local `AGENTS.md` before making changes.

- `systemsculpt-website` — `/Users/user/gits/systemsculpt-website` — Website + app/API surface.
- `systemsculpt-discord-bot` — `/Users/user/gits/systemsculpt-discord-bot` — Discord automation/status bot.
- `system-manager` — `/Users/user/gits/system-manager` — Workspace orchestration TUI.
- `private-vault` — `/Users/user/gits/private-vault` — Operational/private knowledge vault.

This file is the repo-local “how to work here” guide. It is meant to stay current as the codebase evolves.

This repo uses `AGENTS.md` only for agent instructions and durable memory.

## Quick commands

```bash
npm run dev               # esbuild watch; rebuilds main.js + styles.css, syncs to e2e fixture vault
npm run build             # production bundle; writes main.js + styles.css
npm run check:plugin      # tsc --noEmit + bundle resolution
npm run check:plugin:fast # faster local sanity pass
npm run check:e2e         # tsc --noEmit for WDIO e2e harness + specs
npm test                  # Jest (passWithNoTests)
npm run test:debug        # Jest with console output enabled (still spied for assertions)
npm run test:strict       # Jest strict mode: fail on console.* usage
npm run test:embeddings   # Jest embeddings-only suite
npm run test:leaks        # Jest open-handle leak detector (slower; diagnostic)
npm run e2e:mock          # WDIO e2e against mock backend (deterministic; no secrets)
npm run e2e:live          # WDIO e2e against live backend (real license + endpoint)
```

## Repo map (where things live)

- `src/` — all plugin code
  - `src/main.ts` — plugin entrypoint (`SystemSculptPlugin`)
  - `src/core/` — lifecycle, managers, settings/storage plumbing
  - `src/services/` — provider/networking, embeddings, audio, daily vault, etc.
  - `src/views/` — views (ChatView, Embeddings/Similar Notes, Benchmark, etc.)
  - `src/modals/` — Obsidian modals
  - `src/settings/` — settings tab UI content + registry
  - `src/mcp/`, `src/mcp-tools/` — Agent Mode (MCP) tooling and tool definitions
  - `src/utils/` — shared utilities and error/log helpers
- `docs/` — in-repo docs (end-user + developer). Start at `docs/README.md`.
- `scripts/` — check runners, packaging, syncing helpers
- `main.js`, `styles.css` — build outputs (generated; don’t edit directly)

## Product surface: canonical sources of truth

When updating user-facing behavior, update the docs and keep these sources aligned:

- **Settings tabs + labels:** `src/settings/SettingsTabRegistry.ts`
- **Commands (palette):** `src/core/plugin/commands.ts` (+ additional diagnostics commands in `src/main.ts`)
- **Ribbon icons:** `src/core/plugin/ribbons.ts` (registered during `ViewManager.initialize()` in `src/core/plugin/views.ts`)
- **Agent Mode tools (MCP):**
  - Filesystem tools: `src/mcp-tools/filesystem/toolDefinitions/*.ts`
  - YouTube: `src/mcp-tools/youtube/MCPYouTubeServer.ts`
- **Chat request assembly (deep dive):** `docs/chat-request-flow.md`

Docs that should typically be updated when these change:

- `docs/user/settings.md`
- `docs/user/commands.md`
- `docs/user/ribbon-icons.md`
- `docs/user/agent-mode.md`

## PI Framework Canonicality (CRITICAL)

- PI is the canonical runtime for Agent Mode orchestration (continuations, loop guards, policy/approvals when supported).
- Do not re-implement tool approval/continuation/loop-prevention locally if PI already supports it; if glue is unavoidable, keep it minimal and document why + a removal plan in `docs/`.
- When researching/answering tool-call questions, stay PI-canonical by default; only reference non-PI frameworks if the user explicitly asks for cross-framework comparison.

## Architecture (how the plugin works)

Use `docs/chat-request-flow.md` as the deep dive. Key pointers:

- Lifecycle/entrypoint: `src/main.ts`
- Chat UI orchestration: `src/views/chatview/`
- Request building + transport selection: `src/services/SystemSculptService.ts` + `src/services/PlatformContext.ts` (do not bypass)
- Stream parsing/normalization: `src/streaming/` (keep deterministic + side-effect free)
- Agent Mode tool surface (public API): `src/mcp-tools/**`

## Design principles (repo-level invariants)

- **Single path:** don’t add parallel implementations for the same feature. Consolidate.
- **UI responsiveness:** avoid heavy work on hot paths (render loops, file-change handlers, keystrokes). Debounce, paginate, and stream.
- **Centralize cross-cutting concerns:**
  - Transport selection → `PlatformContext`
  - Request building → `SystemSculptService`
  - Errors → `SystemSculptError` + `StreamingErrorHandler` + `utils/errorLogger`
- **Keep module load safe:** avoid side effects at import time; use lazy initialization and explicit `initialize()` calls.
- **Prefer stable IDs:** command IDs, view types, tool names should not churn without strong reason.

## Coding standards

- TypeScript (ES2018 modules), two-space indent, double quotes; prefer `const`/`let` and `async/await`.
- Strict typing is enabled (`noImplicitAny`, `strictNullChecks`); avoid `any` and prefer explicit return types / discriminated unions.
- Keep imports tidy and avoid side effects at module load time.
- Remove dead/legacy code rather than commenting it out.
- CSS: `styles.css` is generated; edit `src/css/**` and wire imports via `src/css/index.css`.

## Docs discipline (keep it self-healing)

- End-user docs live in `docs/user/`; entrypoint is `docs/README.md`.
- When you change a user-visible feature, update:
  1. The canonical source in code (commands/settings/tools/ribbons)
  2. The relevant `docs/user/*.md` page(s)
  3. `README.md` if it’s part of the marketing/first-run path

If a doc becomes long or architecture-heavy, move deep dives into `docs/` (developer docs) and link to it rather than bloating `README.md`.

## Testing guidelines

- Unit/integration tests live in feature-level `__tests__` folders.
- Obsidian APIs are mocked in `src/tests/mocks/obsidian.js`.
- Prefer tests that mock at the HTTP/service boundary (stable, fast, avoids UI brittleness).

## Commit & PR hygiene

- Commit message style: `scope: imperative change` (e.g., `http: add backoff`).
- PRs should state what/why, list commands run (`npm run check:plugin` + targeted Jest), and include screenshots/clips for UI changes.

## Security & configuration

- Never commit API keys. Use local `.env` files for development only.
- `SYSTEMSCULPT_AUTO_SYNC_PATH` should point to a disposable test vault before running `npm run dev`.

## Self-evolving knowledge

When you learn something that will help future work:

1. **If it’s a stable invariant** (should stay true for months), add it to this `AGENTS.md` (prefer linking to a doc over adding a long explanation).
2. **If it’s an explicit architectural choice** (and alternatives were considered), add it under **Decisions** in this file.
3. **If it’s a non-obvious gotcha/debugging note**, add it under **Gotchas** in this file.
4. **If it’s a deep dive**, write it in `docs/` and link it from this file.

Keep entries specific and actionable: include file paths, invariants, and “how to verify”.

## Decisions

- 2026-01-21: Added in-repo end-user docs (`docs/user/*`) and a docs hub (`docs/README.md`). Source-of-truth pages now include commands/ribbons/tools and should be kept in sync with the canonical code files listed above.
- 2025-11-30: Added `docs/prd-on-device-embeddings.md` for the on-device transformers embeddings provider (local model cache, provider switching, mobile support).

## Gotchas

- `PlatformContext` avoids direct `fetch` for some hosts (defaults empty); expect `requestUrl` transport and no streaming when suffixes are registered. Verify by checking `PlatformContext.supportsStreaming(...)`.
- Obsidian v1.11+ Canvas no longer exposes stable node ids on `.canvas-node` DOM elements (`data-node-id`, `data-id`, etc.). If you need to map DOM nodes to Canvas doc nodes, use internal Canvas APIs (see `src/services/canvasflow/CanvasDomAdapter.ts` `findCanvasNodeElementsFromInternalCanvas(...)`).
- Jest runs TS via `@swc/jest` (see `jest.config.cjs`): `jest.mock(...)` calls are hoisted, so mock factories must not reference outer-scope `const`/`let` (use `var` assigned inside the factory, or use `jest.requireMock(...)`). Also avoid `jest.spyOn(...)` for functions imported via named import (they're destructured at import time); prefer module mocks (`jest.mock(...)`) with `jest.fn()` overrides.
- Jest console is spied by default (and silenced) to keep test output clean. Use `npm run test:debug` to print console output (still spied so tests can assert calls), or `npm run test:strict` to fail fast on `console.*` calls.
- Node 25+ can emit a noisy localStorage warning during Jest teardown. All repo Jest scripts run through `scripts/jest.mjs` which preloads `scripts/jest-preload.cjs` to shim webstorage and avoid the warning. (If you run `npx jest` directly on Node 25+, you may still see it.)
- CI uses `npm ci` and depends on a committed `package-lock.json` (don’t ignore lockfiles in `.gitignore`).
- Avoid `Promise.race([... , timeoutPromise])` patterns that leave dangling timers; always `clearTimeout(...)` when the primary promise settles (otherwise Jest workers can hang/force-exit). Examples: `src/services/providers/SystemSculptProviderService.ts`, `src/services/DocumentProcessingService.ts`, `src/services/search/SystemSculptSearchEngine.ts`.
