# SystemSculpt AI — On-Device Embeddings PRD
_Draft • 2025-11-30_

## 1) Problem & Why Now
- Today we only ship two embeddings paths: **SystemSculpt API** (license required, cloud) and **Custom provider** (OpenAI-compatible HTTP, incl. Ollama/LM Studio). Users who want private/offline embeddings must install and run a local server. Mobile users cannot realistically run those servers, so embeddings are effectively cloud-only on phones/tablets.
- Smart Connections proves a zero-setup pattern: ship a built-in transformers.js pipeline that downloads a small model on first run and runs entirely in-process (desktop + mobile). We want the same frictionless “enable embeddings → it just works” flow, while keeping the ability to switch back to SystemSculpt or custom endpoints.

## 2) Goals
- **G1: Zero-setup local provider** that works without Ollama/LM Studio and requires no API key.
- **G2: Private & offline**: all text stays on-device; model weights cached locally after first download.
- **G3: Multi-platform**: desktop (macOS/Windows/Linux) and mobile (iOS/Android) with graceful fallbacks when WebGPU/SIMD are unavailable.
- **G4: Drop-in provider**: selectable alongside existing `systemsculpt` and `custom` providers; switching triggers proper re-embedding + namespace isolation.
- **G5: UX clarity**: clear download/progress states, backend selection (WebGPU → WASM-SIMD → WASM baseline), and recovery messages when unsupported.
- **G6: Minimal bloat**: reuse current EmbeddingsManager/Processor/Storage; avoid duplicative pipelines.

## 3) Non-Goals
- No new chat/RAG UI changes beyond provider selection and status surfacing.
- No server-side fallback for mobile; if the device cannot run WASM baseline we show actionable errors.
- No secondary “legacy” local pipeline; one transformers-based path only (remove or block any temp shims after rollout).

## 4) Users & Scenarios
- Privacy-first desktop users who don’t want an always-on local server.
- Mobile users who want semantic search while offline.
- Regulated environments where external calls are blocked; local-only must still function.

## 5) Current Architecture (relevant pieces)
- **EmbeddingsManager** (`src/services/embeddings/EmbeddingsManager.ts`): orchestrates provider, EmbeddingsProcessor, EmbeddingsStorage, ContentPreprocessor; two providers today (`systemsculpt`, `custom`).
- **EmbeddingsProvider interface** (`src/services/embeddings/types.ts`): `generateEmbeddings`, `validateConfiguration`, optional `getModels`, `getMaxBatchSize`, `expectedDimension`.
- **Processing** (`EmbeddingsProcessor`): batching, concurrency, namespace/dimension validation, re-use of unchanged chunks.
- **Storage** (`EmbeddingsStorage`): IndexedDB store `SystemSculptEmbeddings`, namespaces via `buildNamespace(provider:model:dim:vX)`.
- **Settings UI** (`src/settings/EmbeddingsTabContent.ts`): dropdown with `SystemSculpt (Default)` and `Custom provider`; custom section handles endpoint/model/API key and local server scan.
- **Constants** (`src/constants/embeddings.ts`): defaults (`DEFAULT_EMBEDDING_MODEL`, `DEFAULT_EMBEDDING_DIMENSION` = 1536), supported model list, schema version.
- **Scanning** (`LocalEmbeddingsScanner.ts`): detects Ollama/LM Studio endpoints on localhost.

## 6) Proposed Solution — Built-in On-Device Provider

### 6.1 Provider & Model
- New provider id: `local-transformers`.
- Implementation: **LocalTransformersProvider** using `@xenova/transformers` feature-extraction pipeline.
- Default model (EN‑first, fast, small download): `TaylorAI/bge-micro-v2` (384-dim, ~30–40 MB). Matches Smart Connections’ zero-setup behavior and is mobile-friendly.
- Optional models in the picker:
  - `BAAI/bge-small-en-v1.5` (384-dim, better quality, still light).
  - `intfloat/multilingual-e5-small` (384-dim, multilingual; slower and ~3–4× larger download). Marked “Multilingual (slower)” in UI.
- Namespace format: `local-transformers:<model-id>:<dim>:v3` (bump schema if needed).

### 6.2 Asset Management & Caching
- New **LocalModelCache** helper (desktop & mobile safe):
  - Download weights via fetch/requestUrl; store under vault `.systemsculpt/cache/models/<model-id>/` (or plugin data dir on mobile).
  - Track `manifest.json` with model id, revision hash, size, backend (gpu/wasm), last-used.
  - Provide `ensureModelReady(modelId)` that handles: manifest check → download if missing → integrity verify → return local file URLs for transformers.
  - Delete/clear action in settings (“Remove downloaded model”).
- Use transformers.js offline mode with `env.allowLocalModels = true` and `env.localModelPath` pointing to cached folder; disable remote fetch once cached unless user triggers “Re-download”.

### 6.3 Backend Selection & Fallbacks
- Detect capabilities at runtime:
  1) WebGPU available → use `device=webgpu`.
  2) Else WASM + SIMD.
  3) Else WASM baseline; if missing SIMD baseline unavailable, surface actionable error (“Your device/browser lacks WebAssembly SIMD; local embeddings unavailable. Use SystemSculpt or Custom provider.”).
- Provide small CPU-friendly batch size (default 8) and throttle concurrency to 1 for `local-transformers` to keep UI responsive; keep existing higher limits for remote providers.

### 6.4 Integration Points
- **EmbeddingsManager#createProvider**: add branch for `local-transformers` constructing LocalTransformersProvider with selected model + LocalModelCache; set `expectedDimension` from model metadata.
- **Config & settings types** (`SystemSculptSettings`, `EmbeddingsProviderConfig`): extend provider union to include `local-transformers`; add `localEmbeddingModel`, `localModelBackendPreference` (“auto | webgpu | wasm”), `localModelStatus` (downloaded/needed/error).
- **Settings UI**:
  - Provider dropdown: `SystemSculpt (cloud)`, `Custom API`, `On-device (local)`.
  - When local is selected: show model picker (default `bge-micro-v2`; options `bge-small-en-v1.5`, `multilingual-e5-small` with size/latency note), download button/progress bar, backend preference toggle, “Remove downloaded model”.
  - When provider switches to/from local, trigger `EmbeddingsManager.queueReprocessForPaths` to refresh namespace/dimension.
- **Processing**: use provider `getMaxBatchSize` and `expectedDimension`; cap concurrency to 1 when provider id is `local-transformers` (config override).
- **Storage/namespace**: no schema change required if we encode provider/model/dim in namespace; ensure `detectNamespaceMismatches` treats `local-transformers` correctly.

### 6.5 Mobile Support
- Reuse same provider; rely on WASM baseline. Users already explicitly enable embeddings, so no extra gate required; surface a short “downloads ~30–120 MB, may be slower on mobile” note when selecting local provider or multilingual model.
- Avoid Node-only APIs; use Obsidian’s `app.vault.adapter` for file writes.
- Progress messaging tuned for longer first-run downloads on cellular; allow “stop download” to delete partial files.

### 6.6 Error Handling & Telemetry
- Standardized errors: “model download failed”, “backend unsupported”, “model load failed”, “OOM during batch”.
- Surface errors through existing `embeddings:error` events for UI to show Notices and status bar.
- Log backend selection + model id once per session (no content).

### 6.7 Performance & UX Guardrails
- Default batch size 8, concurrency 1, rate-limit reuse existing manager settings.
- Query embedding cache still applies; vectors stored in IndexedDB as today.
- For large vaults, allow “process in background” with pause/resume; reuse current cooldown handling.

### 6.8 Removal / Cleanup
- Remove any legacy “legacy transformers” shims if introduced during development; only keep LocalTransformersProvider as the sole on-device path.
- Ensure `LocalEmbeddingsScanner` remains focused on servers; no duplicate code there.

## 7) Work Breakdown (phased)
1) **Provider foundation**: add LocalTransformersProvider + LocalModelCache; wire into EmbeddingsManager/config; hard-code `bge-micro-v2`; CLI/unit tests with mocked transformers pipeline.
2) **Settings UI & flows**: add provider option, model picker, download/clear controls, backend preference; wire status bar/state; ensure provider switch triggers re-embed scheduling.
3) **Mobile & download robustness**: implement adapter-safe file writes, resume/clear, SIMD/WebGPU detection and messaging.
4) **Polish & cleanup**: telemetry/logging, Notices, documentation; remove any temporary fallbacks; update AGENTS.md memory.

## 8) Testing Plan (TDD-first)
- Unit tests: provider returns vectors of expected length; batch splitting respects maxBatch; errors propagated; namespace computed correctly.
- Integration (Jest with mocked transformers): processVault schedules re-embed when provider/model changes; download failure surfaces user-facing error.
- Performance sanity: measure embedding time on representative note set with batch=8 vs remote provider (desktop); ensure no UI lock (mocked timers).
- Mobile smoke (manual): first-run download, embeddings succeed on iOS/Android emulator with WASM baseline.

## 9) Risks & Mitigations
- **Backend unsupported (SIMD/WebGPU missing)**: preflight check + clear error, guide to SystemSculpt/custom.
- **Bundle size**: avoid bundling model weights; rely on runtime download + cache; ensure esbuild keeps `.wasm` loader and marks `@xenova/transformers` as dependency (no duplicate copies).
- **Performance on large vaults**: enforce low concurrency for local; allow pause/resume via existing processing controls.
- **Dimension mismatch**: switching providers triggers namespace-based re-embedding; warn in UI before switch.
- **Storage limits on mobile**: show model size estimate; allow delete; store under plugin cache path.

## 10) Decisions (open items resolved)
- Default stays `bge-micro-v2` (EN-first, smallest, fastest).
- Multilingual offered as optional `multilingual-e5-small` with clear size/latency warning.
- Do **not** pre-bundle tokenizer/weights; rely on runtime download + cache to keep the plugin bundle small and Obsidian Sync-friendly.
- No extra mobile gate beyond the existing “Enable embeddings”; just warn about download size/battery when picking local or multilingual models.
