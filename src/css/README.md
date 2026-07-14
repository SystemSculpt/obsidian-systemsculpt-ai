# SystemSculpt Design System

All plugin styling lives here, generated into `styles.css` by the esbuild
CSS pipeline (`@import` order = `index.css`).

## Architecture

```
foundation/   tokens.css   ← every visual decision (color, space, type,
                             radius, elevation, motion, z-layers)
              surface.css  ← theme/size/contrast/focus/motion adaptation for
                             every mounted plugin surface
              motion.css   ← the canonical @keyframes set
primitives/   buttons.css, surface-primitives.css, feedback.css
components/   feature components (attachments, diff, recorder, …)
modals/       modal.css (the one shell) + per-modal sheets
views/        settings, similar-notes, …
  agent-workspace/
              ordered shell/conversation/reasoning/tools/states/composer modules
  studio/     ordered, feature-owned canvas and editor modules
```

Studio is intentionally a module family rather than a monolithic view sheet.
The manifest imports its modules directly because the build expands direct
imports only, and their order is the Studio cascade contract:

1. Canvas: `theme`, `workspace`, `connections`, `node-chrome`, `media-nodes`,
   `node-runtime`, `groups`, `text-nodes`, `inspector`, `menus`.
2. Editors: `editor-preview`, `editor-text`, `editor-json`, `editor-notes`,
   `editor-dropdowns`, `editor-media`, `caption-board`, `editor-responsive`,
   `inline-config`, `node-details`.

Keep a rule with the component that owns it. Cross-component narrow-layout
rules belong in `editor-responsive.css`; Studio runtime variables and its
private keyframes belong in `theme.css`.

Agent workspace is also a module family with a fixed manifest order:

1. `shell`, `conversation`, `reasoning`
2. `tools`, `states`, `composer`

That order is the chat surface cascade contract. Keep viewport/header rules in
`shell.css`, conversational disclosures and streaming in `reasoning.css`,
compact tool/approval/artifact rows in `tools.css`, transient empty/queue
states in `states.css`, and every narrow-surface adjustment in `composer.css`.

## The rules (enforced by `npm run lint:css`, part of `check:plugin`)

1. **Tokens only.** Feature sheets never hardcode colors (hex/rgb/hsl or
   black/white),
   radii, font sizes, shadows, or transition durations — they consume
   `--ss-*` tokens from `foundation/tokens.css`.
2. **Theme-derived color.** Every color comes from Obsidian theme
   variables via `color-mix`, so any theme (light/dark/custom) works.
3. **One state grammar.** hover = `--ss-state-hover` tint + stronger
   hairline; active = press; selected = accent tint + accent hairline;
   focus = `--ss-ring`; disabled = 0.5 opacity.
4. **`!important` is allowlisted.** Only files with a documented,
   load-bearing reason (see `IMPORTANT_ALLOWLIST` in
   `scripts/lint-css.mjs`) may use it.
5. **Scoping.** Bare element and Obsidian selectors (`button`, `.workspace*`, `.nav-*`,
   `.tree-item*`, non-plugin `[data-type=]`/`[role=]`) are forbidden —
   the lint **errors** on them. Overrides must be scoped to
   `systemsculpt-`/`ss-` classes or `[data-type="systemsculpt-*"]`.
   Any other unprefixed top-level class is also a lint **error** (the
   migration is complete): every class must be `ss-*`/`systemsculpt-*`,
   with `is-*`/`mod-*` reserved for chained state grammar.
6. **Keyframes** live in `foundation/motion.css` (`ss-*`); Studio-only
   ones (`ss-studio-*`) live in `views/studio/theme.css`.
7. **Complete contracts.** The lint scans selectors inside media/container
   rules, rejects undefined `--ss-*` references unless they are registered
   runtime contracts, and reserves numeric z-layer tiers for Studio geometry.

## Naming

- Classes: `ss-*` (components) or `systemsculpt-*` (top-level containers);
  BEM-ish `__element` / `--modifier`; state classes `is-*` / `mod-*`.
- Custom properties: `--ss-*`.

## Runtime CSS-variable contracts (written by TS — never rename)

- `--ss-studio-group-accent`, `--ss-studio-chip-color`,
  `--ss-studio-swatch-color`, `--ss-studio-*-scale`,
  `--ss-studio-text-node-font-size`, `--ss-studio-annotation-color/-stroke`,
  `--ss-link-flow-phase`, `--ss-link-flare-t` — Studio runtime
- `--ss-studio-link-*` — read by StudioEdgeRenderer for inline SVG strokes
- `.systemsculpt-agent-workspace.is-font-{small|medium|large}` — the agent
  workspace font-scale contract, toggled by the agent workspace view and
  implemented in `views/agent-workspace/shell.css`.

## Workflow

1. Edit CSS under `src/css/**`; new files must be imported directly in
   `index.css` (the build does not recurse through CSS aggregators).
2. `npm run build` regenerates `styles.css`.
3. `npm run check:ui` verifies the complete import graph, mounted surface
   adapters, CSS contracts, and focused DOM behavior in about two seconds.
4. `npm run lint:css` and `npm run check:plugin:fast` must stay green.
