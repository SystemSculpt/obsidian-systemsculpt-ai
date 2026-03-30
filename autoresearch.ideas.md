- Audit nearby provider/setup surfaces for silent runtime-relative `require(...)`
  fallbacks or null-return auth shims that can hide broken bundled paths in the
  shipped plugin.
- If this regresses again, add a tighter end-to-end smoke that asserts the
  Windows provider-state transition `none -> api_key -> none` through the built
  plugin while still completing the real filesystem tool turn.
