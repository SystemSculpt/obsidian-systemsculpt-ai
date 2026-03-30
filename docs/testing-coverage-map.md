# Testing coverage map

Last verified against code, tests, and device workflow docs: **2026-03-29**.

## Canonical contract

- `SystemSculpt` hosted chat and desktop-only Pi-backed chat are the shipped chat paths.
- Mobile validation stays on the hosted SystemSculpt contract; desktop validation covers both hosted and Pi-backed paths.
- Windows desktop is the canonical clean-install desktop lane, including the “no local Pi installed” baseline; macOS remains the fastest already-open no-focus iteration lane.
- `testing/native/` is the only integration-testing architecture in this repo.
- Release verification targets the standard Obsidian plugin artifact set only: `main.js`, `manifest.json`, and `styles.css`.
- Benchmark surfaces are removed; there is no benchmark runner or benchmark-results release/test lane anymore.

## Current verified unit and service coverage

- Chat request and streaming contract: `covered`
  - `src/services/__tests__/SystemSculptService.test.ts`
  - `src/streaming/__tests__/stream-pipeline.test.ts`
  - `src/views/chatview/__tests__/streaming-controller.test.ts`
- Chat persistence, export, and resume: `covered`
  - `src/views/chatview/__tests__/ChatPersistenceManager.test.ts`
  - `src/views/chatview/__tests__/ChatStorageService.test.ts`
  - `src/views/chatview/__tests__/resume-chat-service.test.ts`
  - `src/views/chatview/export/__tests__/chat-export-*.test.ts`
- Settings-shell cleanup and client-owned preferences: `covered`
  - `src/__tests__/settings-chat-tab.test.ts`
  - `src/__tests__/settings-tab-registry.test.ts`
  - `src/__tests__/systemsculpt-settings-tab.test.ts`
  - `src/core/settings/__tests__/SettingsManager.test.ts`
- Embeddings and Similar Notes foundations: `covered`
  - `src/services/__tests__/Embeddings*.test.ts`
  - `src/__tests__/embeddings/EmbeddingsProcessor.batch.test.ts`
- Platform transport behavior: `covered`
  - `src/services/__tests__/PlatformContext.test.ts`

## Canonical integration lanes

### Native runtime smoke

- `npm run test:native:desktop`
- `npm run test:native:desktop:extended`
- `npm run test:native:desktop:provider-connected`
- `npm run test:native:desktop:stress`
- `npm run test:native:android`
- `npm run test:native:android:extended`
- `npm run test:native:android:stress`
- `npm run test:native:ios`

These are the authoritative live-runtime checks for:

- hosted chat
- fresh-install Windows desktop parity when paired with the Windows device workflow
- provider-auth settings round-trips on desktop, including connect, model refresh, de-auth, and clean Providers guidance regression
- approval-gated filesystem tools
- vault reads and writes
- embeddings / Similar Notes primitives
- transcription and recorder flows
- hosted web fetch
- YouTube transcript retrieval in the extended profile

### Device workflow docs

- Android: `testing/native/device/android/README.md`
- iOS/iPad: `testing/native/device/ios/README.md`
- Windows desktop: `testing/native/device/windows/README.md`

## Release verification gates

The current release contract is:

- `npm run check:plugin`
- `npm test`
- `npm run build`
- `npm run check:release:native`
- `npm run release:plugin -- --dry-run` when validating the full publish path

Releases now ship only the standard Obsidian plugin assets: `main.js`, `manifest.json`, and `styles.css`.

## Current cleanup status

- Retired benchmark commands, views, docs, and storage paths are removed.
- Dev builds no longer auto-sync into `testing/e2e/fixtures`.
- New chat state and saves no longer emit legacy prompt-selection metadata; older chat files remain backward-readable on load.
- CanvasFlow no longer renders a dead-end "Saved Model (Unsupported)" chip; unsupported note-level image models fall back to actionable choices.
- `test:native:*` remains the canonical integration command surface.
- `runtime:smoke:*`, `android:*`, and `ios:*` remain compatibility aliases around the same native harness.

## Current gaps to close next

- Keep the Windows provider-connected release run pinned to a real provider API key so provider-auth parity is deterministic instead of "first available provider".
- iOS remains an honest conditional lane: when no paired device plus WebKit adapter is available on the host, the release matrix skips it rather than pretending it passed.
- `npm run release:plugin -- --dry-run` still requires at least one commit after the current release tag before it can progress past the script's commit-range gate.
