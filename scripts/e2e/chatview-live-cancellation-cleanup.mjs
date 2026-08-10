import {
  CANCELLATION_MARKER,
} from "./chatview-live-cancellation-phase1.mjs";

export default {
  steps: [],
  cleanup: [
    {
      label: "emergency reset exact cancellation state",
      action: "chat.resetDevelopmentState",
      params: {
        marker: CANCELLATION_MARKER,
        trashSavedChat: true,
        requireOwned: true,
      },
    },
  ],
};
