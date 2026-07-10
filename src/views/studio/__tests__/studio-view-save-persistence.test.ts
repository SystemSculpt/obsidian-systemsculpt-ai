/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";

type FlushPendingSaveContext = {
  currentProjectSession: {
    flushPendingSaveWork: jest.Mock<Promise<void>, [{ force?: boolean }?]>;
  } | null;
  projectLiveSyncWarning: string | null;
  setError: jest.Mock<void, [unknown]>;
  processPendingExternalProjectSync: jest.Mock<void, []>;
};

type OnCloseContext = {
  onWindowKeyDown: (event: KeyboardEvent) => void;
  onWindowPaste: (event: ClipboardEvent) => void;
  unbindVaultEvents: jest.Mock<void, []>;
  graphClipboardPayload: unknown;
  graphClipboardPasteCount: number;
  resetProjectHistory: jest.Mock<void, [null]>;
  captureGraphViewportState: jest.Mock<void, []>;
  app: {
    workspace: {
      requestSaveLayout: jest.Mock<void, []>;
    };
  };
  flushPendingProjectSaveWork: jest.Mock<Promise<void>, []>;
  flushTextNodeEditorsBeforeProjectTransition: () => Promise<void>;
  releaseRetainedProjectSession: jest.Mock<Promise<void>, []>;
  clearSaveTimer: jest.Mock<void, []>;
  clearLayoutSaveTimer: jest.Mock<void, []>;
  resetViewportScrollingState: jest.Mock<void, []>;
  runPresentation: {
    reset: jest.Mock<void, []>;
  };
  clearProjectLiveSyncState: jest.Mock<void, []>;
  currentProjectSession: Record<string, unknown> | null;
  currentProjectPath: string | null;
  currentProject: Record<string, unknown> | null;
  editingTextNodeIds: Set<string>;
  dirtyTextNodeEditIds: Set<string>;
  pendingTextNodeAutofocusNodeId: string | null;
  pendingTextNodeFocusPointByNodeId: Map<string, { x: number; y: number }>;
  textNodeEditorSnapshots: Map<string, unknown>;
  disposeTextNodeEditors: jest.Mock<void, []>;
  inspectorOverlay: { destroy: jest.Mock<void, []> } | null;
  nodeContextMenuOverlay: { destroy: jest.Mock<void, []> } | null;
  nodeActionContextMenuOverlay: { destroy: jest.Mock<void, []> } | null;
  pendingViewportState: Record<string, unknown> | null;
  graphViewportEl: HTMLElement | null;
  graphViewportProjectPath: string | null;
  lastGraphPointerPosition: { x: number; y: number } | null;
  clearTerminalMounts: jest.Mock<void, []>;
  graphInteraction: {
    clearRenderBindings: jest.Mock<void, []>;
  };
  contentEl: {
    empty: jest.Mock<void, []>;
  };
};

const flushPendingProjectSaveWork = (SystemSculptStudioView as any).prototype
  .flushPendingProjectSaveWork as (
  this: FlushPendingSaveContext,
  options?: { force?: boolean; showNotice?: boolean }
) => Promise<void>;

const onClose = (SystemSculptStudioView as any).prototype.onClose as (
  this: OnCloseContext
) => Promise<void>;
const flushTextNodeEditorsBeforeProjectTransition = (SystemSculptStudioView as any)
  .prototype.flushTextNodeEditorsBeforeProjectTransition as (
  this: Pick<OnCloseContext, "disposeTextNodeEditors" | "flushPendingProjectSaveWork">
) => Promise<void>;

function createFlushContext(
  overrides: Partial<FlushPendingSaveContext> = {}
): FlushPendingSaveContext {
  return {
    currentProjectSession: {
      flushPendingSaveWork: jest.fn(async () => {}),
    },
    projectLiveSyncWarning: "Unsaved changes pending",
    setError: jest.fn(),
    processPendingExternalProjectSync: jest.fn(),
    ...overrides,
  };
}

function createOnCloseContext(): OnCloseContext {
  return {
    onWindowKeyDown: () => undefined,
    onWindowPaste: () => undefined,
    unbindVaultEvents: jest.fn(),
    graphClipboardPayload: { kind: "test" },
    graphClipboardPasteCount: 3,
    resetProjectHistory: jest.fn(),
    captureGraphViewportState: jest.fn(),
    app: {
      workspace: {
        requestSaveLayout: jest.fn(),
      },
    },
    flushPendingProjectSaveWork: jest.fn(async () => {}),
    flushTextNodeEditorsBeforeProjectTransition,
    releaseRetainedProjectSession: jest.fn(async () => {}),
    clearSaveTimer: jest.fn(),
    clearLayoutSaveTimer: jest.fn(),
    resetViewportScrollingState: jest.fn(),
    runPresentation: {
      reset: jest.fn(),
    },
    clearProjectLiveSyncState: jest.fn(),
    currentProjectSession: { path: "SystemSculpt/Studio/Test.systemsculpt" },
    currentProjectPath: "SystemSculpt/Studio/Test.systemsculpt",
    currentProject: { graph: { nodes: [] } },
    editingTextNodeIds: new Set(["node-a"]),
    dirtyTextNodeEditIds: new Set(["node-a"]),
    pendingTextNodeAutofocusNodeId: "node-a",
    pendingTextNodeFocusPointByNodeId: new Map([["node-a", { x: 10, y: 20 }]]),
    textNodeEditorSnapshots: new Map([["node-a", { focused: true }]]),
    disposeTextNodeEditors: jest.fn(),
    inspectorOverlay: { destroy: jest.fn() },
    nodeContextMenuOverlay: { destroy: jest.fn() },
    nodeActionContextMenuOverlay: { destroy: jest.fn() },
    pendingViewportState: { zoom: 1 },
    graphViewportEl: document.createElement("div"),
    graphViewportProjectPath: "SystemSculpt/Studio/Test.systemsculpt",
    lastGraphPointerPosition: { x: 10, y: 20 },
    clearTerminalMounts: jest.fn(),
    graphInteraction: {
      clearRenderBindings: jest.fn(),
    },
    contentEl: {
      empty: jest.fn(),
    },
  };
}

describe("SystemSculptStudioView save persistence", () => {
  it("delegates pending save flushing to the active Studio project session", async () => {
    const context = createFlushContext();

    await flushPendingProjectSaveWork.call(context, { force: true });

    expect(context.currentProjectSession?.flushPendingSaveWork).toHaveBeenCalledTimes(1);
    expect(context.currentProjectSession?.flushPendingSaveWork).toHaveBeenCalledWith({ force: true });
    expect(context.projectLiveSyncWarning).toBeNull();
    expect(context.processPendingExternalProjectSync).toHaveBeenCalledTimes(1);
  });

  it("commits live text editors before flushing a project transition", async () => {
    const context = createOnCloseContext();

    await context.flushTextNodeEditorsBeforeProjectTransition.call(context);

    expect(context.disposeTextNodeEditors).toHaveBeenCalledTimes(1);
    expect(context.flushPendingProjectSaveWork).toHaveBeenCalledTimes(1);
    expect(context.disposeTextNodeEditors.mock.invocationCallOrder[0]).toBeLessThan(
      context.flushPendingProjectSaveWork.mock.invocationCallOrder[0]
    );
  });

  it("captures layout and clears the active project session when the Studio view closes", async () => {
    const context = createOnCloseContext();

    await onClose.call(context);

    expect(context.flushPendingProjectSaveWork).toHaveBeenCalledTimes(1);
    expect(context.releaseRetainedProjectSession).toHaveBeenCalledTimes(1);
    expect(context.captureGraphViewportState).toHaveBeenCalledTimes(1);
    expect(context.disposeTextNodeEditors).toHaveBeenCalledTimes(1);
    expect(context.app.workspace.requestSaveLayout).toHaveBeenCalledTimes(1);
    expect(context.currentProjectSession).toBeNull();
    expect(context.currentProjectPath).toBeNull();
    expect(context.currentProject).toBeNull();
    expect(context.contentEl.empty).toHaveBeenCalledTimes(1);
  });
});
