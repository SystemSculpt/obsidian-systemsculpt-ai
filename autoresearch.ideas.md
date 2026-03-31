# Deferred ideas

- If same-message seeding proves too brittle, extract a dedicated display-only
  projection for consecutive assistant rounds instead of reusing the persisted
  assistant root directly.
- If the compact live flow works but still feels visually busy, tighten the
  spacing between consecutive structured blocks inside one assistant container
  without changing the chronological order.
- Add a native desktop smoke case later that asserts a multi-round hosted turn
  finishes inside one assistant root without needing a reload.
