# Styling guidelines

Last verified: **2026-07-02**.

Primary source: `src/css/README.md` (the design-system contract).

## Naming rules

- Class prefixes: `ss-` and `systemsculpt-`
- CSS variable prefix: `--ss-`

## Design-system rules (enforced by `npm run lint:css`)

- All visual values come from `src/css/foundation/tokens.css` — no raw
  hex/rgb/hsl colors, no ad-hoc radii/font-sizes/shadows/durations in
  component sheets.
- All color derives from Obsidian theme variables via `color-mix`, so
  light/dark/custom themes work without forks.
- `!important` only in allowlisted files with a documented reason
  (`IMPORTANT_ALLOWLIST` in `scripts/lint-css.mjs`).

## Scoping rules

- Bare Obsidian selectors (`.workspace*`, `.nav-*`, `.tree-item*`,
  non-plugin `[data-type=]`/`[role=]`) are **errors** — `npm run
  lint:css` fails on them.
- Any other unprefixed top-level class is also a lint **error** — the
  migration to `ss-*`/`systemsculpt-*` is complete and the gate fails
  the build on new bare classes (state grammar stays `is-*`/`mod-*`,
  chained onto a prefixed base class).
- Scope Obsidian overrides to SystemSculpt containers/view types
  (`systemsculpt-`/`ss-` classes or `[data-type="systemsculpt-*"]`).

## File organization

- Tokens/base/motion: `src/css/foundation/*`
- Primitives (buttons, feedback): `src/css/primitives/*`
- Reusable components: `src/css/components/*`
- Modal system: `src/css/modals/*` (`modal.css` is the one shell)
- View-specific styles: `src/css/views/*` (each view's scoped Obsidian
  overrides live with its sheet, e.g. `views/chat.css`)
- Mobile: `src/css/platform/mobile.css`

## Authoring workflow

1. Add/update CSS under `src/css/**`.
2. Import through `src/css/index.css` if needed.
3. Build and lint:

```bash
npm run build
npm run lint:css
```
