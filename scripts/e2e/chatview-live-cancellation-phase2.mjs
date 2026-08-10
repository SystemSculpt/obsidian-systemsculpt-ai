import {
  CANCELLATION_MARKER,
  CANCELLATION_RECOVERY,
} from "./chatview-live-cancellation-phase1.mjs";
import {
  LATEST_DURABLE_ASSISTANT_TEXT,
} from "./chatview-development-state.mjs";

export default {
  steps: [
    { label: "open cancellation chat", action: "chat.open" },
    {
      label: "reopen exact owned cancellation chat through visible history",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    {
      label: "reopened cancellation remains visibly terminal",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-turn.is-assistant:not(.is-active) "
          + ".systemsculpt-agent-tail-status.is-cancelled",
        state: "textEquals",
        text: "Stopped",
        timeoutMs: 5000,
      },
    },
    {
      // Containment, not byte equality: the recovery reply may wrap the unique
      // marker in benign prose. The fenced cancelled stream (numbered lines)
      // can never contain the marker, so containment still proves the fence.
      label: "late output stayed fenced after exact history reopen",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textContains",
        text: CANCELLATION_RECOVERY,
        timeoutMs: 5000,
      },
    },
    {
      label: "no response failure after cancellation recovery",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    { label: "late-fence transcript", action: "snapshot", params: { scope: "chat" } },
  ],
  cleanup: [
    {
      label: "reset exact cancellation state",
      action: "chat.resetDevelopmentState",
      params: {
        marker: CANCELLATION_MARKER,
        trashSavedChat: true,
        requireOwned: true,
      },
    },
  ],
};
