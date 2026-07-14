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
- Hairline 1px border + 3px left status stripe
- `border-radius: var(--ss-radius-lg)`
- `background: var(--background-primary)`
- No box-shadow
- Status indicated by left border color via `:has()` selectors (running = accent, succeeded = green, failed = red, pending = yellow)

### Card anatomy — one static flow, no chrome layers

Every node except the visual-only Text node renders as a single in-flow stack, top to bottom: header (title input + run/copy/lock/delete icon buttons), status row, ports, inline config/editors, previews. Nothing is relocated after render and nothing waits for hover — `renderStudioGraphNodeCard` is the whole story. There are no overlay containers; the card's `offsetHeight` is its true visual height, which keeps group bounds, marquee hit-testing, and canvas sizing honest.

### Content-prominent nodes (media_ingest with loaded media)

The media branch (`data-chrome-layout="media"`): the image/video is the only in-flow child and the card sizes to it. Actions live in the always-visible pill action bar floating inside the media's edge (bottom for images, top for videos so native playback controls stay free). Port pins sit centered on the side edges. When no primary content exists (empty source, failed load), the node renders as a normal card with the sourcePath picker on it.

### Functional nodes (text_generation, cli_command, http_request, etc.)

Show ALL their config fields on the card — prompt, model, command, URL, timeouts. Ordering conveys importance (crucial fields first via `orderedFieldKeys` in `StudioGraphNodeInlineEditors.ts`); visibility does not change with the pointer. The per-node "collapsed view" toggles (detail-mode feature) tune what a *collapsed* card shows — that is a zoom/detail lever the user sets explicitly, not hover behavior.

## Canvas Surface

- Flat `var(--background-primary)` background — no gradient
- Subtle dot grid at 30% opacity for spatial orientation
- No decorative elements

## Visual Elements

| Element | Style |
|---------|-------|
| **Ports** | 8px circles. Blue = input, green = output. Hollow = disconnected, filled = connected. Glow on hover. |
| **Edges** | 1.5px muted gray. Accent color on hover. |
| **Groups** | Dashed 1px border, no fill, no colored background. |
| **Toolbar** | Floating horizontal pill at top-center of canvas. |
| **Inspector** | Flat overlay panel. Light shadow, no backdrop-filter. |
| **Context menus** | Flat background, light shadow. |
| **Empty state** | Minimal centered prompt, no borders. |

## Architecture Notes

- **DOM**: Pure DOM manipulation via Obsidian's `createDiv`/`createEl` API. No React, Svelte, or virtual DOM.
- **CSS modules**: `src/css/views/studio/` is the single source of truth for Studio visual styles. `src/css/index.css` lists the modules in their required cascade order; ownership is documented in `src/css/README.md`.
- **Node targeting**: Use `[data-node-kind="studio.*"]` attribute selectors for per-type CSS overrides.
- **Positioning**: Node cards use `position: absolute` + `transform: translate()` set from TypeScript. This is the one acceptable inline style pattern.
