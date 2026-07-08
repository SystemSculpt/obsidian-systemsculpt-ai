# Styling coverage snapshot

Last verified against plugin source: **2026-07-03**.

This repo does **not** ship a standalone Obsidian theme package. It ships plugin CSS for SystemSculpt views/components.

## What is in scope here

- CSS entrypoint: `src/css/index.css`
- Tokens and design variables: `src/css/foundation/tokens.css`
- Shared primitives: `src/css/foundation/*`, `src/css/primitives/*`, `src/css/components/*`
- View-level styling: `src/css/views/*`
- Modal styling: `src/css/modals/*`
- Scoped Obsidian overrides: live with each view's sheet (e.g.
  `views/chat.css`), strictly `[data-type="systemsculpt-*"]`-scoped

## Areas with broad styling coverage

- Chat view and streaming blocks
- Tool call cards and statuses
- Settings UI
- Embeddings/Similar Notes surfaces
- Recorder and transcription widgets
- YouTube modal-related surfaces

## Known constraints

- Global Obsidian overrides are intentionally restricted.
- Styling behavior can vary with user themes because tokens map to Obsidian variables.
- `styles.css` is generated; edit files under `src/css/**` instead.

## Verification path

Run:

```bash
npm run build
npm run lint:css
```
