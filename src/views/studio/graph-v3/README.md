# Studio Graph V3 Module Map

This folder contains graph-v3 rendering and inline editing modules used by Studio node cards.

## Core seams

- `StudioGraphWorkspaceRenderer.ts`
  - Orchestrates graph rendering, card mounting, and interaction wiring.

- `StudioGraphNodeCardRenderer.ts` + `StudioGraphNodeCardSections.ts` + `StudioGraphNodeCardPreviews.ts`
  - Card structure and preview composition.

- `StudioGraphNodeInlineEditors.ts`
  - Inline editor orchestration for node-specific editor surfaces (routing + non-JSON editors).

- `StudioGraphInlineConfigPanel.ts`
  - Generic config panel pipeline: field ordering, visibility, and concrete field renderers.

- `StudioGraphJsonInlineEditor.ts`
  - JSON editor rendering pipeline (composer/raw modes, validation, source-state badges, output preview).

## Next slices

1. Split text editor display-mode + markdown-preview orchestration into `StudioGraphTextInlineEditor.ts`.
2. Break `StudioGraphJsonInlineEditor.ts` into `json-model` and `json-renderer` leaves for smaller ownership units.
3. Keep orchestration files focused on dispatch and lifecycle, not field-level rendering details.
