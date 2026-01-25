# UI Layout Insets (Status Bar Overlap)

Obsidian does not expose a direct API for status bar height. The only official API surface is `addStatusBarItem()`, which returns an `HTMLElement` for *adding* items, not measuring layout. The status bar itself lives outside the workspace container, so the safest approach is to measure DOM overlap and apply an inset to the view container.

We use a reusable helper to do this: `attachOverlapInsetManager`.

## When to use

- Any view that needs to avoid overlapping a fixed or docked UI element (status bar, ribbons, docked toolbars).
- Situations where the element can appear/disappear with themes or layout changes.

## How it works

1. Find the anchor element (the UI you must avoid).
2. Measure overlap between the view container and the anchor using `getBoundingClientRect()`.
3. Apply the overlap as an inset:
   - Inline `padding-bottom` (optional) so it wins against theme CSS.
   - A CSS variable so styles can react if needed.
4. Recompute on `layout-change`, `css-change`, window resize, and `ResizeObserver`.

## Usage

```ts
import { attachOverlapInsetManager } from "../core/ui/services/OverlapInsetService";

attachOverlapInsetManager(chatView, {
  app: chatView.app,
  container,
  cssVariable: "--systemsculpt-status-bar-offset",
  applyPaddingBottom: true,
  getAnchor: () => document.body.querySelector(".status-bar") as HTMLElement | null,
});
```

## Options

- `cssVariable` (default `--systemsculpt-overlap-inset`): where the computed px value is stored.
- `applyPaddingBottom` (default `true`): apply inline `padding-bottom` to the container.
- `retryCount` / `retryIntervalMs`: retries for late-created anchors.

## Notes

- `getAnchor` should return `null` on mobile or when the target UI is hidden.
- The helper is safe to call once per view; it registers its own cleanup via the `Component` lifecycle.
- If you only need the CSS variable (no inline padding), set `applyPaddingBottom: false` and handle layout in CSS.
