# Testing coverage map

Last verified against test files: **2026-02-11**.

This is a practical snapshot of where tests currently exist.

## Legend

- `covered`: direct unit/integration coverage exists.
- `partial`: some coverage exists, but user-facing paths are not fully covered.
- `gap`: no meaningful direct tests found.

## Chat view and streaming

- Streaming controller and stream pipeline: `covered`
  - `src/views/chatview/__tests__/streaming-controller.test.ts`
  - `src/streaming/__tests__/stream-pipeline.test.ts`
- Message rendering/grouping/scroll behavior: `covered`
  - `src/views/chatview/__tests__/message-renderer-*.test.ts`
  - `src/views/chatview/__tests__/message-grouping.test.ts`
  - `src/views/chatview/__tests__/scroll-manager-behavior.test.ts`
- Chat persistence/storage/export: `covered`
  - `src/views/chatview/__tests__/ChatPersistenceManager.test.ts`
  - `src/views/chatview/__tests__/chat-storage-normalization.test.ts`
  - `src/views/chatview/export/__tests__/chat-export-*.test.ts`
- Agent Mode UX and tool-call rendering: `covered`
  - `src/views/chatview/__tests__/tool-call-manager-*.test.ts`
  - `src/views/chatview/__tests__/tool-call-tree-renderer*.test.ts`

## Embeddings and Similar Notes

- Embeddings pipeline/storage/provider switching: `covered`
  - `src/services/__tests__/Embeddings*.test.ts`
  - `src/__tests__/embeddings/EmbeddingsProcessor.batch.test.ts`
- Similar Notes view-specific UI behavior: `partial`
  - Core processing is covered; dedicated view UX assertions are limited.

## Providers, transport, and service layer

- SystemSculpt/custom provider service paths: `covered`
  - `src/services/__tests__/SystemSculptProvider*.test.ts`
  - `src/services/__tests__/SystemSculptService*.test.ts`
  - `src/services/__tests__/CustomProvider*.test.ts`
- Platform transport behavior: `covered`
  - `src/services/__tests__/PlatformContext.test.ts`

## Settings and plugin infrastructure

- Settings helpers/search and selected tabs: `covered`
  - `src/settings/__tests__/SettingsSearchIndex.test.ts`
  - `src/settings/__tests__/uiHelpers.test.ts`
  - `src/__tests__/settings-*.test.ts`
- Ribbons and plugin registration behavior: `covered`
  - `src/core/plugin/__tests__/ribbons.test.ts`

## Daily, Readwise, recorder, and transcription

- Daily services: `covered`
  - `src/services/daily/__tests__/Daily*.test.ts`
- Readwise service: `covered`
  - `src/services/readwise/__tests__/ReadwiseService.test.ts`
- Recorder/transcription services: `covered`
  - `src/services/__tests__/RecorderService.test.ts`
  - `src/services/__tests__/TranscriptionService*.test.ts`

## E2E coverage

- Live chat and tooling flows: `covered`
  - `testing/e2e/specs-live/chat.core.live.e2e.ts`
  - `testing/e2e/specs-live/chat.streaming-approval-ux.live.e2e.ts`
- Live embeddings and quick edit: `covered`
  - `testing/e2e/specs-live/embeddings.*.live.e2e.ts`
  - `testing/e2e/specs-live/quickedit.core.live.e2e.ts`
- Mock deterministic flows: `covered`
  - `testing/e2e/specs-mock/*.mock.e2e.ts`
- Mobile recorder emulation: `covered`
  - `testing/e2e/specs/recorder.mobile.e2e.ts`

## Notable likely gaps

- Search modal UI behavior (engine is tested; modal UX coverage is limited).
- Some settings tabs with complex UI interactions (backup/restore, advanced diagnostics, full data-tab UI).
- Janitor modal and selected maintenance utilities.
