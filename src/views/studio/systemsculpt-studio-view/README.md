# SystemSculptStudioView Module Map

This directory contains helper modules extracted from `SystemSculptStudioView.ts`.
The goal is to keep the view file as an orchestration surface while moving domain logic
into focused submodules.

## Current seams

- `StudioGraphClipboardModel.ts`
  - Clipboard schema, payload parsing/validation, and history snapshot helpers.
  - Pure model utilities (no direct DOM access, no plugin side effects).

- `StudioVaultReferenceResolver.ts`
  - Obsidian/file URI parsing and vault reference resolution for paste/drop flows.
  - Text payload reference extraction helpers used by paste and drag-drop ingestion.

- `StudioGraphHistoryState.ts`
  - History state-machine operations (reset/capture/undo/redo snapshot transitions).
  - Keeps stack mutation logic out of the view orchestration layer.

- `StudioGraphClipboardPasteMaterializer.ts`
  - Clipboard paste remapping for nodes/edges/groups and next selection calculation.
  - Pure transform used by the view when applying clipboard payloads.

- `StudioClipboardData.ts`
  - Clipboard payload readers for text/image extraction and mime normalization.
  - Keeps browser clipboard parsing details out of the view file.

- `StudioClipboardPasteNodes.ts`
  - Node construction/materialization for text/image paste actions.
  - Produces `StudioNodeInstance` outputs without directly mutating view state.

## Orchestration contract

`SystemSculptStudioView.ts` should own:

- lifecycle wiring (`onOpen`, `onClose`, render scheduling)
- direct UI interaction and state transitions
- coordination across services/modules

Helper modules in this directory should own:

- reusable pure logic
- parsing/normalization
- deterministic data transforms

## Planned next slices

1. Split run-event materialization and managed-output synchronization into runtime modules.
2. Extract note-preview normalization/refresh orchestration from the view into dedicated note runtime helpers.
3. Extract drag/drop ingestion pipeline into focused handlers (`drop refs`, `vault folders`, `unsupported files`).

## Conventions

- Keep files below `450` LOC when possible.
- Prefer one responsibility per module.
- Keep naming responsibility-first (`*Model`, `*Resolver`, `*Controller`, `*Handlers`).
