# Studio Graph V3 Module Map

This folder contains graph-v3 rendering and inline editing modules used by Studio node cards.

## Core seams

- `StudioGraphWorkspaceRenderer.ts`
  - Orchestrates graph rendering, card mounting, and interaction wiring.

- `StudioGraphNodeCardRenderer.ts` + `StudioGraphNodeCardSections.ts` + `StudioGraphNodeCardPreviews.ts`
  - Card structure and preview composition.

- `StudioGraphNodeCardPointer.ts`
  - Node-card pointer policy: the single source of truth for interactive-vs-drag
    surfaces, plus the card pointerdown binding (drag / modifier-select).
    Composite chrome opts out of dragging with `markStudioNodeCardInteractive`;
    never grow ad-hoc `closest()` selector strings elsewhere.

- `StudioMediaNodeActionBar.ts`
  - Hover action bar for media-only cards (`data-chrome-layout="media"`): one
    flat pill of icon actions (run / edit / copy / replace / delete) pinned
    inside the media's edge. The bar owns every pointer gesture that starts
    on it (pointerdown stops there), and its reveal is opacity-only so it is
    always hit-testable.

- `StudioGraphNodeInlineEditors.ts`
  - Inline editor orchestration for node-specific editor surfaces (routing + non-text/non-JSON editors).

- `StudioGraphInlineConfigPanel.ts`
  - Generic config panel pipeline: field ordering, visibility, and concrete field renderers.

- `StudioGraphJsonInlineEditor.ts`
  - JSON editor rendering pipeline (composer/raw modes, validation, source-state badges, output preview).

- `StudioGraphTextInlineEditor.ts`
  - Text editor lifecycle for text-like nodes (raw/rendered mode, markdown preview orchestration, note preview text shaping).

## Next slices

1. Split output preview helpers (`dataset`, `value`, `http binding summary`) from `StudioGraphNodeInlineEditors.ts` into leaf modules.
2. Break `StudioGraphJsonInlineEditor.ts` into `json-model` and `json-renderer` leaves for smaller ownership units.
3. Keep orchestration files focused on dispatch and lifecycle, not field-level rendering details.
