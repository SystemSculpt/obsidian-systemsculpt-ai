/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";

const renderStudioView = (SystemSculptStudioView as any).prototype.render as (
  this: Record<string, any>,
) => void;

describe("SystemSculptStudioView Plugin surface", () => {
  it("does not remount the graph when asynchronous work completes after close starts", () => {
    const contentEl = document.createElement("div");
    const context = {
      closed: true,
      contentEl,
      shapeController: { cancelDrawGesture: jest.fn(), registerLayerHandle: jest.fn() },
      automaticLayout: { dispose: jest.fn() },
      captureGraphViewportState: jest.fn(),
      resetViewportScrollingState: jest.fn(),
      disposeTextNodeEditors: jest.fn(),
      outputContainers: { dispose: jest.fn() },
      graphInteraction: { clearRenderBindings: jest.fn() },
      clipboardAndDropController: { bindViewport: jest.fn() },
      renderGraphEditor: jest.fn(),
      activity: { project: jest.fn(), apply: jest.fn() },
    };
    renderStudioView.call(context);
    expect(context.renderGraphEditor).not.toHaveBeenCalled();
    expect(contentEl.childElementCount).toBe(0);
  });

  it("keeps the migration notice and Try again action until retry unlocks the shared session", async () => {
    let reason: string | undefined = "Read-only: Studio couldn't save the original copy. The project file is unchanged.";
    let finishRetry!: () => void;
    const load = jest.fn(() => new Promise<void>(resolve => { finishRetry = resolve; }));
    const context: Record<string, any> = {
      contentEl: document.createElement("div"),
      currentProjectPath: "Studio/Legacy.systemsculpt",
      currentProjectSession: { getReadOnlyReason: () => reason },
      imageEditing: { editingNodeId: null },
      projectSessionController: { loadProjectFromPath: load },
      shapeController: { cancelDrawGesture: jest.fn(), registerLayerHandle: jest.fn() },
      captureGraphViewportState: jest.fn(), resetViewportScrollingState: jest.fn(), disposeTextNodeEditors: jest.fn(),
      outputContainers: { dispose: jest.fn() }, graphInteraction: { clearRenderBindings: jest.fn() },
      clipboardAndDropController: { bindViewport: jest.fn() },
      renderGraphEditor: jest.fn(), activity: { project: jest.fn(), apply: jest.fn() },
      lastError: null, projectFileWarning: null,
    };
    context.render = () => renderStudioView.call(context);
    context.retryMigration = (SystemSculptStudioView as any).prototype.retryMigration.bind(context);
    context.render();
    const button = () => context.contentEl.querySelector('[data-testid="studio.migration.retry"]') as HTMLButtonElement;
    expect(context.contentEl.textContent).toContain(reason);
    expect(button().textContent).toBe("Try again");
    button().click();
    expect(load).toHaveBeenCalledWith("Studio/Legacy.systemsculpt", { forceReload: true });
    expect(button().disabled).toBe(true);
    finishRetry();
    await Promise.resolve();
    expect(button().disabled).toBe(false);
    expect(context.contentEl.textContent).toContain(reason);
    button().click();
    reason = undefined;
    finishRetry();
    await Promise.resolve();
    expect(button()).toBeNull();
    expect(context.contentEl.querySelector(".ss-studio-warning")).toBeNull();
  });

  it("mounts the persistent Studio root without changing graph geometry", () => {
    const contentEl = document.createElement("div");
    const geometry = document.createElement("div");
    geometry.className = "geometry-sentinel";
    geometry.style.width = "16000px";
    geometry.style.height = "10000px";
    geometry.style.transform = "translate(240px, 120px) scale(0.75)";

    const context = {
      shapeController: { cancelDrawGesture: jest.fn(), registerLayerHandle: jest.fn() },
      automaticLayout: { dispose: jest.fn() },
      captureGraphViewportState: jest.fn(),
      resetViewportScrollingState: jest.fn(),
      disposeTextNodeEditors: jest.fn(),
      outputContainers: { dispose: jest.fn() },
      graphInteraction: { clearRenderBindings: jest.fn() },
      nodeContextMenuOverlay: null,
      nodeActionContextMenuOverlay: null,
      nodeDragInProgress: true,
      imageEditing: { editingNodeId: null },
      clipboardAndDropController: { bindViewport: jest.fn() },
      graphViewportEl: document.createElement("div"),
      contentEl,
      lastError: null,
      projectFileWarning: null,
      renderGraphEditor: jest.fn((root: HTMLElement) => root.appendChild(geometry)),
      activity: { project: jest.fn(), apply: jest.fn() },
    };

    renderStudioView.call(context);

    const root = contentEl.querySelector<HTMLElement>(".ss-studio-view");
    expect(root).not.toBeNull();
    expect(root?.classList.contains("ss-surface")).toBe(true);
    expect(root?.getAttribute("data-ss-surface")).toBe("view");
    expect(root?.contains(geometry)).toBe(true);
    expect(geometry.style.width).toBe("16000px");
    expect(geometry.style.height).toBe("10000px");
    expect(geometry.style.transform).toBe("translate(240px, 120px) scale(0.75)");
    expect(context.clipboardAndDropController.bindViewport).toHaveBeenCalledWith(null);
    // Activity is projected before the graph paints and applied once the DOM exists.
    expect(context.activity.project).toHaveBeenCalledTimes(1);
    expect(context.activity.apply).toHaveBeenCalledTimes(1);
    expect(context.renderGraphEditor.mock.invocationCallOrder[0]).toBeGreaterThan(context.activity.project.mock.invocationCallOrder[0]);
    expect(context.activity.apply.mock.invocationCallOrder[0]).toBeGreaterThan(context.renderGraphEditor.mock.invocationCallOrder[0]);
  });
});
