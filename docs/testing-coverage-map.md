# Testing coverage map

Last verified against code, tests, and device workflow docs: **2026-03-10**.

## Canonical contract

The migration target is now explicit:

- `SystemSculpt` is the only chat path.
- desktop, iPad, and Android use the same SystemSculpt path.
- chat choice UI should disappear because there is nothing to choose.
- agent-mode on/off should disappear because there is no parallel execution path to toggle.
- Pi runtime and Studio terminal assets should stop being release requirements.

The test plan must protect that simplification, not preserve the old multi-path architecture.

## Current verified unit and service coverage

- Single SystemSculpt chat catalog: `covered`
  - `src/__tests__/model-management-service.test.ts`
  - `src/services/pi-native/__tests__/PiTextCatalog.test.ts`
  - These now verify that the plugin resolves to one canonical `SystemSculpt` chat identity and that legacy model ids collapse back onto it.
- SystemSculpt chat request and streaming facade: `covered`
  - `src/services/__tests__/SystemSculptService.test.ts`
  - These now verify `/chat/completions` request previews and SystemSculpt streaming instead of local Pi execution.
- Stream parsing and rendering pipeline: `covered`
  - `src/streaming/__tests__/stream-pipeline.test.ts`
  - `src/views/chatview/__tests__/streaming-controller.test.ts`
  - `src/views/chatview/__tests__/message-renderer-*.test.ts`
  - `src/views/chatview/__tests__/message-grouping.test.ts`
  - `src/views/chatview/__tests__/scroll-manager-behavior.test.ts`
- Chat persistence and export: `covered`
  - `src/views/chatview/__tests__/ChatPersistenceManager.test.ts`
  - `src/views/chatview/__tests__/chat-storage-normalization.test.ts`
  - `src/views/chatview/export/__tests__/chat-export-*.test.ts`
- Settings and resume-contract cleanup: `covered`
  - `src/__tests__/settings-chat-tab.test.ts`
  - `src/__tests__/settings-backup-tab.test.ts`
  - `src/__tests__/settings-embeddings-tab.test.ts`
  - `src/__tests__/settings-recorder-tab.test.ts`
  - `src/__tests__/settings-tab-registry.test.ts`
  - `src/__tests__/systemsculpt-settings-tab.test.ts`
  - `src/modals/__tests__/AutomationBacklogModal.test.ts`
  - `src/modals/__tests__/PostProcessingModelPromptModal.test.ts`
  - `src/views/chatview/storage/__tests__/ChatPersistenceTypes.test.ts`
  - `src/views/chatview/__tests__/ChatResumeUtils.test.ts`
  - `src/views/chatview/__tests__/ChatStorageService.test.ts`
  - `src/views/chatview/__tests__/resume-chat-service.test.ts`
  - `src/views/history/__tests__/chatHistoryProvider.test.ts`
  - These now verify that the public settings and modal surface stays on one SystemSculpt path, that stale model/prompt chooser UI plus Daily/Template settings are gone, and that resume/open/history flows no longer depend on per-file model overrides, backend labels, or Pi session payloads.
- Embeddings core pipeline: `covered`
  - `src/services/__tests__/Embeddings*.test.ts`
  - `src/__tests__/embeddings/EmbeddingsProcessor.batch.test.ts`
- Similar Notes UX: `partial`
  - core indexing and search behavior is covered
  - dedicated user-facing Similar Notes assertions are still thinner than the chat path
- Platform transport behavior: `covered`
  - `src/services/__tests__/PlatformContext.test.ts`
  - this remains important because mobile still depends on the right `fetch` vs `requestUrl` choice

## Canonical TDD lanes for the simplification

### 1. Unit and service tests

These are blocking tests for every simplification step:

- one chat identity only
  - `getModels()` returns a single canonical `SystemSculpt` chat identity
  - stale saved model ids normalize back to that identity
- one SystemSculpt chat path only
  - request preview builds `/chat/completions` payloads
  - streaming uses SystemSculpt API responses, not local Pi execution
- settings simplification
  - no public provider selection state remains
  - no public model selection state remains beyond the canonical SystemSculpt chat id
  - no agent-mode toggle remains
- release simplification
  - release verification fails if Pi runtime assets or terminal sidecar assets are still required

### 2. Desktop integration and live app tests

- native Obsidian desktop smoke
  - plugin loads
  - license validates
  - chat sends and receives one SystemSculpt reply
  - embeddings generation works through `SystemSculpt`
  - Similar Notes renders at least one result from indexed content
- desktop E2E specs
  - `testing/e2e/specs-live/chat.core.live.e2e.ts`
  - `testing/e2e/specs-live/embeddings.systemsculpt.core.live.e2e.ts`
  - these should become the canonical live specs, not legacy variant specs

### 3. Mobile emulation tests

- `npm run e2e:emu`
  - keep as the fast regression lane
  - expand beyond recorder coverage to SystemSculpt chat and embeddings smoke cases

### 4. Real iPad tests

- direct vault sync into the real iPad vault
- `devicectl` relaunch
- plugin enabled and loaded
- SystemSculpt chat request succeeds
- embeddings generation succeeds
- Similar Notes shows indexed results

The iOS toggle truth remains the rendered `.checkbox-container.is-enabled` state, not the raw checkbox input.

### 5. Real Android tests

- Android Studio emulator for fast iteration
- one real Android device before release confidence
- `adb` relaunch / log checks
- Chrome DevTools WebView inspection
- same SystemSculpt chat + embeddings smoke cases as iPad

## Release verification gates

These are the release-specific tests the simplification must satisfy:

- plugin build succeeds without Pi runtime packaging
- plugin build succeeds without terminal sidecar packaging
- `check:plugin:fast` passes
- sync and E2E helpers do not require `studio-terminal-sidecar.cjs`
- sync and E2E helpers do not require Pi runtime `node_modules` payloads
- release script does not run `build:pi-runtime`, `verify:pi-runtime`, or `build:terminal-runtime`

## Current gaps to close next

- real iPad SystemSculpt chat is now the highest-priority device proof after the service cut
- direct iPad sync remains reliable from this Mac, but live relaunch/inspection still depends on the iPad staying awake and Obsidian exposing an inspectable target
- Android real-device automation is still a setup gap in this Mac environment until `adb` / Android Studio are installed
- the repo still contains Pi runtime, model-selection, custom-provider, and Studio terminal code that the new tests should eventually drive out of the shipped path
- the current E2E harness still assumes old release assets such as `studio-terminal-sidecar.cjs`
