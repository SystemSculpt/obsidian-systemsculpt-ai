# Studio Graph V3 Module Map

This folder contains graph-v3 rendering and inline editing modules used by Studio node cards.

## Core seams

- `StudioGraphWorkspaceRenderer.ts`
  - Orchestrates graph rendering, card mounting, and interaction wiring.

- `StudioGraphNodeCardRenderer.ts` + `StudioGraphNodeCardSections.ts` + `StudioGraphNodeCardPreviews.ts`
  - Card structure and preview composition.

- `StudioGraphNodeInlineEditors.ts`
  - Inline editor orchestration for node-specific editor surfaces (JSON editor, text editor, routing).

- `StudioGraphInlineConfigPanel.ts`
  - Generic config panel pipeline: field ordering, visibility, and concrete field renderers.

## Next slices

1. Split JSON editor internals from `StudioGraphNodeInlineEditors.ts` into a dedicated `StudioGraphJsonInlineEditor.ts`.
2. Split text editor display-mode + markdown-preview orchestration into `StudioGraphTextInlineEditor.ts`.
3. Keep orchestration files focused on dispatch and lifecycle, not field-level rendering details.
