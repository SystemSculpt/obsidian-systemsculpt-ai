# Studio graph-v3 module map

This directory owns graph rendering and inline node editing.

## Core seams

- StudioGraphWorkspaceRenderer.ts orchestrates graph mounting and interaction
  wiring.
- StudioGraphNodeCardRenderer.ts, StudioGraphNodeCardSections.ts, and
  StudioGraphNodeCardPreviews.ts compose card structure and previews.
- StudioGraphNodeCardPointer.ts is the single pointer-policy seam for
  interactive controls, dragging, and modifier selection. Do not grow
  one-off closest-selector policies elsewhere.
- StudioMediaNodeActionBar.ts owns the always-visible media-card actions and
  every pointer gesture beginning on them.
- StudioGraphNodeInlineEditors.ts dispatches node-specific editor surfaces.
- StudioGraphInlineConfigPanel.ts owns generic field ordering, visibility, and
  renderers.
- StudioGraphJsonInlineEditor.ts owns structured JSON editing and validation.
- StudioGraphTextInlineEditor.ts owns text and Markdown editing lifecycles.

Keep orchestration modules focused on dispatch and lifecycle. Field behavior
belongs with the editor or model that owns it, and functionality must never be
hidden behind hover-only presentation.
