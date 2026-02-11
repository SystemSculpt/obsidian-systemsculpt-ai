# Styling guidelines

Last verified: **2026-02-11**.

Primary source: `src/css/README.md`.

## Naming rules

- Class prefixes: `ss-` and `systemsculpt-`
- CSS variable prefix: `--ss-`

## Scoping rules

- Do not use broad unscoped selectors that can affect all Obsidian UI.
- Scope Obsidian overrides to SystemSculpt containers/view types.
- Keep global override usage minimal and explicit.

## File organization

- Base tokens/resets: `src/css/base/*`
- Reusable components: `src/css/components/*`
- Layout primitives: `src/css/layout/*`
- View-specific styles: `src/css/views/*`
- Modal-specific styles: `src/css/modals/*`
- Obsidian overrides: `src/css/obsidian-overrides/*`

## Authoring workflow

1. Add/update CSS under `src/css/**`.
2. Import through `src/css/index.css` if needed.
3. Build and lint:

```bash
npm run build
npm run lint:css
```
