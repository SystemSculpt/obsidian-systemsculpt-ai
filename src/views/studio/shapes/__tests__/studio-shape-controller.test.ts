/** @jest-environment jsdom */

import type { StudioDiagram, StudioProjectV1 } from "../../../../studio/types";
import {
  StudioShapeController,
  type StudioShapeControllerHost,
} from "../StudioShapeController";

function projectWithDiagram(diagram: StudioDiagram): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "project_shapes",
    name: "Shapes project",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "1.0.0" },
    graph: { nodes: [], edges: [], entryNodeIds: [], groups: [] },
    diagram,
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Studio/Shapes.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: { maxRuns: 100, maxArtifactsMb: 1024 },
    },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

function shape(id: string, x: number, y: number) {
  return {
    id,
    shape: "rectangle" as const,
    position: { x, y },
    size: { width: 100, height: 100 },
    label: id,
  };
}

type Harness = {
  controller: StudioShapeController;
  host: StudioShapeControllerHost & {
    commitMutation: jest.Mock;
    translateNodes: jest.Mock;
    beginNodeTranslation: jest.Mock;
    previewNodeTranslation: jest.Mock;
    finishNodeTranslation: jest.Mock;
    clearNodeSelection: jest.Mock;
    requestRender: jest.Mock;
  };
  project: StudioProjectV1;
  commitOptions: Array<{ captureHistory?: boolean; mode?: string } | undefined>;
};

function createHarness(diagram?: StudioDiagram): Harness {
  const project = projectWithDiagram(
    diagram ?? {
      shapes: [shape("s1", 0, 0), shape("s2", 300, 0), shape("s3", 900, 900)],
      arrows: [{ id: "a1", fromShapeId: "s1", toShapeId: "s2" }],
    }
  );
  const commitOptions: Harness["commitOptions"] = [];
  const canvasEl = document.createElement("div");
  const host: Harness["host"] = {
    isBusy: () => false,
    getCanvasEl: () => canvasEl,
    getGraphZoom: () => 1,
    commitMutation: jest.fn((_reason, mutator, options) => {
      commitOptions.push(options);
      return mutator(project) !== false;
    }),
    getCurrentProject: () => project,
    clearNodeSelection: jest.fn(),
    requestRender: jest.fn(),
    beginNodeTranslation: jest.fn(),
    translateNodes: jest.fn(() => false),
    previewNodeTranslation: jest.fn(),
    finishNodeTranslation: jest.fn(),
  };
  return { controller: new StudioShapeController(host), host, project, commitOptions };
}

describe("StudioShapeController canvas-wide selection", () => {
  it("collects every shape the marquee touches", () => {
    const { controller } = createHarness();

    controller.beginMarquee();
    controller.selectInBounds({ left: -10, top: -10, right: 350, bottom: 200 }, {
      additive: false,
    });

    expect(controller.getSelectedShapeIds()).toEqual(["s1", "s2"]);
  });

  it("keeps the pre-marquee selection when the sweep is additive", () => {
    const { controller } = createHarness();

    controller.select({ type: "shape", id: "s3" });
    controller.beginMarquee();
    controller.selectInBounds({ left: -10, top: -10, right: 120, bottom: 120 }, {
      additive: true,
    });

    expect(controller.getSelectedShapeIds().sort()).toEqual(["s1", "s3"]);
  });

  it("replaces the baseline when the sweep is not additive", () => {
    const { controller } = createHarness();

    controller.select({ type: "shape", id: "s3" });
    controller.beginMarquee();
    controller.selectInBounds({ left: -10, top: -10, right: 120, bottom: 120 }, {
      additive: false,
    });

    expect(controller.getSelectedShapeIds()).toEqual(["s1"]);
  });

  it("adds to the selection when a pick is additive and toggles a second pick off", () => {
    const { controller, host } = createHarness();

    controller.select({ type: "shape", id: "s1" });
    controller.select({ type: "shape", id: "s2" }, { additive: true });
    expect(controller.getSelectedShapeIds()).toEqual(["s1", "s2"]);
    // Additive picks never touch the node half of the selection.
    expect(host.clearNodeSelection).toHaveBeenCalledTimes(1);

    controller.select({ type: "shape", id: "s2" }, { additive: true });
    expect(controller.getSelectedShapeIds()).toEqual(["s1"]);
  });

  it("moves every selected shape from its own origin", () => {
    const { controller, project } = createHarness();

    controller.select({ type: "shape", id: "s1" });
    controller.select({ type: "shape", id: "s2" }, { additive: true });
    controller.beginTranslation();
    controller.applyTranslation(project, { x: 40, y: 25 });

    expect(project.diagram?.shapes.map((entry) => entry.position)).toEqual([
      { x: 40, y: 25 },
      { x: 340, y: 25 },
      { x: 900, y: 900 },
    ]);
  });

  it("keeps a drag on one history entry and carries the selected nodes with it", () => {
    const { controller, host, commitOptions, project } = createHarness();
    host.translateNodes.mockReturnValue(true);
    controller.select({ type: "shape", id: "s1" });

    const options = controller.layerOptions();
    options.onMoveSelection({ x: 10, y: 0 }, { first: true, final: false });
    options.onMoveSelection({ x: 30, y: 0 }, { first: false, final: false });
    options.onMoveSelection({ x: 30, y: 0 }, { first: false, final: true });

    expect(host.beginNodeTranslation).toHaveBeenCalledTimes(1);
    expect(host.translateNodes).toHaveBeenCalledTimes(3);
    expect(host.finishNodeTranslation).toHaveBeenCalledTimes(1);
    expect(commitOptions).toEqual([
      { captureHistory: true, mode: "continuous" },
      { captureHistory: false, mode: "continuous" },
      { captureHistory: false, mode: "continuous" },
    ]);
    expect(project.diagram?.shapes[0].position).toEqual({ x: 30, y: 0 });
  });

  it("commits an arrow label as its own mutation reason", () => {
    const { controller, host, project } = createHarness();

    controller.layerOptions().onArrowLabelChange("a1", "handoff");

    expect(host.commitMutation).toHaveBeenCalledWith("diagram.arrow.label", expect.any(Function));
    expect(project.diagram?.arrows[0].label).toBe("handoff");
    expect(host.requestRender).toHaveBeenCalledTimes(1);

    // A no-op value never re-renders.
    controller.layerOptions().onArrowLabelChange("a1", "handoff");
    expect(host.requestRender).toHaveBeenCalledTimes(1);
  });

  it("deletes selected shapes and arrows in one mutation", () => {
    const { controller, host, project } = createHarness();

    controller.select({ type: "shape", id: "s1" });
    controller.select({ type: "shape", id: "s3" }, { additive: true });
    expect(controller.removeSelection()).toBe(true);

    expect(host.commitMutation).toHaveBeenCalledTimes(1);
    expect(project.diagram?.shapes.map((entry) => entry.id)).toEqual(["s2"]);
    // s1's arrow leaves with it.
    expect(project.diagram?.arrows).toEqual([]);
    expect(controller.hasSelection()).toBe(false);
  });
});
