# Testing Coverage Map (2025-12-18)

Legend:
- covered: unit/integration tests or E2E coverage for the primary behavior
- partial: some tests exist, but key UX paths/edge cases are missing
- gap: no meaningful tests yet

## Chat View + Agent Mode
- Streaming pipeline + turn orchestration: covered (`src/views/chatview/__tests__/streaming-controller.test.ts`, `src/streaming/__tests__/stream-pipeline.test.ts`, `src/views/chatview/__tests__/chat-turn-orchestrator.test.ts`)
- Basic completion (no tools): covered (`testing/e2e/specs-live/chat.core.live.e2e.ts`)
- Tool call lifecycle + approvals UI: covered (`src/views/chatview/__tests__/tool-call-manager-tooling.test.ts`, `src/views/chatview/__tests__/tool-call-manager-auto-approve.test.ts`, `src/views/chatview/__tests__/tool-call-tree-renderer*.test.ts`, `src/views/chatview/ui/__tests__/approval-panel.test.ts`, `testing/e2e/specs-live/chat.core.live.e2e.ts`)
- Message rendering + grouping + scroll behavior: covered (`src/views/chatview/__tests__/message-renderer-*.test.ts`, `src/views/chatview/__tests__/message-grouping.test.ts`, `src/views/chatview/__tests__/scroll-manager-behavior.test.ts`)
- Chat persistence + storage normalization: covered (`src/views/chatview/__tests__/ChatPersistenceManager.test.ts`, `src/views/chatview/__tests__/chat-storage-normalization.test.ts`)
- Chat export builder: covered (`src/views/chatview/export/__tests__/chat-export-builder.test.ts`)
- Chat favorites (service + toggle UI): covered (`src/views/chatview/__tests__/chat-favorites-service.test.ts`, `src/views/chatview/__tests__/chat-favorite-toggle.test.ts`)
- Chat history/resume UX (open history file, resume flow): partial (unit tests only)
- Chat history helpers (open/save notes, resume service): covered (`src/views/chatview/handlers/__tests__/notes-handlers.test.ts`, `src/views/chatview/__tests__/resume-chat-service.test.ts`)
- Context files (add/remove/validate, processing badges): covered (`src/views/chatview/__tests__/file-context-manager.test.ts`, `testing/e2e/specs-live/chat.core.live.e2e.ts`)
- Input handlers (Enter/Escape, slash/agent/@ menus): covered (`src/views/chatview/handlers/__tests__/ui-key-handlers.test.ts`)
- Slash command menu (history/save/agent/new): partial (unit tests + `testing/e2e/specs-live/chat.core.live.e2e.ts` for export)
- Large paste + file attachments handler: partial (unit tests only)
- Agent selection + system prompt selection UX: partial (unit tests only)
- Model selection + favorites in ChatView: partial (unit tests only)
- Web search button integration: covered (`src/views/chatview/ui/__tests__/create-chat-composer.test.ts`, `testing/e2e/specs-live/chat.core.live.e2e.ts`)
- Drag/drop context intake: covered (`src/views/chatview/__tests__/event-handling.test.ts`, `testing/e2e/specs-live/chat.core.live.e2e.ts`)
- @-mention context add: covered (`testing/e2e/specs-live/chat.core.live.e2e.ts`)
- Chat export service: covered (`src/views/chatview/export/__tests__/chat-export-service.test.ts`, `testing/e2e/specs-live/chat.core.live.e2e.ts`)

## Embeddings + Similar Notes
- Core embeddings pipeline (preprocess/batch/store/monitor/migrations): covered (`src/services/__tests__/Embeddings*.test.ts`, `src/__tests__/embeddings/EmbeddingsProcessor.batch.test.ts`)
- Provider switching + model drift + legacy migration: partial (unit tests only)
- Vault file ops + exclusions: partial (`src/services/__tests__/EmbeddingsManager.exclusions.test.ts`)
- SystemSculpt embeddings core: covered (`testing/e2e/specs-live/embeddings.systemsculpt.core.live.e2e.ts`)
- Custom embeddings core: covered (`testing/e2e/specs-live/embeddings.custom.core.live.e2e.ts`)
- Status bar + Similar Notes view UX: gap (no unit/E2E coverage)
- Chat-to-search integrations (drag similar notes into chat, context add): gap

## Providers + Models
- SystemSculpt provider behavior (gateway/html/sanitization): covered (`src/services/__tests__/SystemSculptProvider*.test.ts`)
- Adapter unit tests (MiniMax, Moonshot): covered (`src/services/providers/adapters/__tests__/*.test.ts`)
- Unified model management: covered (`src/__tests__/model-management-service.test.ts`)
- Custom provider service + OpenAI/Anthropic adapters (end-to-end): gap

## Search
- SystemSculptSearchEngine unit test: covered (`src/services/search/__tests__/SystemSculptSearchEngine.test.ts`)
- Search modal + UI wiring: gap

## Quick Edit
- Core logic + widget: covered (`src/quick-edit/__tests__/*.test.ts`, `src/components/__tests__/QuickEditWidget.test.ts`)
- E2E flows in live Obsidian: gap

## Audio + Transcription + Document Processing
- Recorder widget: covered (`src/components/__tests__/RecorderWidget.test.ts`)
- Mobile recorder E2E: covered (`testing/e2e/specs/recorder.mobile.e2e.ts`)
- Full audio pipeline (record -> upload -> transcription -> post-process): gap
- Document processing (PDF/Office -> markdown): gap (only `src/__tests__/documentProcessingService-status.test.ts` covers status logic)
- Meeting processor + post-processing modals: gap

## Daily Vault Automations
- Daily note service: partial (`src/services/__tests__/DailyNoteService.test.ts`)
- Workflow/analytics/review + status bar: gap

## Templates + Titles
- Template manager + selection modal: gap
- Title generation (service): covered (`src/services/__tests__/TitleGenerationService.test.ts`)
- Title generation UX (commands, modals, note rename flows): gap

## Settings + Configuration
- Settings tabs (setup/chat/system prompt/UI helpers): covered (`src/__tests__/settings-*.test.ts`)
- Embeddings/audio/backup/advanced tabs: gap

## MCP Tools + Context Menu
- Filesystem tool definitions + diff utils: covered (`src/mcp-tools/filesystem/__tests__/*.test.ts`)
- Context menu wiring: covered (`src/__tests__/systemsculpt-context-menu.test.ts`)
- MCP tool execution E2E: partial (tool calls tested via chat agent specs, but no direct tool-by-tool UI coverage)

## Core Infra + Diagnostics
- Platform context: covered (`src/__tests__/platform-context.test.ts`, `src/__tests__/mobile-detection.test.ts`, `src/__tests__/message-toolbar-platform.test.ts`)
- Initialization tracer: covered (`src/core/diagnostics/__tests__/InitializationTracer.test.ts`)
- Token counting + queues + HTTP utils: covered (`src/utils/__tests__/*.test.ts`)
- License/updates/storage/backup/resource monitoring: gap

## E2E Environment
- Live E2E runs source real keys from vault settings (`testing/e2e/run.sh`, `testing/e2e/README.md`).
- Parallel live runs are enabled via `testing/e2e/wdio.live.conf.mjs` (default `maxInstances: 3`, override with `SYSTEMSCULPT_E2E_INSTANCES`).
