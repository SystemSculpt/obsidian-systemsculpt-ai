# Caption Board plan

Last updated: 2026-03-20.

## Goal

Add a lightweight Ding Board-style meme editor to Studio so a user can:

1. Paste an image into Studio the same way they already do today.
2. Open a focused editor for that image.
3. Add several small text labels directly on top of the image.
4. Drag, resize, edit, duplicate, and delete those labels quickly.
5. Save the rendered meme back into Studio as a reusable asset.

This should feel fast and playful, not like filling out a normal node config form.

## What Ding Board seems to be optimizing for

Based on current public descriptions and interview/search snippets, Ding Board is valued for:

- loading quickly
- being easy to use in-browser
- making memes with very little friction
- using simple image-layer manipulation instead of a heavy design-tool workflow
- letting people move text around freely on top of an image

For this plugin, we do **not** need to clone the whole Ding Board product. We only need the tight core loop:

- image in
- small movable text labels on top
- quick save/export back into Studio

## Why this should be a modal, not an inline Studio card editor

Studio’s current editing model is intentionally inline and form-like for normal node configuration.
That is the right fit for things like source paths, prompts, and settings, but it is the wrong fit for direct-manipulation meme editing.

Current code already gives us the right launch points:

- `src/views/studio/SystemSculptStudioView.ts`
  - pasted images already become `studio.media_ingest` nodes
- `src/studio/nodes/mediaIngestNode.ts`
  - media nodes already represent pasted/stored image assets cleanly
- `src/views/studio/graph-v3/StudioGraphMediaPreviewModal.ts`
  - Studio already has a basic modal pattern for opening media in a focused popup
- `src/studio/StudioAssetStore.ts`
  - rendered meme outputs can be stored as first-class Studio assets
- `docs/studio-foundation.md`
  - Studio node config is supposed to stay lightweight and reusable, which argues against cramming free-position label editing into the normal card UI

So the right shape is:

- keep Studio as the orchestration surface
- open a specialized meme editor modal when needed
- save the result back into Studio assets

## Recommended name

### Recommended public name: **Caption Board**

Why this name:

- it feels close to Ding Board’s vibe without sounding like a copy
- it is descriptive enough that the feature is self-explanatory
- it emphasizes what matters here: captions/labels positioned on a board/image

## Good alternates

- Meme Board
- Punchline Board
- Sticker Board

If we want the clearest and least cute option, use **Caption Board**.
If we want the most direct feature name, use **Meme Board**.

## Recommended product shape

### MVP interaction

1. User pastes an image into Studio.
2. Studio creates a normal Media node, same as today.
3. The Media node gets a new action like **Caption Board** or **Edit Meme**.
4. Clicking it opens a modal with:
   - the image as the background
   - floating text labels on top
   - a simple side panel or top bar for label controls
5. User adds/edits/drags labels.
6. User clicks **Save Draft** and/or **Export Meme**.
7. Export stores a rendered PNG back into Studio assets.
8. Studio can optionally create a new Media node for the finished meme automatically.

### Why this is the best first step

- zero disruption to the existing paste flow
- no need to force meme editing into node-card forms
- the exported result is still just an image, which fits the rest of Studio naturally
- low risk: the feature can ship as a focused add-on instead of a Studio-wide UI rewrite

## Data model recommendation

For the first version, keep the draft attached to the source media node.
That keeps the workflow quick and avoids inventing a whole new graph concept too early.

Suggested draft shape in node config:

- `memeBoard.version`
- `memeBoard.sourceAssetPath`
- `memeBoard.labels[]`
  - `id`
  - `text`
  - `x`
  - `y`
  - `width`
  - `height`
  - `fontSize`
  - `fontWeight`
  - `fontFamily`
  - `color`
  - `strokeColor`
  - `strokeWidth`
  - `backgroundColor`
  - `padding`
  - `textAlign`
  - `rotation`
  - `zIndex`
- `memeBoard.canvas`
  - image display width/height
  - zoom (optional)
- `memeBoard.lastRenderedAssetPath`
- `memeBoard.updatedAt`

Why this works well now:

- pasted images already land in `studio.media_ingest`
- `mediaIngestNode` already allows unknown config keys
- the node can keep its original role as the source image
- the exported meme can be a separate stored asset

## Future-proofing

If the feature becomes central, we can later promote it into a dedicated node kind such as `studio.meme_board`.

That future node would:

- take a media input
- store the same label JSON
- open the same modal editor
- output the rendered meme asset path

That means we should define the modal state schema now in a reusable way, even if MVP stores it on a `studio.media_ingest` node.

## MVP feature set

Keep version 1 tight.

### Must-have

- load an existing Studio image asset into the modal
- add a new text label
- inline text edit
- drag labels anywhere
- resize label box
- basic font size control
- color control
- stroke/outline control
- delete label
- duplicate label
- bring forward / send backward
- keyboard delete/backspace support
- export flattened PNG
- reopen and continue editing the same draft

### Nice-to-have, but not required for v1

- snap-to-center guides
- keyboard arrow nudge
- preset styles
- text background pill/box presets
- rotation handles
- shadow presets
- copy final image to clipboard
- multi-select labels
- undo/redo inside the modal

### Explicitly out of scope for v1

- AI generation inside the meme editor
- template marketplace
- collaborative editing
- full Photoshop/Canva-style layer tooling
- non-text stickers/shapes beyond simple text labels

## UI recommendation

The modal should be simple:

- large center canvas with the image
- text labels rendered as draggable overlays
- very small control bar or inspector for the selected label
- obvious buttons for:
  - Add label
  - Duplicate
  - Delete
  - Save draft
  - Export meme

Default label styling should be opinionated so a new label looks good immediately.
A strong default would be:

- bold font
- white text
- dark outline
- transparent background

That gives classic meme readability without forcing setup before the first result.

## Entry points

Recommended order:

1. **Media node header action**: easiest discovery and clearest intent.
2. **Media preview click/open action**: nice secondary route.
3. **Command palette action for selected media node**: optional quality-of-life addition.

I would not make this a global Studio mode. It should be attached to a chosen image.

## Export behavior recommendation

On export:

1. Render the image plus labels into a flattened PNG.
2. Store it through `StudioAssetStore`.
3. Offer one of these behaviors:
   - default: insert a new Media node for the rendered meme
   - optional: copy path or replace current preview with exported version

Recommended default:

- **insert a new Media node automatically**

That preserves the original source image and makes the result immediately usable elsewhere in the graph.

## Phased build plan

### Phase 1 — modal MVP on top of existing Media nodes

- Add a new Media node action: `Caption Board`
- Build `CaptionBoardModal`
- Load the node’s current source image
- Support multiple movable text labels
- Persist draft JSON on the node config
- Export rendered meme as a new Studio asset
- Auto-insert a new Media node for the exported meme

### Phase 2 — polish and speed

- keyboard nudging
- duplicate/delete shortcuts
- simple alignment guides
- style presets
- better selection affordances
- clipboard export

### Phase 3 — graph-native promotion if usage justifies it

- add `studio.meme_board` node kind
- reuse the same modal/editor and JSON schema
- make rendered meme path available as a node output
- support downstream graph wiring without the export-as-new-media workaround

## Validation plan

Before calling this done, verify all of the following in the real plugin:

1. Paste an image into Studio and confirm the normal Media node still works.
2. Open Caption Board from that node.
3. Add at least 3 labels.
4. Drag them to different positions.
5. Change size/color on at least one label.
6. Save the draft, close the modal, reopen it, and confirm positions/text persist.
7. Export the meme and confirm a new Studio asset is created.
8. Confirm the exported result appears correctly in a new Media node preview.
9. Double-check that the original source image is untouched.
10. Check basic edge cases:
    - long text
    - empty label deletion
    - very small image
    - multiple export passes from the same draft

## Biggest risks

- trying to make the node card itself behave like a design tool
- overwriting the source image instead of producing a new output asset
- shipping too many formatting controls too early
- not persisting draft state, which would make the modal feel disposable
- not treating export as a first-class Studio asset

## Bottom-line recommendation

Build this as **Caption Board**, a focused modal editor attached to existing pasted Media nodes.

That gives you the Ding Board-like feel you want:

- image-centric
- fast
- playful
- free-positioned text labels
- minimal friction

without warping the normal Studio node-card UX.
