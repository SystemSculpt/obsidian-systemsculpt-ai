import {
  activityPhaseFromAgentRunStatus,
  activityPhaseFromWorkflowStatus,
  activityPhaseFromWorkflowStepStatus,
  createNodeActivity,
  edgeActivityFromSource,
  nodeActivityFromAgentRun,
  nodeActivityFromRunState,
} from "../StudioActivity";

const state = (status: "idle" | "pending" | "running" | "cached" | "succeeded" | "failed", extra?: { message?: string; progress?: number | null }) => ({
  status,
  message: extra?.message ?? "",
  updatedAt: null,
  outputs: null,
  progress: extra?.progress ?? null,
});

describe("Studio activity vocabulary", () => {
  it("maps a live graph run onto queued, active, and settled phases", () => {
    expect(nodeActivityFromRunState(state("idle"), "running").phase).toBe("idle");
    expect(nodeActivityFromRunState(state("pending"), "running").phase).toBe("queued");
    const active = nodeActivityFromRunState(state("running", { message: "Rendering", progress: 0.42 }), "running");
    expect(active).toEqual({ phase: "active", label: "Running", detail: "Rendering", progress: 0.42 });
    expect(nodeActivityFromRunState(state("cached", { message: "Cache hit" }), "running")).toEqual({ phase: "cached", label: "Cached", detail: "", progress: null });
    expect(nodeActivityFromRunState(state("succeeded", { message: "Completed" }), "success")).toEqual({ phase: "done", label: "Done", detail: "", progress: null });
    expect(nodeActivityFromRunState(state("failed", { message: "boom" }), "failed")).toEqual({ phase: "failed", label: "Failed", detail: "boom", progress: null });
  });

  it("leaves never-started nodes idle and marks interrupted ones once the run has ended", () => {
    expect(nodeActivityFromRunState(state("pending"), "failed").phase).toBe("idle");
    expect(nodeActivityFromRunState(state("running"), "success")).toMatchObject({ phase: "stopped", label: "Interrupted" });
  });

  it("clamps progress and keeps producer detail", () => {
    expect(createNodeActivity("active", { progress: 1.7 }).progress).toBe(1);
    expect(createNodeActivity("active", { progress: -1 }).progress).toBe(0);
    expect(createNodeActivity("active", { progress: Number.NaN }).progress).toBeNull();
    expect(createNodeActivity("waiting", { detail: "  approval  " }).detail).toBe("approval");
  });

  it("maps native Codex runs and workflow plans onto the same phases", () => {
    expect(activityPhaseFromAgentRunStatus("queued")).toBe("queued");
    expect(activityPhaseFromAgentRunStatus("running")).toBe("active");
    expect(activityPhaseFromAgentRunStatus("waiting")).toBe("waiting");
    expect(activityPhaseFromAgentRunStatus("completed")).toBe("done");
    expect(activityPhaseFromAgentRunStatus("failed")).toBe("failed");
    expect(activityPhaseFromAgentRunStatus("stopped")).toBe("stopped");
    expect(nodeActivityFromAgentRun({ status: "interrupted", currentActivity: "Previous Obsidian session ended" })).toEqual({ phase: "stopped", label: "Interrupted", detail: "Previous Obsidian session ended", progress: null });
    expect(nodeActivityFromAgentRun({ status: "running", currentActivity: "Codex is working" }).detail).toBe("Codex is working");
    expect(nodeActivityFromAgentRun({ status: "failed", currentActivity: "Stopped", error: "Transport lost" }).detail).toBe("Transport lost");
    expect(activityPhaseFromWorkflowStepStatus("pending")).toBe("queued");
    expect(activityPhaseFromWorkflowStepStatus("running")).toBe("active");
    expect(activityPhaseFromWorkflowStepStatus("completed")).toBe("done");
    expect(activityPhaseFromWorkflowStepStatus("blocked")).toBe("waiting");
    expect(activityPhaseFromWorkflowStepStatus("skipped")).toBe("stopped");
    expect(activityPhaseFromWorkflowStatus("needs_input")).toBe("waiting");
    expect(activityPhaseFromWorkflowStatus("completed")).toBe("done");
  });

  it("derives cable phases from the source node and the run lifecycle", () => {
    expect(edgeActivityFromSource("active", "running")).toBe("surging");
    expect(edgeActivityFromSource("waiting", "idle")).toBe("surging");
    expect(edgeActivityFromSource("done", "running")).toBe("delivered");
    expect(edgeActivityFromSource("cached", "success")).toBe("delivered");
    expect(edgeActivityFromSource("cached", "idle")).toBe("idle");
    expect(edgeActivityFromSource("failed", "failed")).toBe("failed");
    expect(edgeActivityFromSource("queued", "running")).toBe("idle");
    expect(edgeActivityFromSource("stopped", "failed")).toBe("idle");
  });
});
