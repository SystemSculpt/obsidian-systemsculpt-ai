# SystemSculpt Studio — Design Philosophy

> Simple and easy to understand with room for power users. Content IS the node.

## Core Principles

**Content-first.** A media node should look like its media. A label should look like text. The node's content is the primary visual — controls, metadata, and chrome are secondary. Users should be able to glance at the graph and immediately understand what each node *is* without reading labels or metadata.

**Uniform base, specialized surface.** Every node shares the same base card frame (border, radius, background). No node type gets a fundamentally different container. Specialization happens through content rendering and progressive disclosure, not through card shape or structure.

**Progressive disclosure.** Nodes show their essential content by default. Controls, configuration, and metadata appear on hover or selection — like a context menu, not a permanent fixture. This keeps the canvas clean at rest and functional on interaction.

**Crucial details visible.** Not all config is equal. Each node type has a few *crucial* fields that define what the node does at a glance — these stay visible on the card at rest. Secondary config (model selection, timeouts, advanced options) lives in the bottom overlay and appears on hover or selection. Example: a text_generation node always shows its system prompt (the creative intent) but model/reasoning config slides out from below on hover. An input node always shows its value. A media_ingest node shows its image but the source path is in the bottom overlay. Secondary fields are declared in `SECONDARY_FIELDS` in `StudioGraphNodeCardRenderer.ts` and moved to the bottom overlay after layout — extend by adding entries to that map.

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

### Chrome layout — universal hierarchy (`applyChromeLayout`)

Every non-label node goes through `applyChromeLayout(nodeEl, policy)` — the **single source of truth** for chrome arrangement. The policy declares:

- `topPanel[]` — element classes routed to `.ss-studio-node-chrome-overlay-top` (hover-reveal above card). Contains Quick Actions toolbar + title input.
- `bottomPanel[]` — element classes routed to `.ss-studio-node-chrome-overlay` (hover-reveal below card). Contains config preview, kind label, status row.
- `contentFillsCard` — if true, sets `data-chrome-layout="overlay"` for zero-padding / flex-column card styling (content-prominent nodes like media_ingest with a loaded image).

Everything not claimed by topPanel or bottomPanel stays on the card: ports, inline config panels, output previews, text editors, media previews.

**Overlay panels** are `position: absolute`, never in flow. They use `visibility: hidden; opacity: 0; pointer-events: none` at rest and fade in on hover/selection. **No transforms on overlay containers** — this keeps port positions stable for the connection engine's `getBoundingClientRect` calls.

**Field-level progressive disclosure** is handled purely in CSS, not by the layout function. Secondary config fields (e.g., model/reasoning on text_generation) are hidden by default and shown on card hover/selection via `display: none` / `display: grid` toggles. Extend by adding per-node-kind selectors in the CSS — no TS changes needed.

### Content-prominent nodes (media_ingest with loaded media)

When `contentFillsCard` is true: the image/video is the only in-flow child. Card sizes to just the content. Card corners flatten and borders go transparent on hover so overlays join seamlessly. When no primary content exists (empty source, failed load), the overlay pattern is skipped and the node renders as a normal card.

### Functional nodes (text_generation, cli_command, http_request, etc.)

Show their crucial config fields by default — system prompt, command, URL, input value. Ports visible at top. Secondary config (model selection, timeouts, advanced options) hidden until hover/selection. Quick Actions and title input revealed via top overlay on hover.

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
