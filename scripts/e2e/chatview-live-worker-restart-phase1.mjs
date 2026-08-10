import {
  LATEST_DURABLE_ASSISTANT_TEXT,
} from "./chatview-development-state.mjs";

export const WORKER_RESTART_MARKER = "SS-DEV-TEST-OPSRESTART1";
export const WORKER_RESTART_FIRST = "OPS-RESTART-FIRST-1";
export const WORKER_RESTART_SECRET = "OPS-RESTART-SECRET-7J4Q";

export default {
  steps: [
    { label: "open chat", action: "chat.open" },
    {
      label: "begin owned Worker-restart state",
      action: "chat.beginDevelopmentState",
      params: { marker: WORKER_RESTART_MARKER },
    },
    {
      label: "submit first Worker-restart turn",
      action: "chat.typeDevelopmentDraft",
      params: {
        text: `Remember this exact synthetic secret for my next message: ${WORKER_RESTART_SECRET}. `
          + `For this message, reply with exactly ${WORKER_RESTART_FIRST} and nothing else. `
          + "Do not use tools.",
        submit: true,
      },
    },
    {
      label: "first Worker-restart turn completes",
      action: "chat.waitForDevelopmentRun",
      params: { until: "complete", timeoutMs: 180000 },
    },
    {
      label: "first Worker-restart marker is durable",
      action: "waitFor",
      params: {
        target: LATEST_DURABLE_ASSISTANT_TEXT,
        state: "textContains",
        text: WORKER_RESTART_FIRST,
        timeoutMs: 5000,
      },
    },
    {
      label: "first Worker-restart turn has no response-failure banner",
      action: "waitFor",
      params: {
        target: "chat:.systemsculpt-agent-banner",
        state: "hidden",
        timeoutMs: 2000,
      },
    },
    { label: "Worker-restart phase one transcript", action: "snapshot", params: { scope: "chat" } },
  ],
  // Restart only the local Worker after this phase. Keep Obsidian loaded so the
  // exact driver ownership and saved-chat identity remain available to phase two.
  cleanup: [],
};
