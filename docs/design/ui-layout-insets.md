# UI layout insets

Last verified: **2026-02-11**.

SystemSculpt uses overlap-based inset handling for views that could collide with docked UI (such as the status bar).

## Helper service

- `src/core/ui/services/OverlapInsetService.ts`
- `attachOverlapInsetManager(...)` computes overlap and applies inset values.

## Typical usage

1. Provide a target container element.
2. Provide an anchor lookup (for example `.status-bar`).
3. Apply inset as CSS variable and/or inline padding.
4. Recompute on layout/theme/resize changes.

## Why this exists

Obsidian does not expose a direct status-bar-height API for plugin layout calculations, so DOM overlap measurement is used.
