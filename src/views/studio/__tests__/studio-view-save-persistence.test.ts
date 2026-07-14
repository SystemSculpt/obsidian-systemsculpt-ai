/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";

type FlushContext = {
  projectSessionController: {
    flushPendingProjectSaveWork: jest.Mock<Promise<void>, [{ force?: boolean; showNotice?: boolean }?]>;
  };
};

type OnCloseContext = {
  detachWindowMigration: jest.Mock<void, []> | null;
  unbindOwnerWindowEvents: jest.Mock<void, []>;
  unbindVaultEvents: jest.Mock<void, []>;
  clipboardAndDropController: { dispose: jest.Mock<void, []> };
  clearLayoutSaveTimer: jest.Mock<void, []>;
  resetViewportScrollingState: jest.Mock<void, []>;
  projectSessionController: {
    close: jest.Mock<Promise<void>, []>;
  };
  nodeContextMenuOverlay: { destroy: jest.Mock<void, []> } | null;
  nodeActionContextMenuOverlay: { destroy: jest.Mock<void, []> } | null;
  graphViewportEl: HTMLElement | null;
  graphInteraction: {
    clearRenderBindings: jest.Mock<void, []>;
  };
  contentEl: {
    empty: jest.Mock<void, []>;
  };
};

const flushPendingProjectSaveWork = (SystemSculptStudioView as any).prototype
  .flushPendingProjectSaveWork as (
  this: FlushContext,
  options?: { force?: boolean; showNotice?: boolean }
) => Promise<void>;

const onClose = (SystemSculptStudioView as any).prototype.onClose as (
  this: OnCloseContext
) => Promise<void>;

describe("SystemSculptStudioView save persistence", () => {
  it("delegates pending save flushing to the project session controller", async () => {
    const context: FlushContext = {
      projectSessionController: {
        flushPendingProjectSaveWork: jest.fn(async () => {}),
      },
    };

    await flushPendingProjectSaveWork.call(context, { force: true, showNotice: true });

    expect(context.projectSessionController.flushPendingProjectSaveWork).toHaveBeenCalledWith({
      force: true,
      showNotice: true,
    });
  });

  it("closes through the project session controller and tears down UI overlays", async () => {
    const context: OnCloseContext = {
      detachWindowMigration: jest.fn(),
      unbindOwnerWindowEvents: jest.fn(),
      unbindVaultEvents: jest.fn(),
      clipboardAndDropController: { dispose: jest.fn() },
      clearLayoutSaveTimer: jest.fn(),
      resetViewportScrollingState: jest.fn(),
      projectSessionController: {
        close: jest.fn(async () => {}),
      },
      nodeContextMenuOverlay: { destroy: jest.fn() },
      nodeActionContextMenuOverlay: { destroy: jest.fn() },
      graphViewportEl: document.createElement("div"),
      graphInteraction: {
        clearRenderBindings: jest.fn(),
      },
      contentEl: {
        empty: jest.fn(),
      },
    };
    const nodeContextDestroy = context.nodeContextMenuOverlay?.destroy;
    const nodeActionDestroy = context.nodeActionContextMenuOverlay?.destroy;

    await onClose.call(context);

    expect(context.projectSessionController.close).toHaveBeenCalledTimes(1);
    expect(context.clipboardAndDropController.dispose).toHaveBeenCalledTimes(1);
    expect(nodeContextDestroy).toHaveBeenCalledTimes(1);
    expect(nodeActionDestroy).toHaveBeenCalledTimes(1);
    expect(context.graphViewportEl).toBeNull();
    expect(context.graphInteraction.clearRenderBindings).toHaveBeenCalledTimes(1);
    expect(context.contentEl.empty).toHaveBeenCalledTimes(1);
  });
});
