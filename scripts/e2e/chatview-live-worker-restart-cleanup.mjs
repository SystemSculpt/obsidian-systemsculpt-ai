import {
  WORKER_RESTART_MARKER,
} from "./chatview-live-worker-restart-phase1.mjs";

export default {
  steps: [],
  cleanup: [
    {
      label: "emergency reset exact Worker-restart state",
      action: "chat.resetDevelopmentState",
      params: {
        marker: WORKER_RESTART_MARKER,
        trashSavedChat: true,
        requireOwned: true,
      },
    },
  ],
};
