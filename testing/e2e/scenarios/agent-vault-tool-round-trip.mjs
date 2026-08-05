/**
 * End-to-end proof that a turn actually completes, including the client-tool
 * round trip.
 *
 * A text-only prompt exercises none of the client-tool path, so it stays green
 * while tool delivery is broken. This scenario therefore makes the model write
 * a uniquely named vault file and waits on run completion with `waitForRun`,
 * which fails loudly on a stall instead of timing out ambiguously.
 */

const STALL_MS = 60000;
const RUN_TIMEOUT_MS = 180000;

export default function makeAgentVaultToolRoundTrip(now = Date.now()) {
  const runId = now.toString(36).toUpperCase();
  const filePath = `QA/E2E/round-trip-${runId}.md`;
  const completionMarker = `DONE-${runId}`;
  return [
  { label: "open chat", action: "chat.open" },
  {
    label: "full access so tools run without prompting",
    action: "select",
    params: { target: "chat.composer.approval-mode", value: "full-access" },
  },
  { label: "new chat", action: "click", params: { target: "chat.header.new" } },
  {
    label: "composer ready",
    action: "waitFor",
    params: { target: "chat.composer.input", state: "visible", timeoutMs: 10000 },
  },
  {
    label: "no phantom run on a fresh chat",
    action: "waitFor",
    params: { target: "chat.composer.stop", state: "hidden", timeoutMs: 5000 },
  },
  {
    label: "submit a vault-tool prompt",
    action: "type",
    params: {
      text: `Create exactly one file at ${filePath} containing the single line ${runId}. `
        + `Use your vault tools. Then reply with exactly ${completionMarker}.`,
      submit: true,
    },
  },
  {
    label: "run completes without stalling",
    action: "waitForRun",
    params: { timeoutMs: RUN_TIMEOUT_MS, stallMs: STALL_MS },
  },
  {
    label: "expected completion marker",
    action: "waitFor",
    params: {
      target: "css:.systemsculpt-agent-turn.is-assistant .systemsculpt-agent-part.is-text",
      state: "textEquals",
      text: completionMarker,
      timeoutMs: 5000,
    },
  },
  {
    label: "round-trip file has exact content",
    action: "vault.assertText",
    params: { path: filePath, text: runId },
  },
  { label: "transcript", action: "snapshot", params: { scope: "chat" } },
  {
    label: "no error banner",
    action: "waitFor",
    params: { target: "css:.systemsculpt-agent-banner", state: "hidden", timeoutMs: 2000 },
  },
  ];
}
