# Styling coverage snapshot

Last verified against plugin source: **2026-02-11**.

This repo does **not** ship a standalone Obsidian theme package. It ships plugin CSS for SystemSculpt views/components.

## What is in scope here

- CSS entrypoint: `src/css/index.css`
- Tokens and design variables: `src/css/base/variables.css`
- Shared primitives: `src/css/base/*`, `src/css/components/*`, `src/css/layout/*`
- View-level styling: `src/css/views/*`
- Modal styling: `src/css/modals/*`
- Scoped Obsidian overrides: `src/css/obsidian-overrides/*`

## Areas with broad styling coverage

- Chat view and streaming blocks
- Tool call cards and statuses
- Settings UI
- Embeddings/Similar Notes surfaces
- Recorder and transcription widgets
- Benchmark and results views
- CanvasFlow and YouTube modal-related surfaces

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
