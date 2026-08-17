/**
 * @jest-environment jsdom
 */
import type { StudioProjectV1 } from "../../../../studio/types";
import { renderStudioGraphWorkspace } from "../StudioGraphWorkspaceRenderer";

function projectFixture(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_controls",
    name: "Controls",
    createdAt: "2026-03-03T00:00:00.000Z",
    updatedAt: "2026-03-03T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [],
      edges: [],
      entryNodeIds: [],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/Controls.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: {
        maxRuns: 100,
        maxArtifactsMb: 1024,
      },
    },
    migrations: {
      projectSchemaVersion: "1.0.0",
      applied: [],
    },
  };
}

function shapeLayerStub() {
  return {
    selection: { shapeIds: [], arrowIds: [] },
    onSelect: jest.fn(),
    onMoveSelection: jest.fn(),
    onResizeShape: jest.fn(),
    onLabelChange: jest.fn(),
    onConnectShapes: jest.fn(),
    registerLayerHandle: jest.fn(),
  };
}

function createPointerDown(pointerType: string): MouseEvent {
  const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

describe("StudioGraphWorkspaceRenderer controls", () => {
  it("wires right-ribbon control callbacks", () => {
    const root = document.createElement("div");
    const runSpy = jest.fn();
    const addSpy = jest.fn();
    const zoomInSpy = jest.fn();
    const zoomOutSpy = jest.fn();
    const zoomResetSpy = jest.fn();
    const zoomOverviewSpy = jest.fn();
    const toggleDetailSpy = jest.fn();
    const zoomLabel = { value: "" };

    renderStudioGraphWorkspace({
      root,
      busy: false,
      currentProject: projectFixture(),
      currentProjectPath: "SystemSculpt/Studio/Controls.systemsculpt",
      nodeDetailMode: "expanded",
      graphInteraction: {
        registerViewportElement: jest.fn(),
        handleGraphViewportWheel: jest.fn(),
        startMarqueeSelection: jest.fn(),
        startCanvasPan: jest.fn(),
        getGraphZoom: () => 1,
        registerSurfaceElement: jest.fn(),
        registerCanvasElement: jest.fn(),
        registerMarqueeElement: jest.fn(),
        registerSnapGuidesElement: jest.fn(),
        clearGraphElementMaps: jest.fn(),
        registerEdgesLayerElement: jest.fn(),
        renderGroupLayer: jest.fn(),
        refreshNodeSelectionClasses: jest.fn(),
        applyGraphZoom: jest.fn(),
        refreshSelectionResizeFrame: jest.fn(),
        registerZoomLabelElement: (label: HTMLElement) => {
          label.setText("100%");
          zoomLabel.value = label.textContent || "";
        },
      } as any,
      getNodeRunState: () => ({
        status: "idle",
        message: "",
        updatedAt: null,
        outputs: null,
      }),
      findNodeDefinition: () => null,
      onRunGraph: runSpy,
      onOpenAddNodeMenuAtViewportCenter: addSpy,
      activeCanvasTool: "select",
      onSelectCanvasTool: jest.fn(),
      shapeLayer: shapeLayerStub(),
      onZoomIn: zoomInSpy,
      onZoomOut: zoomOutSpy,
      onZoomReset: zoomResetSpy,
      onZoomOverview: zoomOverviewSpy,
      onToggleNodeDetailMode: toggleDetailSpy,
      onOpenNodeContextMenu: jest.fn(),
      onCreateTextNodeAtPosition: jest.fn(),
      onRunNode: jest.fn(),
      onCopyTextGenerationPromptBundle: jest.fn(),
      onToggleTextGenerationOutputLock: jest.fn(),
      onRemoveNode: jest.fn(),
      onNodeTitleInput: jest.fn(),
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      isTextNodeEditing: () => false,
      consumeTextNodeAutoFocus: () => false,
      consumeTextNodeFocusPoint: () => undefined,
      consumeTextNodeEditorSnapshot: () => undefined,
      onRequestTextNodeEdit: jest.fn(),
      onStopTextNodeEdit: jest.fn(),
      onRevealPathInFinder: jest.fn(),
    });

    const click = (selector: string): void => {
      const button = root.querySelector<HTMLButtonElement>(selector);
      expect(button).toBeDefined();
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };

    click('button[aria-label="Run Studio graph"]');
    click('button[aria-label="Add node"]');
    click('button[aria-label="Zoom out"]');
    click('button[aria-label="Zoom in"]');
    click('button[aria-label="Reset zoom"]');
    click('button[aria-label="Overview graph"]');
    click('button[aria-label="Toggle node detail mode"]');

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(zoomOutSpy).toHaveBeenCalledTimes(1);
    expect(zoomInSpy).toHaveBeenCalledTimes(1);
    expect(zoomResetSpy).toHaveBeenCalledTimes(1);
    expect(zoomOverviewSpy).toHaveBeenCalledTimes(1);
    expect(toggleDetailSpy).toHaveBeenCalledTimes(1);
    expect(zoomLabel.value).toBe("100%");

    const controls = Array.from(
      root.querySelectorAll<HTMLButtonElement>(
        ".ss-studio-graph-workspace-control-row:not(.is-tools) .ss-studio-graph-workspace-control-button",
      ),
    );
    expect(controls).toHaveLength(7);
    expect(controls.every((button) => button.classList.contains("ss-button"))).toBe(true);
    expect(controls.every((button) => button.classList.contains("ss-button--small"))).toBe(true);
    expect(
      root.querySelector('[aria-label="Toggle node detail mode"]')?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("forwards wheel events from the graph viewport", () => {
    const root = document.createElement("div");
    const wheelSpy = jest.fn();

    const renderResult = renderStudioGraphWorkspace({
      root,
      busy: false,
      currentProject: projectFixture(),
      currentProjectPath: "SystemSculpt/Studio/Controls.systemsculpt",
      nodeDetailMode: "expanded",
      graphInteraction: {
        registerViewportElement: jest.fn(),
        handleGraphViewportWheel: wheelSpy,
        startMarqueeSelection: jest.fn(),
        startCanvasPan: jest.fn(),
        getGraphZoom: () => 1,
        registerSurfaceElement: jest.fn(),
        registerCanvasElement: jest.fn(),
        registerMarqueeElement: jest.fn(),
        registerSnapGuidesElement: jest.fn(),
        clearGraphElementMaps: jest.fn(),
        registerEdgesLayerElement: jest.fn(),
        renderGroupLayer: jest.fn(),
        refreshNodeSelectionClasses: jest.fn(),
        applyGraphZoom: jest.fn(),
        refreshSelectionResizeFrame: jest.fn(),
        registerZoomLabelElement: jest.fn(),
      } as any,
      getNodeRunState: () => ({
        status: "idle",
        message: "",
        updatedAt: null,
        outputs: null,
      }),
      findNodeDefinition: () => null,
      onRunGraph: jest.fn(),
      onOpenAddNodeMenuAtViewportCenter: jest.fn(),
      activeCanvasTool: "select",
      onSelectCanvasTool: jest.fn(),
      shapeLayer: shapeLayerStub(),
      onZoomIn: jest.fn(),
      onZoomOut: jest.fn(),
      onZoomReset: jest.fn(),
      onZoomOverview: jest.fn(),
      onToggleNodeDetailMode: jest.fn(),
      onOpenNodeContextMenu: jest.fn(),
      onCreateTextNodeAtPosition: jest.fn(),
      onRunNode: jest.fn(),
      onCopyTextGenerationPromptBundle: jest.fn(),
      onToggleTextGenerationOutputLock: jest.fn(),
      onRemoveNode: jest.fn(),
      onNodeTitleInput: jest.fn(),
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      isTextNodeEditing: () => false,
      consumeTextNodeAutoFocus: () => false,
      consumeTextNodeFocusPoint: () => undefined,
      consumeTextNodeEditorSnapshot: () => undefined,
      onRequestTextNodeEdit: jest.fn(),
      onStopTextNodeEdit: jest.fn(),
      onRevealPathInFinder: jest.fn(),
    });

    const viewport = renderResult.viewportEl;
    expect(viewport).not.toBeNull();
    viewport?.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 48,
      })
    );

    expect(wheelSpy).toHaveBeenCalledTimes(1);
  });

  it("starts marquee selection for mouse and pen pointers on empty canvas", () => {
    const root = document.createElement("div");
    const startMarqueeSelection = jest.fn();
    const startCanvasPan = jest.fn();

    const renderResult = renderStudioGraphWorkspace({
      root,
      busy: false,
      currentProject: projectFixture(),
      currentProjectPath: "SystemSculpt/Studio/Controls.systemsculpt",
      nodeDetailMode: "expanded",
      graphInteraction: {
        registerViewportElement: jest.fn(),
        handleGraphViewportWheel: jest.fn(),
        startMarqueeSelection,
        startCanvasPan,
        getGraphZoom: () => 1,
        registerSurfaceElement: jest.fn(),
        registerCanvasElement: jest.fn(),
        registerMarqueeElement: jest.fn(),
        registerSnapGuidesElement: jest.fn(),
        clearGraphElementMaps: jest.fn(),
        registerEdgesLayerElement: jest.fn(),
        renderGroupLayer: jest.fn(),
        refreshNodeSelectionClasses: jest.fn(),
        applyGraphZoom: jest.fn(),
        refreshSelectionResizeFrame: jest.fn(),
        registerZoomLabelElement: jest.fn(),
      } as any,
      getNodeRunState: () => ({
        status: "idle",
        message: "",
        updatedAt: null,
        outputs: null,
      }),
      findNodeDefinition: () => null,
      onRunGraph: jest.fn(),
      onOpenAddNodeMenuAtViewportCenter: jest.fn(),
      activeCanvasTool: "select",
      onSelectCanvasTool: jest.fn(),
      shapeLayer: shapeLayerStub(),
      onZoomIn: jest.fn(),
      onZoomOut: jest.fn(),
      onZoomReset: jest.fn(),
      onZoomOverview: jest.fn(),
      onToggleNodeDetailMode: jest.fn(),
      onOpenNodeContextMenu: jest.fn(),
      onCreateTextNodeAtPosition: jest.fn(),
      onRunNode: jest.fn(),
      onCopyTextGenerationPromptBundle: jest.fn(),
      onToggleTextGenerationOutputLock: jest.fn(),
      onRemoveNode: jest.fn(),
      onNodeTitleInput: jest.fn(),
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      isTextNodeEditing: () => false,
      consumeTextNodeAutoFocus: () => false,
      consumeTextNodeFocusPoint: () => undefined,
      consumeTextNodeEditorSnapshot: () => undefined,
      onRequestTextNodeEdit: jest.fn(),
      onStopTextNodeEdit: jest.fn(),
      onRevealPathInFinder: jest.fn(),
    });

    const viewport = renderResult.viewportEl;
    expect(viewport).not.toBeNull();
    viewport?.dispatchEvent(createPointerDown("mouse"));
    viewport?.dispatchEvent(createPointerDown("pen"));

    expect(startMarqueeSelection).toHaveBeenCalledTimes(2);
    expect(startCanvasPan).not.toHaveBeenCalled();
  });

  it("starts touch panning instead of marquee selection for touch pointers on empty canvas", () => {
    const root = document.createElement("div");
    const startMarqueeSelection = jest.fn();
    const startCanvasPan = jest.fn();

    const renderResult = renderStudioGraphWorkspace({
      root,
      busy: false,
      currentProject: projectFixture(),
      currentProjectPath: "SystemSculpt/Studio/Controls.systemsculpt",
      nodeDetailMode: "expanded",
      graphInteraction: {
        registerViewportElement: jest.fn(),
        handleGraphViewportWheel: jest.fn(),
        startMarqueeSelection,
        startCanvasPan,
        getGraphZoom: () => 1,
        registerSurfaceElement: jest.fn(),
        registerCanvasElement: jest.fn(),
        registerMarqueeElement: jest.fn(),
        registerSnapGuidesElement: jest.fn(),
        clearGraphElementMaps: jest.fn(),
        registerEdgesLayerElement: jest.fn(),
        renderGroupLayer: jest.fn(),
        refreshNodeSelectionClasses: jest.fn(),
        applyGraphZoom: jest.fn(),
        refreshSelectionResizeFrame: jest.fn(),
        registerZoomLabelElement: jest.fn(),
      } as any,
      getNodeRunState: () => ({
        status: "idle",
        message: "",
        updatedAt: null,
        outputs: null,
      }),
      findNodeDefinition: () => null,
      onRunGraph: jest.fn(),
      onOpenAddNodeMenuAtViewportCenter: jest.fn(),
      activeCanvasTool: "select",
      onSelectCanvasTool: jest.fn(),
      shapeLayer: shapeLayerStub(),
      onZoomIn: jest.fn(),
      onZoomOut: jest.fn(),
      onZoomReset: jest.fn(),
      onZoomOverview: jest.fn(),
      onToggleNodeDetailMode: jest.fn(),
      onOpenNodeContextMenu: jest.fn(),
      onCreateTextNodeAtPosition: jest.fn(),
      onRunNode: jest.fn(),
      onCopyTextGenerationPromptBundle: jest.fn(),
      onToggleTextGenerationOutputLock: jest.fn(),
      onRemoveNode: jest.fn(),
      onNodeTitleInput: jest.fn(),
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      isTextNodeEditing: () => false,
      consumeTextNodeAutoFocus: () => false,
      consumeTextNodeFocusPoint: () => undefined,
      consumeTextNodeEditorSnapshot: () => undefined,
      onRequestTextNodeEdit: jest.fn(),
      onStopTextNodeEdit: jest.fn(),
      onRevealPathInFinder: jest.fn(),
    });

    const viewport = renderResult.viewportEl;
    expect(viewport).not.toBeNull();
    viewport?.dispatchEvent(createPointerDown("touch"));

    expect(startCanvasPan).toHaveBeenCalledTimes(1);
    expect(startMarqueeSelection).not.toHaveBeenCalled();
  });

  it("renders the diagram tools row and arms/disarms tools", () => {
    const root = document.createElement("div");
    const selectToolSpy = jest.fn();

    const renderResult = renderStudioGraphWorkspace({
      root,
      busy: false,
      currentProject: projectFixture(),
      currentProjectPath: "SystemSculpt/Studio/Controls.systemsculpt",
      nodeDetailMode: "expanded",
      graphInteraction: {
        registerViewportElement: jest.fn(),
        handleGraphViewportWheel: jest.fn(),
        startMarqueeSelection: jest.fn(),
        startCanvasPan: jest.fn(),
        getGraphZoom: () => 1,
        registerSurfaceElement: jest.fn(),
        registerCanvasElement: jest.fn(),
        registerMarqueeElement: jest.fn(),
        registerSnapGuidesElement: jest.fn(),
        clearGraphElementMaps: jest.fn(),
        registerEdgesLayerElement: jest.fn(),
        renderGroupLayer: jest.fn(),
        refreshNodeSelectionClasses: jest.fn(),
        applyGraphZoom: jest.fn(),
        refreshSelectionResizeFrame: jest.fn(),
        registerZoomLabelElement: jest.fn(),
      } as any,
      getNodeRunState: () => ({
        status: "idle",
        message: "",
        updatedAt: null,
        outputs: null,
      }),
      findNodeDefinition: () => null,
      onRunGraph: jest.fn(),
      onOpenAddNodeMenuAtViewportCenter: jest.fn(),
      activeCanvasTool: "arrow",
      onSelectCanvasTool: selectToolSpy,
      shapeLayer: shapeLayerStub(),
      onZoomIn: jest.fn(),
      onZoomOut: jest.fn(),
      onZoomReset: jest.fn(),
      onZoomOverview: jest.fn(),
      onToggleNodeDetailMode: jest.fn(),
      onOpenNodeContextMenu: jest.fn(),
      onCreateTextNodeAtPosition: jest.fn(),
      onRunNode: jest.fn(),
      onCopyTextGenerationPromptBundle: jest.fn(),
      onToggleTextGenerationOutputLock: jest.fn(),
      onRemoveNode: jest.fn(),
      onNodeTitleInput: jest.fn(),
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      isTextNodeEditing: () => false,
      consumeTextNodeAutoFocus: () => false,
      consumeTextNodeFocusPoint: () => undefined,
      consumeTextNodeEditorSnapshot: () => undefined,
      onRequestTextNodeEdit: jest.fn(),
      onStopTextNodeEdit: jest.fn(),
      onRevealPathInFinder: jest.fn(),
    });

    const click = (selector: string): void => {
      root
        .querySelector<HTMLButtonElement>(selector)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };

    const toolButtons = Array.from(
      root.querySelectorAll<HTMLButtonElement>(
        ".ss-studio-graph-workspace-control-row.is-tools .ss-studio-graph-workspace-control-button",
      ),
    );
    // The cursor, one button per shape kind, then the arrow.
    expect(toolButtons.map((button) => button.dataset.testid)).toEqual([
      "studio.workspace.tool.select",
      "studio.workspace.tool.square",
      "studio.workspace.tool.circle",
      "studio.workspace.tool.diamond",
      "studio.workspace.tool.pill",
      "studio.workspace.tool.cylinder",
      "studio.workspace.tool.note",
      "studio.workspace.tool.hexagon",
      "studio.workspace.tool.arrow",
    ]);

    click('button[aria-label="Square tool"]');
    click('button[aria-label="Circle tool"]');
    click('button[aria-label="Diamond tool"]');
    click('button[aria-label="Cylinder tool"]');
    // Clicking the already-armed tool disarms it back to the pointer.
    click('button[aria-label="Arrow tool"]');

    expect(selectToolSpy.mock.calls).toEqual([
      ["rectangle"],
      ["ellipse"],
      ["diamond"],
      ["cylinder"],
      ["select"],
    ]);
    expect(
      root.querySelector('[aria-label="Arrow tool"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(renderResult.viewportEl?.classList.contains("is-arrow-tool")).toBe(true);
    expect(renderResult.viewportEl?.classList.contains("is-shape-tool")).toBe(false);
    expect(renderResult.canvasEl).not.toBeNull();
  });
});
