# SystemSculpt Studio — Design Philosophy

> Simple and easy to understand with room for power users. Content IS the node.

## Core Principles

**Content-first.** A media node should look like its media. A label should look like text. The node's content is the primary visual — controls, metadata, and chrome are secondary. Users should be able to glance at the graph and immediately understand what each node *is* without reading labels or metadata.

**Uniform base, specialized surface.** Every node shares the same base card frame (border, radius, background). No node type gets a fundamentally different container. Specialization happens through content rendering and progressive disclosure, not through card shape or structure.

**Progressive disclosure.** Nodes show their essential content by default. Controls, configuration, ports, and metadata appear on hover or selection — like a context menu, not a permanent fixture. This keeps the canvas clean at rest and functional on interaction.

**Flat and minimal.** No shadows on cards. Hairline 1px borders. Muted colors from the Obsidian theme. The canvas should feel calm and professional, not decorated. Visual references: ComfyUI (technical clarity), Figma (clean professionalism), Linear (ultra-minimalism).

**Full Obsidian theme respect.** All colors derive from Obsidian's CSS custom properties (`--background-primary`, `--text-normal`, `--interactive-accent`, etc.) via the `--ss-*` design token layer. No hardcoded hex colors in the studio CSS. The studio should look native in any Obsidian theme — light, dark, or custom.

## Design Token System

All visual values flow through `--ss-*` prefixed CSS custom properties defined in `src/css/base/variables.css`:

- **Colors**: `--ss-color-*` (semantic), `--ss-studio-*` (studio-specific palette)
- **Spacing**: `--ss-space-*` (1px through 48px scale)
- **Radius**: `--ss-radius-*` (3px through pill/circle)
- **Typography**: `--ss-font-size-*`, `--ss-font-weight-*`
- **Surfaces**: `--ss-layer-*`, `--ss-surface-*` (opaque composited tokens via `color-mix()`)

Rules:
- Zero inline visual styles in TypeScript. Positioning styles (`transform`, `width`, `height`, `minHeight`) are acceptable inline; visual styles (`color`, `background`, `border`, `font-size`, etc.) must use CSS classes or custom properties.
- Zero hardcoded hex colors in the studio CSS.
- Zero hardcoded spacing values — use `--ss-space-*` tokens.

## Two-Tier Node System

### Base card (all nodes)

Every node is a `.ss-studio-node-card` with:
- Hairline 1px border + 3px left status stripe
- `border-radius: var(--ss-radius-lg)` (8px)
- `background: var(--background-primary)`
- No box-shadow
- Status indicated by left border color via `:has()` selectors (running = accent, succeeded = green, failed = red, pending = yellow)

### Content-prominent nodes (media_ingest)

Media nodes use the **chrome overlay pattern**:

- The image/video is the **only in-flow child** of the card. The card sizes to just the media.
- All chrome (header, kind, status, ports, config) lives in a `.ss-studio-node-chrome-overlay` wrapper div that is `position: absolute; top: 100%` — a floating panel below the image.
- On hover/selection, the overlay fades in with `opacity` + `transform` transition. **No layout properties change. The image never moves.**
- The card's bottom corners flatten on hover (`border-bottom-*-radius: 0`) and the bottom border becomes transparent so the overlay joins seamlessly.
- The overlay's side borders align with the card's borders via `left: -3px; right: -1px`, creating one continuous visual container.

This pattern can extend to other content-prominent node types (labels, transcriptions) as needed.

### Functional nodes (text_generation, cli_command, http_request, etc.)

Show their full chrome by default — title input, config fields, ports, output preview. No hover-reveal. These are "working" nodes where the controls ARE the content.

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
- **CSS file**: `src/css/views/systemsculpt-studio.css` is the single source of truth for all studio visual styles.
- **Node targeting**: Use `[data-node-kind="studio.*"]` attribute selectors for per-type CSS overrides.
- **Positioning**: Node cards use `position: absolute` + `transform: translate()` set from TypeScript. This is the one acceptable inline style pattern.
