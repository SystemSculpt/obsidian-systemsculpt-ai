/**
 * Visible diagnostics-export attribution round trip.
 *
 * Proves the canonical support export is drivable and privacy-safe end to
 * end: the harness baselines the diagnostics directory, clicks the real
 * "Copy diagnostics snapshot" button in Settings → Advanced, attributes
 * exactly one new collision-proof snapshot file, validates the allowlisted
 * content-free schema and privacy canaries internally, and reports only
 * basename/bytes/SHA/count metadata. Cleanup recoverably trashes only that
 * exact attributed file through Obsidian-local trash — never a permanent
 * delete — so the run leaves no trace.
 *
 *   npm run e2e -- script testing/e2e/scenarios/diagnostics-export-roundtrip.mjs
 */

export default {
  steps: [
    {
      label: "baseline existing diagnostics exports",
      action: "diagnostics.baselineExports",
    },
    {
      label: "open settings on the Advanced tab",
      action: "settings.open",
      params: { tab: "Advanced" },
    },
    {
      label: "export a snapshot through the real button",
      action: "click",
      params: { target: "setting:Copy diagnostics snapshot" },
    },
    {
      label: "attribute exactly one new snapshot with metadata-only evidence",
      action: "diagnostics.attributeNewExport",
      params: { timeoutMs: 15000 },
    },
  ],
  cleanup: [
    {
      label: "close settings",
      action: "settings.close",
    },
    {
      label: "recoverably trash only the attributed snapshot",
      action: "diagnostics.trashAttributedExport",
    },
  ],
};
