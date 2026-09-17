# SystemSculptStudioView Module Map

This directory contains helper modules extracted from `SystemSculptStudioView.ts`.
The goal is to keep the view file as an orchestration surface while moving domain logic
into focused submodules.

## Current seams

- `StudioGraphClipboardModel.ts`
  - Clipboard schema and payload parsing/validation.
  - Pure model utilities (no direct DOM access, no plugin side effects).

- `StudioVaultReferenceResolver.ts`
  - Obsidian/file URI parsing and vault reference resolution for paste/drop flows.
  - Text payload reference extraction helpers used by paste and drag-drop ingestion.

- `../StudioGraphHistory.ts`
  - Owns bounded undo/redo, recovery snapshots, and transient empty-node cancellation.
  - Records each view's local edit transactions and rebases their undo/redo onto
    the current shared project; mutable stacks are private.

- `StudioGraphClipboardPasteMaterializer.ts`
  - Clipboard paste remapping for nodes/edges/groups and next selection calculation.
  - Pure transform used by the view when applying clipboard payloads.

- `StudioClipboardData.ts`
  - Clipboard readers, DataTransfer classification, and media normalization.
  - Keeps browser clipboard/drop parsing details out of controller and view code.

- `StudioClipboardAndDropController.ts`
  - Owns graph clipboard state, system mirroring, paste/drop event lifecycle,
    pointer-derived anchors, and text/media node ingestion.
  - Uses a narrow typed host for graph commits and note-runtime coordination;
    the view only forwards keyboard commands and supplies private state bridges.

- `StudioProjectSessionController.ts`
  - Owns the active project/session, retain and release lifecycle, save flushing,
    live vault synchronization, and path-scoped viewport and node-detail state.
  - Presents one typed project-session interface to the view; the view does not
    retain sessions or duplicate project ownership.
  - Delegates linked-note previews, badges, and vault-reference changes to
    `../StudioVaultNotes.ts`. Note policy is not passed back through view callbacks.

- `StudioClipboardPasteNodes.ts`
  - Node construction/materialization for text/image paste actions.
  - Produces `StudioNodeInstance` outputs without directly mutating view state.

- `StudioPromptBundleUtils.ts`
  - Prompt-bundle coercion, output-lock helpers, text snapshot normalization, and fence formatting.
  - Keeps prompt composition primitives reusable and isolated from view orchestration.

- `../../../studio/StudioProjectLiveSync.ts`
  - Signature hashing, expected-self-write tracking, and external-modify decision resolution.
  - Keeps `.systemsculpt` live-sync policy deterministic and unit-testable outside view orchestration.

- `StudioPromptBundleComposer.ts`
  - Prompt-source resolution and text-generation handoff markdown composition.
  - Keeps bundle source dedupe/formatting logic modular and testable.

- `StudioProjectPathState.ts`
  - Studio project path predicates, folder-rename project-path remapping, and path-scoped state key remapping.
  - Keeps project-path state transforms deterministic and reusable.

- `../../../studio/StudioRunOutputProjectors.ts`
  - Run-output projection helpers for node output/start/cache events (text sync, dataset field sync, managed output materialization transforms).
  - Keeps project graph mutation decisions deterministic and unit-testable outside view orchestration.

## Orchestration contract

`SystemSculptStudioView.ts` should own:

- lifecycle wiring (`onOpen`, `onClose`, render scheduling)
- direct UI interaction and state transitions
- coordination across services/modules

Helper modules in this directory should own:

- cohesive state and lifecycle behind a narrow interface
- reusable parsing, normalization, and deterministic data transforms
- policies that callers should not have to reconstruct from helper calls

## Conventions

- Prefer a cohesive deep controller over splitting one lifecycle across shallow wrappers.
- Prefer one responsibility per module.
- Keep naming responsibility-first (`*Model`, `*Resolver`, `*Controller`, `*Handlers`).
