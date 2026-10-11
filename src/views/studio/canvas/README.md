# Studio canvas module map

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
- image-board/ owns in-place image editing on a media card. There is no
  modal: StudioImageBoardEditor.ts is the lifecycle coordinator the card
  mounts while its node is being edited, composing the session (layer state
  and one undo step per gesture), the stage (pointer gestures, selection
  handles and the in-place caption field), the toolbar (docked to the
  workspace) and the image cache. Painting belongs to
  studio/StudioImageBoardRenderer.ts, the one painter shared by the editor,
  the card preview, the clipboard copy and the node's flattened output.
- ../activity/ owns run-state presentation: the phase vocabulary, the
  projector that derives node, cable, and port phases, the DOM applier that
  patches `data-activity` in place, and the badge every card renders through
  renderNodeStatusRow. Renderers stamp `data-activity`; they never style it.
- StudioGraphNodeInlineEditors.ts dispatches node-specific editor surfaces.
- StudioGraphInlineConfigPanel.ts owns generic field ordering, visibility, and
  renderers.
- StudioNodeSourceBody.ts and StudioSourceEditor.ts own code-card source editing;
  studio/StudioNodeSource.ts validates the definition before Apply.
- StudioGraphTextInlineEditor.ts owns text and Markdown editing lifecycles.
- A text node is laid out one of two ways, chosen by `config.layout`.
  StudioGraphFillTextNodeCard.ts is the card for fill text, which is what
  text made by hand is: the card is a box, the text is set at the size that
  fills it, and typing happens on the card. StudioGraphTextNodeCard.ts is the
  Markdown card every text node without the key remains. Both share the
  resting pointer contract (bindStudioTextNodeDisplayGestures) and the view's
  edit sessions.
- studio/StudioFillText.ts is the one layout for text that fills a box, used
  by the canvas card and by captions in the image editor.
  StudioFillTextSurface.ts applies it to a DOM field or block, and
  StudioFillTextToolbar.ts is the style bar shown while canvas text is typed.

Keep orchestration modules focused on dispatch and lifecycle. Field behavior
belongs with the editor or model that owns it, and functionality must never be
hidden behind hover-only presentation.
