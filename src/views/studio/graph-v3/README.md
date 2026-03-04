# Studio Graph V3 Module Map

This folder contains graph-v3 rendering and inline editing modules used by Studio node cards.

## Core seams

- `StudioGraphWorkspaceRenderer.ts`
  - Orchestrates graph rendering, card mounting, and interaction wiring.

- `StudioGraphNodeCardRenderer.ts` + `StudioGraphNodeCardSections.ts` + `StudioGraphNodeCardPreviews.ts`
  - Card structure and preview composition.

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
