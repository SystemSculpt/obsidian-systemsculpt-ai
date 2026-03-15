## What's New in 5.2.0

### ✨ New Features

- **Web Search** — New globe toggle in the chat composer enables live web search powered by OpenRouter. When active, the model receives real-time search context and cites sources inline with clickable links.
- **Collapsible Sources panel** — Responses containing web citations now show a collapsible "Sources" section (collapsed by default, same pattern as Reasoning) listing each referenced URL with its full link.
- **External link handling** — All external links in assistant messages now reliably open in the default browser with proper click handling, dotted-underline styling, and visual distinction.

### 🐛 Bug Fixes

- **Legacy chat compatibility** — Older chats with tool calls or custom system prompts are now correctly detected and routed through the legacy backend, fixing potential rendering and continuation issues for pre-v5 conversations.
- **Production API pinning** — Production builds now always resolve to the canonical SystemSculpt API, preventing misconfigured or stale `serverUrl` settings from routing traffic to unintended endpoints.

### 🔧 Improvements

- **Codebase cleanup** — Removed ~7,700 lines of unused code: benchmark views, legacy model selection modal, SearchService, SystemPromptService, PromptBuilder, FavoritesFilter, and associated tests. Reduces bundle size and maintenance surface.
- **Settings hygiene** — Legacy settings fields (`selectedProvider`, `selectedModelProviders`, `systemPromptType`, `systemPromptPath`, `benchmarksDirectory`) are now scrubbed on load and save, preventing stale data from accumulating.
- **Build tooling** — Retired fixture-vault auto-sync from dev builds; archived stale engineering docs; added internal Symphony workflow scaffolding.
