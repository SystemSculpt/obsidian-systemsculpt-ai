# SystemSculpt Design System

All plugin styling lives here, generated into `styles.css` by the esbuild
CSS pipeline (`@import` order = `index.css`).

## Architecture

```
foundation/   tokens.css   ← every visual decision (color, space, type,
                             radius, elevation, motion, z-layers)
              base.css     ← scoped ground floor: focus ring, scrollbars,
                             visually-hidden
              motion.css   ← the canonical @keyframes set
primitives/   buttons.css, feedback.css (spinners, notices, banners)
components/   feature components (chat, widgets, diff, recorder, …)
modals/       modal.css (the one shell) + per-modal sheets
views/        agent workspace, settings, similar-notes, studio, …
```

## The rules (enforced by `npm run lint:css`, part of `check:plugin`)

1. **Tokens only.** Component sheets never hardcode colors (hex/rgb/hsl),
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
5. **Scoping.** Bare Obsidian selectors (`.workspace*`, `.nav-*`,
   `.tree-item*`, non-plugin `[data-type=]`/`[role=]`) are forbidden —
   the lint **errors** on them. Overrides must be scoped to
   `systemsculpt-`/`ss-` classes or `[data-type="systemsculpt-*"]`.
   Any other unprefixed top-level class is also a lint **error** (the
   migration is complete): every class must be `ss-*`/`systemsculpt-*`,
   with `is-*`/`mod-*` reserved for chained state grammar.
6. **Keyframes** live in `foundation/motion.css` (`ss-*`); studio-only
   ones (`ss-studio-*`) live with the studio sheet.

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
  workspace font-scale contract, toggled by `AgentChatView` and implemented in
  `views/agent-workspace.css`.

## Workflow

1. Edit CSS under `src/css/**`; new files must be imported in `index.css`.
2. `npm run build` regenerates `styles.css`.
3. `npm run lint:css` (also runs in `check:plugin`) must stay green.
