import { createEmptyStudioProject } from "../../../studio/schema";
import {
  consumeStudioGraphUndoSnapshot,
  createStudioGraphHistoryState,
  preserveStudioGraphHistoryUndoSnapshot,
  resetStudioGraphHistory,
} from "../systemsculpt-studio-view/StudioGraphHistoryState";

describe("Studio graph history for project-file edits", () => {
  it("keeps the pending canvas as the next Undo after loading the file", () => {
    const canvasProject = createEmptyStudioProject({
      name: "Pending canvas",
      policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
      minPluginVersion: "6.0.2",
      maxRuns: 100,
      maxArtifactsMb: 1024,
    });
    const fileProject = JSON.parse(JSON.stringify(canvasProject));
    fileProject.name = "Current file";

    const history = createStudioGraphHistoryState();
    resetStudioGraphHistory(history, fileProject);
    preserveStudioGraphHistoryUndoSnapshot(history, canvasProject, [], 120);

    expect(consumeStudioGraphUndoSnapshot(history, 120)?.project.name).toBe("Pending canvas");
  });
});
