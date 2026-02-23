# SystemSculpt Studio Foundation

This document describes the new hard-switch Studio architecture in the Obsidian plugin.

## Scope
- Studio is desktop-only.
- Studio projects are machine-managed `.systemsculpt` files.
- `studio.text_generation` supports two text sources: `SystemSculpt` (default) and `Local (Pi)`.
- `studio.image_generation` and `studio.transcription` remain SystemSculpt-backed.
- Native Canvas internals are not used for Studio runtime behavior.

## Core Paths
- `src/studio/types.ts`: canonical Studio contracts.
- `src/studio/schema.ts`: strict project/policy parsing and migration.
- `src/studio/paths.ts`: `.systemsculpt` + sibling assets path derivation.
- `src/studio/StudioProjectStore.ts`: project/policy persistence and migration backups.
- `src/studio/StudioAssetStore.ts`: content-addressed blob storage.
- `src/studio/StudioPermissionManager.ts`: capability+scope permission enforcement.
- `src/studio/StudioSandboxRunner.ts`: constrained CLI execution.
- `src/studio/StudioGraphCompiler.ts`: typed DAG compile/validation.
- `src/studio/StudioBuiltInNodes.ts`: v1 core node definitions.
- `src/studio/StudioNodeConfigValidation.ts`: schema-driven node config validation.
- `src/studio/StudioNodeResultCacheStore.ts`: persistent per-node output cache + input fingerprinting.
- `src/studio/StudioRunScope.ts`: reusable run-scope projection for graph/node runs.
- `src/studio/StudioApiExecutionAdapter.ts`: Studio execution adapter (SystemSculpt + Local Pi text routing).
- `src/studio/StudioLocalTextModelCatalog.ts`: dynamic local model catalog resolver for node config UIs.
- `src/studio/StudioRuntime.ts`: run queue, immutable snapshots, events, retention.
- `src/studio/StudioService.ts`: plugin-facing Studio orchestration service.
- `src/views/studio/SystemSculptStudioView.ts`: thin Studio leaf orchestrator.
- `src/views/studio/StudioGraphInteractionEngine.ts`: graph interactions (drag/select/connect/zoom).
- `src/views/studio/StudioGraphGroupController.ts`: live group-container overlay + rename interactions.
- `src/views/studio/graph-v3/StudioGraphWorkspaceRenderer.ts`: full-leaf graph workspace renderer.
- `src/views/studio/graph-v3/StudioGraphNodeCardRenderer.ts`: node card renderer (ports/status/media preview).
- `src/views/studio/StudioSearchableDropdown.ts`: reusable fuzzy-searchable dropdown control for large option sets.
- `src/views/studio/graph-v3/StudioGraphMediaPreview.ts`: media preview inference for node outputs.
- `src/views/studio/graph-v3/StudioGraphMediaPreviewModal.ts`: vault resource resolution + modal preview rendering.
- `src/views/studio/graph-v3/StudioGraphGroupModel.ts`: group model helpers (create/rename/sanitize/remove).
- `src/views/studio/graph-v3/StudioGraphViewStateStore.ts`: graph viewport state normalization/persistence helpers.
- `src/views/studio/StudioNodeInspectorOverlay.ts`: inspector overlay with visibility-aware field rendering.
- `src/views/studio/StudioViewHelpers.ts`: shared Studio view helpers.

## File System Layout
Given `My Project.systemsculpt`, Studio stores sibling assets in:
- `My Project.systemsculpt-assets/project.manifest.json`
- `My Project.systemsculpt-assets/policy/grants.json`
- `My Project.systemsculpt-assets/assets/sha256/**`
- `My Project.systemsculpt-assets/runs/<runId>/snapshot.json`
- `My Project.systemsculpt-assets/runs/<runId>/events.ndjson`
- `My Project.systemsculpt-assets/runs/index.json`
- `My Project.systemsculpt-assets/cache/node-results.json`

## Path Contracts
- Project names are sanitized for path safety while preserving human-readable naming.
- `.systemsculpt` is always normalized as the canonical extension.
- Project create operations never overwrite an existing project path.
- Path collisions auto-suffix with ` (2)`, ` (3)`, etc.

## Runtime Contracts
- One active run per project, queued thereafter.
- Strict typed edges (no implicit coercion).
- Fail-fast on fatal node errors unless node has `continueOnError`.
- Immutable per-run snapshot before execution.
- Node output cache keyed by node config + resolved input fingerprint.
- Scoped node run can force selected-node recompute while reusing valid upstream/downstream cache.
- Retention pruning by per-project max run count.

## Node Editing & Output Contracts
- Node configuration is edited inline on node cards (no click-to-config inspector workflow).
- Nodes should expose only immediately reusable output ports to keep graph wiring unambiguous.
- Metadata/debug details belong in runtime logs or snapshots, not as default output ports.
- `studio.text_generation` exposes only `text` as its output.
- `studio.text_generation` defaults to `SystemSculpt`; switching to `Local (Pi)` reveals a searchable model picker backed by dynamic provider models.
- `studio.json` is a lightweight structured-data preview/pass-through node (`json` in, `json` out).
- `studio.dataset` is config-driven (no input ports), requires a custom query (no presets), always exposes raw `text`, and auto-exposes reusable field outputs from structured adapter results (cached internally with TTL).
- `studio.dataset` resolves data through a user-configurable adapter command + argument list.
- `studio.dataset` authentication is adapter-driven: credentials are resolved in the configured working directory/environment (for example from `.env.local`/`DATABASE_URL`), not stored in node output ports.
- `studio.dataset` inline card includes a read-only latest-result preview so operators can verify fetched data after runs.
- `studio.http_request` is the canonical outbound API/action node for single or batched requests, including keychain/plaintext auth, retries, throttling, and request-body shaping.

## Grouping Contracts
- Grouping is graph-native metadata (`project.graph.groups`) persisted in `.systemsculpt`.
- Group creation is driven from Studio context menu actions on multi-selection.
- Group container bounds are derived live from member node geometry and update during drag.
- Group name defaults to `Group N` and enters inline rename immediately on creation.

## Interaction Contracts
- `.systemsculpt` extension is registered to `SYSTEMSCULPT_STUDIO_VIEW_TYPE`.
- Clicking a `.systemsculpt` file in the file explorer opens that file directly in `SystemSculptStudioView`.
- Studio view is file-native (one project file per leaf state) and behaves like other Obsidian file views (similar to canvas semantics).
- Studio does not use modal-driven project create/open flows.
- Output-port drag supports preview-node quick-create: pause ~500ms while dragging to see a release hint; releasing without a compatible target can create a typed preview node (for example JSON/Text) and auto-connect it.
- Runtime source is guarded against browser dialog APIs (`prompt/confirm/alert`) with an automated test gate.

## Security Contracts
- Capability grants are persisted per project policy.
- Filesystem access is scope-checked.
- HTTP nodes enforce HTTPS + domain allowlist.
- CLI nodes enforce command pattern allowlist and path checks.
- Studio traffic sets `x-systemsculpt-surface: studio` on agent/image requests.

## Known Gaps (Intentionally Deferred)
- Remote telemetry upload pipeline (local diagnostics/storage is implemented).
