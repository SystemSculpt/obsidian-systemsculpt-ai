/**
 * Reproduces the reported contradiction: an empty chat that shows a queued
 * message and refuses a tool-access change because it believes a previous
 * chat's run is still working.
 *
 * Start a run in chat A, immediately open chat B while A is still live, then
 * assert B is genuinely fresh: no queued item, tool access changeable, and a
 * submission that actually starts rather than queueing behind A.
 */

export default [
  { label: "open chat", action: "chat.open" },
  { label: "chat A", action: "click", params: { target: "chat.header.new" } },
  {
    label: "A composer ready",
    action: "waitFor",
    params: { target: "chat.composer.input", state: "visible", timeoutMs: 10000 },
  },
  {
    label: "A: start a long run",
    action: "type",
    params: {
      text: "Count slowly from 1 to 40, one number per line, with a short "
        + "sentence about each number.",
      submit: true,
    },
  },
  {
    label: "A is actually running",
    action: "waitFor",
    params: { target: "chat.composer.stop", state: "visible", timeoutMs: 25000 },
  },
  // Switch away mid-run. Chat B must inherit nothing from A.
  { label: "chat B while A runs", action: "click", params: { target: "chat.header.new" } },
  {
    label: "B composer ready",
    action: "waitFor",
    params: { target: "chat.composer.input", state: "visible", timeoutMs: 10000 },
  },
  {
    label: "B shows no run (A's run must not leak)",
    action: "waitFor",
    params: { target: "chat.composer.stop", state: "hidden", timeoutMs: 8000 },
  },
  {
    label: "B accepts a tool-access change",
    action: "select",
    params: { target: "chat.composer.approval-mode", value: "full-access" },
  },
  {
    label: "B has no error banner",
    action: "waitFor",
    params: { target: "css:.systemsculpt-agent-banner", state: "hidden", timeoutMs: 3000 },
  },
  {
    label: "B: submit",
    action: "type",
    params: { text: "Reply with exactly BEE and nothing else.", submit: true },
  },
  {
    label: "B's run starts (not queued behind A)",
    action: "waitForRun",
    params: { timeoutMs: 180000, stallMs: 60000 },
  },
  { label: "B transcript", action: "snapshot", params: { scope: "chat" } },
];
