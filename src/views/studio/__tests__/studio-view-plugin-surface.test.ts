/** @jest-environment jsdom */

import { isPluginSurface } from "../../../core/ui/surface";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

const renderStudioView = (SystemSculptStudioView as any).prototype.render as (
  this: Record<string, any>,
) => void;

describe("SystemSculptStudioView Plugin surface", () => {
  it("mounts the persistent Studio root without changing graph geometry", () => {
    const contentEl = document.createElement("div");
    const geometry = document.createElement("div");
    geometry.className = "geometry-sentinel";
    geometry.style.width = "16000px";
    geometry.style.height = "10000px";
    geometry.style.transform = "translate(240px, 120px) scale(0.75)";

    const context = {
      captureGraphViewportState: jest.fn(),
      resetViewportScrollingState: jest.fn(),
      disposeTextNodeEditors: jest.fn(),
      graphInteraction: { clearRenderBindings: jest.fn() },
      nodeContextMenuOverlay: null,
      nodeActionContextMenuOverlay: null,
      nodeDragInProgress: true,
      clipboardAndDropController: { bindViewport: jest.fn() },
      graphViewportEl: document.createElement("div"),
      contentEl,
      lastError: null,
      projectFileWarning: null,
      renderGraphEditor: jest.fn((root: HTMLElement) => root.appendChild(geometry)),
    };

    renderStudioView.call(context);

    const root = contentEl.querySelector<HTMLElement>(".ss-studio-view");
    expect(root).not.toBeNull();
    expect(isPluginSurface(root!, "view")).toBe(true);
    expect(root?.contains(geometry)).toBe(true);
    expect(geometry.style.width).toBe("16000px");
    expect(geometry.style.height).toBe("10000px");
    expect(geometry.style.transform).toBe("translate(240px, 120px) scale(0.75)");
    expect(context.clipboardAndDropController.bindViewport).toHaveBeenCalledWith(null);
  });
});
