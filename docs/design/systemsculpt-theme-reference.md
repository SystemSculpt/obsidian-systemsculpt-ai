# Styling token reference

Last verified against `src/css/foundation/tokens.css`: **2026-07-03**.

`src/css/foundation/tokens.css` is the single source of truth; this page is a
map of the token families, not a value table. All colors derive from Obsidian
theme variables via `color-mix`, so every theme (light/dark/custom) works.

## Color

- Ink (text/icons): `--ss-ink`, `--ss-ink-muted`, `--ss-ink-faint`,
  `--ss-ink-accent`, `--ss-ink-on-accent`
- Surfaces (elevation ramp): `--ss-surface-0` … `--ss-surface-3`,
  `--ss-surface-sunken`
- Interactive state tints: `--ss-state-hover`, `--ss-state-active`,
  `--ss-state-selected`; scrim: `--ss-scrim`
- Lines (hairlines): `--ss-line`, `--ss-line-strong`, `--ss-line-accent`
- Accent: `--ss-accent`, `--ss-accent-hover`, `--ss-accent-tint`,
  `--ss-accent-tint-strong`
- Status (each as ink/tint/line): `--ss-success[-tint|-line]`,
  `--ss-warning[-tint|-line]`, `--ss-danger[-tint|-line]`,
  `--ss-info[-tint|-line]`

## Layout and typography

- Spacing (4px grid): `--ss-space-0` (2px) through `--ss-space-10` (40px)
- Radius: `--ss-radius-xs|sm|md|lg|xl|full|round`
- Fonts: `--ss-font`, `--ss-font-mono`
- Text sizes: `--ss-text-xs|sm|base|lg|xl|2xl` (13px UI base)
- Weights: `--ss-weight-medium|semibold`
- Line height: `--ss-leading-tight|base|relaxed`;
  tracking: `--ss-tracking-tight|wide`

## Depth, focus, motion

- Elevation: `--ss-elevation-1` … `--ss-elevation-4` (+ `--ss-shadow-color`)
- Focus ring (one ring everywhere): `--ss-ring`
- Durations: `--ss-dur-fast|base|slow`; easings: `--ss-ease`,
  `--ss-ease-out`, `--ss-ease-spring`
- Canonical transition sets: `--ss-transition-colors`,
  `--ss-transition-transform`
- Z-layers: `--ss-z-raised|sticky|drawer|modal|popover|tooltip|notice`

## Component metrics

- Control heights: `--ss-control-height[-sm|-lg]`
- Icon sizes: `--ss-icon-size[-sm|-lg]`
- Touch target: `--ss-touch-target`

## Runtime CSS-variable contracts (written by TS — never rename)

See "Runtime CSS-variable contracts" in `src/css/README.md`.
