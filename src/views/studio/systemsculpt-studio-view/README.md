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

1. Extract graph history state machine and transitions into a dedicated controller module.
2. Extract clipboard paste materialization (node/edge/group remapping) into a model module.
3. Extract drag/drop ingestion pipeline into focused handlers (`text`, `image`, `vault refs`).
4. Split run-event materialization and managed-output synchronization into runtime modules.

## Conventions

- Keep files below `450` LOC when possible.
- Prefer one responsibility per module.
- Keep naming responsibility-first (`*Model`, `*Resolver`, `*Controller`, `*Handlers`).
