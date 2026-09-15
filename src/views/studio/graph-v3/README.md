# Studio graph-v3 module map

This directory owns graph rendering and inline node editing.

## Core seams

- StudioGraphWorkspaceRenderer.ts orchestrates graph mounting and interaction
  wiring: the scroll-box canvas, the translated world layer every positioned
  layer lives in, and the viewport gestures.
- StudioGraphWorldExtent.ts is the pure policy for the elastic, cornerless
  canvas: how far the scroll box extends around content and view, and when
  it grows.
- StudioNodeSurface.ts decides the one surface a kind gets (media, text,
  code, form, panel); StudioGraphNodeCardRenderer.ts composes the card from
  that decision, with StudioGraphNodeCardSections.ts and
  StudioGraphNodeCardPreviews.ts providing the pieces. There are no tabs.
- StudioNodeSourceBody.ts owns the source definition surface: the content for
  code kinds, one header toggle away for panel kinds.
- StudioGraphNodeCardPointer.ts is the single pointer-policy seam for
  interactive controls, dragging, and modifier selection. Do not grow
  one-off closest-selector policies elsewhere.
- StudioMediaNodeActionBar.ts owns the always-visible media-card actions and
  every pointer gesture beginning on them.
- ../activity/ owns run-state presentation: the phase vocabulary, the
  projector that derives node, cable, and port phases, the DOM applier that
  patches `data-activity` in place, and the badge every card renders through
  renderNodeStatusRow. Renderers stamp `data-activity`; they never style it.
- StudioGraphNodeInlineEditors.ts dispatches node-specific editor surfaces.
- StudioGraphInlineConfigPanel.ts owns generic field ordering, visibility, and
  renderers.
- StudioGraphJsonInlineEditor.ts owns structured JSON editing and validation.
- StudioGraphTextInlineEditor.ts owns text and Markdown editing lifecycles.

Keep orchestration modules focused on dispatch and lifecycle. Field behavior
belongs with the editor or model that owns it, and functionality must never be
hidden behind hover-only presentation.
