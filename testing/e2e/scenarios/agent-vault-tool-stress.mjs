/**
 * Heavy client-tool stress: ~30 separate vault tool calls in one turn.
 *
 * This is the shape that used to wedge — six writes landed and the seventh
 * provider attempt streamed nothing forever, leaving the run marked active
 * with no executor. It exercises the whole client-tool loop repeatedly:
 * approval policy, tool dispatch, result delivery, and continuation.
 *
 * Approval mode is set to full access *before* the run starts, because the
 * composer refuses to change tool access while a run is live.
 */

const RUN_TIMEOUT_MS = 900000;
const STALL_MS = 120000;

export default function makeAgentVaultToolStress(now = Date.now()) {
  const runId = now.toString(36).toUpperCase();
  const folder = `QA/Stress-${runId}`;
  const completionMarker = `FINISHED-${runId}`;
  return [
  { label: "open chat", action: "chat.open" },
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
    label: "full access (no manual approvals)",
    action: "select",
    params: { target: "chat.composer.approval-mode", value: "full-access" },
  },
  {
    label: "approval mode really is full access",
    action: "read",
    params: { target: "chat.composer.approval-mode" },
  },
  {
    label: "submit a ~30 tool-call job",
    action: "type",
    params: {
      text: [
        "Use your vault tools to do EVERY step below, in order, each as its own",
        "separate tool call. Do not batch them.",
        `1. Create the folder ${folder}.`,
        `2-21. Create twenty files ${folder}/Item-01.md .. Item-20.md.`,
        "Each file's entire contents must be its own number, e.g. Item-07.md",
        "contains exactly 7.",
        `22. List the folder ${folder}.`,
        `23. Read ${folder}/Item-05.md.`,
        `24. Read ${folder}/Item-15.md.`,
        `25. Overwrite ${folder}/Item-03.md so it contains exactly THREE.`,
        `26. Read ${folder}/Item-03.md to confirm.`,
        `27. Create ${folder}/SUMMARY.md containing exactly DONE-30.`,
        `Then reply with exactly ${completionMarker}.`,
      ].join(" "),
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
      target: "chat:.systemsculpt-agent-turn.is-assistant .systemsculpt-agent-part.is-text",
      state: "textEquals",
      text: completionMarker,
      timeoutMs: 5000,
    },
  },
  {
    label: "stress overwrite has exact content",
    action: "vault.assertText",
    params: { path: `${folder}/Item-03.md`, text: "THREE" },
  },
  {
    label: "stress summary has exact content",
    action: "vault.assertText",
    params: { path: `${folder}/SUMMARY.md`, text: "DONE-30" },
  },
  { label: "transcript", action: "snapshot", params: { scope: "chat" } },
  {
    label: "no error banner",
    action: "waitFor",
    params: { target: "chat:.systemsculpt-agent-banner", state: "hidden", timeoutMs: 2000 },
  },
  ];
}
