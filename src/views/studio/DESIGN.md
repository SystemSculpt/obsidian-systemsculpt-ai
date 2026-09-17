# SystemSculpt Studio — Design Philosophy

> Simple and easy to understand with room for power users. Content IS the node.

## Core Principles

**Content-first.** A media node should look like its media. A Text node should look like text. The node's content is the primary visual — controls, metadata, and chrome are secondary. Users should be able to glance at the graph and immediately understand what each node *is* without reading labels or metadata.

**Uniform base, specialized surface.** Every node shares the same base card frame (border, radius, background). No node type gets a fundamentally different container. Specialization happens through what the card renders, not through card shape or structure.

**Everything visible, always.** A node's full surface — title, action buttons, every config field, status — lives on the card in normal flow, visible whether or not the pointer is anywhere near it. There is NO hover-revealed chrome in the studio: hover-gated menus hide functionality, break touch, and make screenshots/recordings lie about what a node can do. Hover may still provide *feedback* on controls that are already visible (button tints, border emphasis) and may reveal *manipulation affordances* (resize corner squares), but never functionality. What a node does and offers must be fully legible at rest.

**Flat and minimal.** No shadows on cards. Hairline 1px borders. Muted colors from the Obsidian theme. The canvas should feel calm and professional, not decorated. Visual references: ComfyUI (technical clarity), Figma (clean professionalism), Linear (ultra-minimalism).

**Full Obsidian theme respect.** All colors derive from Obsidian's CSS custom properties (`--background-primary`, `--text-normal`, `--interactive-accent`, etc.) via the `--ss-*` design token layer. No hardcoded hex colors in the studio CSS. The studio should look native in any Obsidian theme — light, dark, or custom.

## Design Token System

All visual values flow through `--ss-*` prefixed CSS custom properties defined in `src/css/foundation/tokens.css`:

- **Colors**: `--ss-ink-*` (text/icons), `--ss-accent-*`, status tokens (`--ss-success/-warning/-danger/-info` + `-tint`/`-line`), `--ss-studio-*` (studio runtime palette)
- **Spacing**: `--ss-space-*` (2px through 48px, 4px grid)
- **Radius**: `--ss-radius-*` (xs through full/round)
- **Typography**: `--ss-text-*`, `--ss-weight-*`
- **Surfaces**: `--ss-surface-0` through `--ss-surface-3` + `--ss-surface-sunken` (opaque composited tokens via `color-mix()`); hairlines via `--ss-line*`

Rules:
- Zero inline visual styles in TypeScript. Positioning styles (`transform`, `width`, `height`, `minHeight`) are acceptable inline; visual styles (`color`, `background`, `border`, `font-size`, etc.) must use CSS classes or custom properties.
- Zero hardcoded hex colors in the studio CSS.
- Zero hardcoded spacing values — use `--ss-space-*` tokens.

## Two-Tier Node System

### Base card (all nodes)

Every node is a `.ss-studio-node-card` with:
- Hairline 1px border, no stripes or colored edges
- `border-radius: var(--ss-radius-lg)`
- `background: var(--background-primary)`
- No box-shadow
- Status carried by `data-activity` (see "Activity" below): a running card breathes a soft accent halo and shows a 2px progress bar along its top edge; settled phases show only in the activity row

### Card anatomy — one surface per kind, no tabs

`StudioNodeSurface.ts` gives every kind exactly one primary surface. Nothing is relocated after render and nothing waits for hover — `renderStudioGraphNodeCard` is the whole story. There are no overlay containers; the card's `offsetHeight` is its true visual height, which keeps group bounds, marquee hit-testing, and canvas sizing honest.

| Surface | Kinds | What the card is |
|---------|-------|------------------|
| **media** | media_ingest with loadable media | The image or video, with its actions in a normal-flow bar beneath it. No header, no source. |
| **text** | text | Chromeless Markdown that edits in place. Hugs its longest line (tldraw parity) until a width is dragged, then wraps at that width. |
| **code** | script, json, value, process, cli_command, terminal | The highlighted source, with **Edit source** then **Apply**. A compact output line appears beneath after a run. |
| **form** | image_generation, text_generation, codex, transcription, note, input, dataset, media_ingest without media, anything else | Header, activity row, ports, then the typed fields ordered by importance (prompt first), then the result: text, media, or a compact output line. No source view at all. |
| **panel** | collection, run_collection, command_center, button, workflow | Header, activity row, ports, then the renderer-owned panel. One **Source** toggle in the header swaps the body to the definition and back. |

Rule: if a field can be a typed control, it is a control, not YAML. Source editing survives only where the content is code or where a panel's definition has no form shape. Agents edit the project file directly; they never need the card's source view.

### Content-prominent nodes (media_ingest with loaded media)

The media branch (`data-chrome-layout="media"`): the card sizes to its image/video content. Image actions live in an always-visible, normal-flow toolbar directly below the image so the controls never obscure the content. Video actions remain a compact top overlay so native playback controls stay free. Port pins stay centered on the media itself rather than shifting with the image toolbar. When no primary content exists (empty source, failed load), the node renders as a normal card with the sourcePath picker on it.

### Functional nodes (text_generation, image_generation, codex, etc.)

Show ALL their config fields on the card — prompt, model, working directory. Ordering conveys importance (crucial fields first via `orderedFieldKeys` in `StudioGraphNodeInlineEditors.ts`); visibility does not change with the pointer. The graph-wide collapsed detail mode hides secondary sections; per-node collapsed-view toggles are no longer rendered on cards.

## Canvas Surface

- Flat `var(--background-primary)` background — no gradient
- Subtle dot grid at 30% opacity for spatial orientation
- No decorative elements
- **No corner.** The world is unbounded: nodes may sit at any coordinate, negative included. The viewport scrolls an elastic box (`StudioGraphWorldExtent.ts`) that covers the content and the current view plus a screen of room on every side, and grows in viewport-sized chunks as you approach an edge while the scroll position is compensated, so nothing jumps. Scrollbars are hidden because there is nothing to reach. Layers live in a translated world element, so nodes, edges, shapes and groups keep world coordinates; only client↔world conversions add the origin.

## Visual Elements

| Element | Style |
|---------|-------|
| **Ports** | Stacked rows: inputs down the left edge, outputs down the right, labels inside. 10px pins straddle the card border so cables meet the card, with a surface-colored halo lifting them off the hairline. Blue = input, green = output. Hollow = disconnected, filled = connected. Ring on hover. |
| **Edges** | 1.5px muted gray. Accent color on hover. While the source node works the cable turns accent, gains a soft glow, and bright energy dashes travel toward the target; delivered cables settle to the success color, failed ones to the danger color. |
| **Groups** | Dashed 1px border, no fill, no colored background. |
| **Toolbar** | Floating horizontal pill at top-center of canvas. |
| **Inspector** | Flat overlay panel. Light shadow, no backdrop-filter. |
| **Context menus** | Flat background, light shadow. |
| **Empty state** | Minimal centered prompt, no borders. |

## Activity — one grammar for "something is running"

Run state is never styled per surface. `src/views/studio/activity/` projects
graph-run events, native Codex runs, and workflow plans into one phase
vocabulary (`idle`, `queued`, `active`, `waiting`, `done`, `cached`, `failed`,
`stopped`) and writes it as `data-activity` on node cards, cable groups, port
pins, run cards, and workflow steps. `src/css/views/studio/activity.css` maps
each phase to `--ss-activity-color` and owns every run-state visual:

- **Node card**: breathing halo and top progress bar while live
  (`--ss-activity-progress` when the producer reports a percent), one-shot
  `data-activity-pulse` ring when it settles. No stripes.
- **Activity row**: dot (spinner while running, pulsing while waiting), phase
  word, percent, detail. Always in normal flow; hidden while idle.
- **Ports**: an output pin of a working node is filled and haloed
  (`emitting`); the input pin at the other end of a surging cable haloes in
  step (`receiving`).
- **Cables**: base line, a wide low-opacity glow, and an energy path whose
  dashes travel source → target (`surging`), then settle (`delivered`) or
  turn to the danger color (`failed`).

Live updates patch attributes in place through `StudioActivityDomApplier`;
the graph is rebuilt only when outputs or placeholders change, so spinners and
surges keep their phase across events. Reduced motion collapses every
animation to its resting frame through `foundation/surface.css`, and canvas
interaction pauses them. A new surface adopts the grammar by stamping
`data-activity`; it must not add its own status colors.

## Architecture Notes

- **DOM**: Pure DOM manipulation via Obsidian's `createDiv`/`createEl` API. No React, Svelte, or virtual DOM.
- **CSS modules**: `src/css/views/studio/` is the single source of truth for Studio visual styles. `src/css/index.css` lists the modules in their required cascade order; ownership is documented in `src/css/README.md`.
- **Node targeting**: Use `[data-node-kind="studio.*"]` attribute selectors for per-type CSS overrides.
- **Positioning**: Node cards use `position: absolute` + `transform: translate()` set from TypeScript. This is the one acceptable inline style pattern.
