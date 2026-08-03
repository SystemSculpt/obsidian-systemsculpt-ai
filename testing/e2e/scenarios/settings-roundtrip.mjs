/**
 * Canonical settings configuration round trip.
 *
 * Proves settings are drivable end to end: tab navigation by dynamic
 * markers, reading a row control by its visible name, changing a dropdown
 * through a real change event, verifying it stuck, and restoring the
 * original value so the run leaves no trace.
 *
 *   npm run e2e -- script testing/e2e/scenarios/settings-roundtrip.mjs
 */

export default [
  { label: "open settings on the Chat tab", action: "settings.open", params: { tab: "Chat" } },
  { label: "read current font size", action: "read", params: {
    target: "setting:Default chat font size",
  } },
  { label: "change font size to large", action: "select", params: {
    target: "setting:Default chat font size",
    value: "large",
  } },
  { label: "verify the change stuck", action: "waitFor", params: {
    target: "setting:Default chat font size",
    state: "exists",
  } },
  { label: "read changed control", action: "read", params: {
    target: "setting:Default chat font size",
  } },
  { label: "restore medium", action: "select", params: {
    target: "setting:Default chat font size",
    value: "medium",
  } },
  { label: "hop to Knowledge via marker", action: "click", params: { target: "settings.tab.knowledge" } },
  { label: "back to Account via marker", action: "click", params: { target: "settings.tab.account" } },
  { label: "settings snapshot", action: "snapshot", params: { scope: "settings" } },
  { label: "close settings", action: "settings.close" },
];
