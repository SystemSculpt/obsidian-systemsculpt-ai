# SystemSculpt Theme Guidelines

## Overview
- Ships as an Obsidian theme (`vault/.obsidian/themes/SystemSculpt/theme.css`) with `manifest.json` metadata.
- Exposes brand-consistent tokens (`--systemsculpt-*`) that map to plugin variables (`--ss-color-*`).
- Honors light/dark modes via `.theme-light` and `.theme-dark` selectors; Obsidian inherits automatically when `appearance.json` selects the theme.

## Token Bridge
- Theme defines brand tokens (`--systemsculpt-primary`, `--systemsculpt-surface-primary`, etc.).
- Plugin CSS reads them through `src/css/base/variables.css` (`--ss-color-primary`, `--ss-color-bg-primary`, …).
- Fallbacks preserve behavior if theme disabled (reverts to native Obsidian vars).

### Surface Families
- `--systemsculpt-surface-primary` → base backgrounds, notes, panels.
- `--systemsculpt-surface-secondary` → secondary panes, menus, floating widgets.
- `--systemsculpt-surface-elevated` → modals, cards, popovers.
- `--systemsculpt-surface-hover` → hover overlays.

### Interaction
- `--systemsculpt-primary` azure accent anchors buttons, toggles, selection rings.
- Secondary tokens favor softened slate neutrals to avoid fatigue.
- Success/Warning/Danger align with chart palette for consistent storytelling.

## Component Patterns
- **Buttons (`ss-buttons.css`)**: adopt brand tokens, elevated `box-shadow` on primary, `cursor: pointer` defaults, disabled pointer guard.
- **Cards (`card-system-unified.css`)**: use elevation shadows + ring highlight on selection; disabled state removes pointer events.
- **Modals (`standardized-modal.css`)**: background/border pulled from surfaces, close button + filters share hover tokens.
- Additional components should source tokens via `var(--ss-color-*)` and never hard-code HSL.

## Extending the Theme
- Use `--systemsculpt-shadow-*` helpers for elevation consistency.
- For new accents, stay within 10° hue range of 228° to avoid brand drift.
- When introducing gradients, mix brand primary with neutral surfaces using `color-mix` for subtle depth.
- Respect accessibility: target ≥4.5:1 contrast for text and ≥3:1 for iconography.

## QA & Verification
- Manual contrast spot checks with browser accessibility tools on key surfaces: nav, modals, cards, alerts.
- `npm run check:plugin` ensures CSS imports compile.
- Theme selection confirmed by setting `cssTheme` to `SystemSculpt` in `appearance.json`.
- Smoke test: open core views (Chat, Settings, Context) in both light/dark, verify tokens propagate.

## Release Notes
- Version `0.1.0` defined in `manifest.json`; bump when adjusting palette or major components.
- Document palette changes in `systemsculpt-theme-reference.md` to keep source-of-truth up to date.

