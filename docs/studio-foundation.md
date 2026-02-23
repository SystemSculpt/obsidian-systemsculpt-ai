# SystemSculpt Studio Foundation

This document describes the new hard-switch Studio architecture in the Obsidian plugin.

## Scope
- Studio is desktop-only.
- Studio projects are machine-managed `.systemsculpt` files.
- Studio uses SystemSculpt API only.
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
- `src/studio/StudioSystemSculptApiAdapter.ts`: API-only adapter.
- `src/studio/StudioRuntime.ts`: run queue, immutable snapshots, events, retention.
- `src/studio/StudioService.ts`: plugin-facing Studio orchestration service.
- `src/views/studio/SystemSculptStudioView.ts`: thin Studio leaf orchestrator.
- `src/views/studio/StudioGraphInteractionEngine.ts`: graph interactions (drag/select/connect/zoom).
- `src/views/studio/StudioGraphEditorRenderer.ts`: graph/node UI rendering layer.
- `src/views/studio/StudioNodeInspectorOverlay.ts`: in-canvas floating node config inspector.
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

## Interaction Contracts
- `.systemsculpt` extension is registered to `SYSTEMSCULPT_STUDIO_VIEW_TYPE`.
- Clicking a `.systemsculpt` file in the file explorer opens that file directly in `SystemSculptStudioView`.
- Studio view is file-native (one project file per leaf state) and behaves like other Obsidian file views (similar to canvas semantics).
- Studio does not use modal-driven project create/open flows.
- Runtime source is guarded against browser dialog APIs (`prompt/confirm/alert`) with an automated test gate.

## Security Contracts
- Capability grants are persisted per project policy.
- Filesystem access is scope-checked.
- HTTP nodes enforce HTTPS + domain allowlist.
- CLI nodes enforce command pattern allowlist and path checks.
- Studio traffic sets `x-systemsculpt-surface: studio` on agent/image requests.

## Known Gaps (Intentionally Deferred)
- Remote telemetry upload pipeline (local diagnostics/storage is implemented).
