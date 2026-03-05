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

describe("StudioGraphWorkspaceRenderer controls", () => {
  it("wires right-ribbon control callbacks", () => {
    const root = document.createElement("div");
    const runSpy = jest.fn();
    const addSpy = jest.fn();
    const zoomInSpy = jest.fn();
    const zoomOutSpy = jest.fn();
    const zoomResetSpy = jest.fn();
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
        getGraphZoom: () => 1,
        registerSurfaceElement: jest.fn(),
        registerCanvasElement: jest.fn(),
        registerMarqueeElement: jest.fn(),
        clearGraphElementMaps: jest.fn(),
        registerEdgesLayerElement: jest.fn(),
        renderGroupLayer: jest.fn(),
        refreshNodeSelectionClasses: jest.fn(),
        applyGraphZoom: jest.fn(),
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
      onZoomIn: zoomInSpy,
      onZoomOut: zoomOutSpy,
      onZoomReset: zoomResetSpy,
      onToggleNodeDetailMode: toggleDetailSpy,
      onOpenNodeContextMenu: jest.fn(),
      onCreateLabelAtPosition: jest.fn(),
      onRunNode: jest.fn(),
      onCopyTextGenerationPromptBundle: jest.fn(),
      onToggleTextGenerationOutputLock: jest.fn(),
      onRemoveNode: jest.fn(),
      onNodeTitleInput: jest.fn(),
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      isLabelEditing: () => false,
      consumeLabelAutoFocus: () => false,
      onRequestLabelEdit: jest.fn(),
      onStopLabelEdit: jest.fn(),
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
    click('button[aria-label="Toggle node detail mode"]');

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(zoomOutSpy).toHaveBeenCalledTimes(1);
    expect(zoomInSpy).toHaveBeenCalledTimes(1);
    expect(zoomResetSpy).toHaveBeenCalledTimes(1);
    expect(toggleDetailSpy).toHaveBeenCalledTimes(1);
    expect(zoomLabel.value).toBe("100%");
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
        getGraphZoom: () => 1,
        registerSurfaceElement: jest.fn(),
        registerCanvasElement: jest.fn(),
        registerMarqueeElement: jest.fn(),
        clearGraphElementMaps: jest.fn(),
        registerEdgesLayerElement: jest.fn(),
        renderGroupLayer: jest.fn(),
        refreshNodeSelectionClasses: jest.fn(),
        applyGraphZoom: jest.fn(),
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
      onZoomIn: jest.fn(),
      onZoomOut: jest.fn(),
      onZoomReset: jest.fn(),
      onToggleNodeDetailMode: jest.fn(),
      onOpenNodeContextMenu: jest.fn(),
      onCreateLabelAtPosition: jest.fn(),
      onRunNode: jest.fn(),
      onCopyTextGenerationPromptBundle: jest.fn(),
      onToggleTextGenerationOutputLock: jest.fn(),
      onRemoveNode: jest.fn(),
      onNodeTitleInput: jest.fn(),
      onNodeConfigMutated: jest.fn(),
      onNodeGeometryMutated: jest.fn(),
      isLabelEditing: () => false,
      consumeLabelAutoFocus: () => false,
      onRequestLabelEdit: jest.fn(),
      onStopLabelEdit: jest.fn(),
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
});
