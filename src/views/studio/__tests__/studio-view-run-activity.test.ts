import { SystemSculptStudioView } from "../SystemSculptStudioView";
import type { StudioRunEvent } from "../../../studio/types";

const handleRunEvent = (SystemSculptStudioView as any).prototype.handleRunEvent as (this: unknown, event: StudioRunEvent) => void;

function context(overrides?: Record<string, unknown>) {
  return {
    runPresentation: { applyEvent: jest.fn() },
    materializeManagedOutputPlaceholders: jest.fn(() => false),
    removePendingManagedOutputPlaceholders: jest.fn(() => false),
    syncInlineTextOutputToNodeConfig: jest.fn(),
    syncDatasetOutputFieldsToNodeConfig: jest.fn(),
    materializeManagedOutputNodes: jest.fn(),
    logStudioConsoleError: jest.fn(),
    activity: { refresh: jest.fn() },
    render: jest.fn(),
    currentProjectPath: "A.systemsculpt",
    ...overrides,
  };
}

const AT = "2026-09-13T00:00:00.000Z";

describe("SystemSculptStudioView run events and activity", () => {
  it("patches activity in place for progress and start events instead of rebuilding the canvas", () => {
    const ctx = context();
    handleRunEvent.call(ctx, { type: "node.started", runId: "r", nodeId: "n1", at: AT });
    handleRunEvent.call(ctx, { type: "node.progress", runId: "r", nodeId: "n1", percent: 50, at: AT });
    handleRunEvent.call(ctx, { type: "node.cache_hit", runId: "r", nodeId: "n1", cacheUpdatedAt: AT, at: AT });
    handleRunEvent.call(ctx, { type: "node.failed", runId: "r", nodeId: "n1", error: "boom", at: AT });
    expect(ctx.runPresentation.applyEvent).toHaveBeenCalledTimes(4);
    expect(ctx.activity.refresh).toHaveBeenCalledTimes(4);
    expect(ctx.render).not.toHaveBeenCalled();
  });

  it("rebuilds the canvas when the graph itself changes", () => {
    const ctx = context();
    handleRunEvent.call(ctx, { type: "run.started", runId: "r", at: AT });
    handleRunEvent.call(ctx, { type: "node.output", runId: "r", nodeId: "n1", outputRef: "ref", outputs: {}, at: AT } as StudioRunEvent);
    handleRunEvent.call(ctx, { type: "run.completed", runId: "r", status: "success", at: AT });
    expect(ctx.render).toHaveBeenCalledTimes(3);
    expect(ctx.activity.refresh).not.toHaveBeenCalled();
  });

  it("rebuilds when a start event materializes managed placeholders", () => {
    const ctx = context({ materializeManagedOutputPlaceholders: jest.fn(() => true) });
    handleRunEvent.call(ctx, { type: "node.started", runId: "r", nodeId: "n1", at: AT });
    expect(ctx.render).toHaveBeenCalledTimes(1);
    expect(ctx.activity.refresh).not.toHaveBeenCalled();
  });
});
