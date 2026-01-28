# SystemSculpt AI (Obsidian plugin) — Agent Guide

## Multi-Agent Safety (CRITICAL)

Assume multiple agents (and humans) may be working in parallel in this repo. Treat unrelated working-tree changes as someone else's work.

- NEVER run destructive git commands: `git reset`, `git checkout`, `git clean`, `git stash` (including `git pull --rebase --autostash`) unless explicitly asked.
- NEVER mass-stage/commit: `git add .`, `git add -A`, `git commit -a`.
- Only stage files you personally changed: `git add <file>`. Ignore unrelated `git status` changes.

This file is the repo-local “how to work here” guide. It is meant to stay current as the codebase evolves.

## Quick commands

```bash
npm run dev               # esbuild watch; rebuilds main.js + styles.css, syncs to e2e fixture vault
npm run build             # production bundle; writes main.js + styles.css
npm run check:plugin      # tsc --noEmit + bundle resolution
npm run check:plugin:fast # faster local sanity pass
npm test                  # Jest (passWithNoTests)
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

## Architecture (how the plugin works)

### Lifecycle and managers

- `src/main.ts` owns the plugin lifecycle and initialization phases.
- Key managers/services are created during initialization (examples):
  - `ViewManager` (`src/core/plugin/views.ts`) — registers views, restores chat leaves, initializes ribbon icons.
  - `CommandManager` (`src/core/plugin/commands.ts`) — registers most user commands (chat, daily vault, automations, etc.).
  - `SettingsManager` (`src/core/settings/SettingsManager.ts`) — persists plugin settings and exposes `updateSettings(...)`.

### Chat stack (UI → request → stream → render)

Use `docs/chat-request-flow.md` as the detailed map, but the short version is:

1. **Chat UI** (`src/views/chatview/`) collects user input and orchestrates a turn.
2. **Request assembly** happens in the service layer (centralized in `SystemSculptService`).
3. **Transport** is selected by `PlatformContext` (desktop vs mobile and endpoint constraints).
4. **Streaming** responses are normalized and transformed into consistent events.
5. **Rendering/finalization** updates the UI progressively and persists the final message.

### Networking / providers / transport

- **Never bypass transport selection.** Always route outbound HTTP via `PlatformContext`:
  - `src/services/PlatformContext.ts` decides `fetch` vs Obsidian `requestUrl`.
  - `supportsStreaming()` is false on mobile and for endpoints on the avoidlist (defaults empty).
- **Single source of truth for chat requests:**
  - `src/services/SystemSculptService.ts` (not ad‑hoc fetch calls inside views).
- **Error-driven fallbacks:**
  - `src/services/StreamingErrorHandler.ts` sets metadata like `shouldResubmitWithoutTools` / `shouldResubmitWithoutImages`. UI/orchestrator code should honor these hints instead of guessing.

### Streaming pipeline

- Stream normalization and parsing lives under `src/streaming/` (not in UI).
- Keep streaming transformations deterministic and side-effect free (easy to test, easy to reason about).

### Agent Mode (MCP)

- Tool schemas are defined under `src/mcp-tools/**` and must remain the canonical tool surface.
- Treat tool definitions as a public API: tool names are stable, changes require doc updates and (ideally) tests.
- Prefer explicit, auditable tool calls. Keep mutating operations gated behind the existing approval UX.

### Embeddings / Similar Notes

- Orchestrator: `src/services/embeddings/EmbeddingsManager.ts`
- User-facing surface:
  - Similar Notes panel view
  - Commands for rebuild / stats
  - Settings under **Embeddings & Search**
- Design constraint: embeddings work should not block the UI thread; favor incremental/background processing and clear progress state.

### Daily Vault / Automations / Audio

- Daily note workflows live under `src/services/daily/` and are surfaced via settings + commands.
- Automations have their own commands and modals; keep automation definitions centralized (avoid duplicating the same workflow config in multiple places).
- Audio/transcription flows should be cancelable and should surface actionable errors (key/endpoint/model mismatch is the common failure mode).

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

## Self-evolving knowledge (how this file stays “alive”)

When you learn something that will help future work:

1. **If it’s a stable invariant** (should stay true for months), add it under **Learnings**.
2. **If it’s an explicit architectural choice** (and alternatives were considered), add a record under **Decisions**.
3. **If it’s a deep-dive explanation**, write a short doc in `docs/` and link it from here.

Keep entries specific and actionable: include file paths, invariants, and “how to verify”.

### Decisions

- 2026-01-21: Added in-repo end-user docs (`docs/user/*`) and a docs hub (`docs/README.md`). Source-of-truth pages now include commands/ribbons/tools and should be kept in sync with the canonical code files listed above.
- 2025-11-30: Added `docs/prd-on-device-embeddings.md` for the on-device transformers embeddings provider (local model cache, provider switching, mobile support).

### Learnings

- `PlatformContext` avoids direct `fetch` for some hosts (defaults empty); expect `requestUrl` transport and no streaming when suffixes are registered. Verify by checking `PlatformContext.supportsStreaming(...)`.
