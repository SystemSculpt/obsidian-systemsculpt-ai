import {
  LATEST_DURABLE_ASSISTANT_TEXT,
} from "./chatview-development-state.mjs";

export const CANCELLATION_MARKER = "SS-DEV-TEST-OPSCANCEL1";
export const CANCELLATION_RECOVERY = "OPS-CANCEL-RECOVERED-1";
export const CANCELLATION_STREAM_START = "OPS-CANCEL-STREAM-START-1";

const recoveryPrompt =
  `Reply with exactly ${CANCELLATION_RECOVERY} and nothing else. Do not use tools.`;

export default {
  steps: [
    { label: "open chat", action: "chat.open" },
    {
      label: "begin owned cancellation state",
      action: "chat.beginDevelopmentState",
      params: { marker: CANCELLATION_MARKER },
    },
    {
      label: "submit deliberately long response",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: `Begin with exactly ${CANCELLATION_STREAM_START} on its own line. Then write a `
          + "very long response containing ten thousand sequential numbered short lines. "
          + "Do not use tools. Start immediately.",
        submit: true,
      },
    },
    {
      label: "Stop becomes available for the active run",
      action: "waitFor",
      params: { target: "chat.composer.stop", state: "visible", timeoutMs: 30000 },
    },
    {
      label: "streamed response content is visibly painted before cancellation",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-active-run .systemsculpt-agent-part.is-text",
        state: "textContains",
        text: CANCELLATION_STREAM_START,
        timeoutMs: 60000,
      },
    },
    {
      label: "cancel active run through Stop",
      action: "click",
      params: { target: "chat.composer.stop" },
    },
    {
      label: "Stop disappears after cancellation settles",
      action: "waitFor",
      params: { target: "chat.composer.stop", state: "hidden", timeoutMs: 60000 },
    },
    {
      label: "cancelled response is visibly terminal and non-active",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-active-run "
          + ".systemsculpt-agent-turn.is-assistant:not(.is-active) "
          + ".systemsculpt-agent-tail-status.is-cancelled",
        state: "textEquals",
        text: "Stopped",
        timeoutMs: 10000,
      },
    },
    {
      label: "cancelled response has no active assistant row",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-active-run "
          + ".systemsculpt-agent-turn.is-assistant.is-active",
        state: "hidden",
        timeoutMs: 5000,
      },
    },
    {
      label: "cancel releases composer input",
      action: "waitFor",
      params: { target: "chat.composer.input", state: "enabled", timeoutMs: 5000 },
    },
    {
      label: "type immediate recovery draft",
      action: "chat.typeDevelopmentDraft",
      params: { text: recoveryPrompt, submit: false },
    },
    {
      label: "recovery send is enabled",
      action: "waitFor",
      params: { target: "chat.composer.send", state: "enabled", timeoutMs: 5000 },
    },
    {
      label: "submit immediate recovery turn",
      action: "chat.typeDevelopmentDraft",
      params: { text: recoveryPrompt, submit: true },
    },
    {
      label: "recovery turn completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: 180000 },
    },
    {
      // Containment, not byte equality: the live model may wrap the unique
      // marker in benign prose. The cancelled stream can never contain it.
      label: "recovery marker is durable",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textContains",
        text: CANCELLATION_RECOVERY,
        timeoutMs: 5000,
      },
    },
    {
      label: "recovery has no response-failure banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    { label: "cancellation recovery transcript", action: "snapshot", params: { scope: "chat" } },
  ],
  // Ownership intentionally survives the CLI-session boundary into phase two.
  cleanup: [],
};
