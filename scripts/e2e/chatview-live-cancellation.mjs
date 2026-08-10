import phaseOne from "./chatview-live-cancellation-phase1.mjs";
import phaseTwo from "./chatview-live-cancellation-phase2.mjs";

export default {
  steps: [...phaseOne.steps, ...phaseTwo.steps],
  cleanup: phaseTwo.cleanup,
};
