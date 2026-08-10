import {
  LATEST_DURABLE_ASSISTANT_TEXT,
} from "./chatview-development-state.mjs";
import {
  WORKER_RESTART_FIRST,
  WORKER_RESTART_MARKER,
  WORKER_RESTART_SECRET,
} from "./chatview-live-worker-restart-phase1.mjs";

export default {
  steps: [
    { label: "open owned Worker-restart chat", action: "chat.open" },
    {
      label: "reopen exact owned chat after Worker restart",
      action: "chat.reopenOwnedDevelopmentHistory",
      params: { timeoutMs: 10000 },
    },
    {
      label: "phase-one response survived exact history reopen",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textContains",
        text: WORKER_RESTART_FIRST,
        timeoutMs: 5000,
      },
    },
    {
      label: "submit follow-up after Worker restart",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: "This is the same conversation after the Worker restarted. "
          + "Without me restating it, reply with exactly the synthetic secret I asked you to "
          + "remember in my previous message and nothing else. Do not use tools.",
        submit: true,
      },
    },
    {
      label: "Worker-restart follow-up completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: 180000 },
    },
    {
      label: "Worker-restart follow-up marker is durable",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textContains",
        text: WORKER_RESTART_SECRET,
        timeoutMs: 5000,
      },
    },
    {
      label: "no response failure after Worker restart",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    { label: "Worker-restart phase two transcript", action: "snapshot", params: { scope: "chat" } },
  ],
  cleanup: [
    {
      label: "reset exact Worker-restart state",
      action: "chat.resetDevelopmentState",
      params: {
        marker: WORKER_RESTART_MARKER,
        trashSavedChat: true,
        requireOwned: true,
      },
    },
  ],
};
