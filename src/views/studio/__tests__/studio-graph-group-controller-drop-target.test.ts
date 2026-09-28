/** @jest-environment jsdom */

import { StudioProjectSession } from "../../../studio/StudioProjectSession";
import type { StudioProjectV1 } from "../../../studio/types";
import { StudioGraphGroupController } from "../StudioGraphGroupController";
import {
  createElementStub,
  installWindowPointerListenerHarness,
} from "./studio-graph-pointer-test-helpers";

type GroupHost = ConstructorParameters<typeof StudioGraphGroupController>[0];

function createProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_group_drop_target",
    name: "Group Drop Target",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [
        {
          id: "member",
          kind: "studio.input",
          version: "1.0.0",
          title: "Member",
          position: { x: 100, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "drag_inside",
          kind: "studio.input",
          version: "1.0.0",
          title: "Drag Inside",
          position: { x: 130, y: 120 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "drag_overlap",
          kind: "studio.input",
          version: "1.0.0",
          title: "Drag Overlap",
          position: { x: 377, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "drag_far",
          kind: "studio.input",
          version: "1.0.0",
          title: "Drag Far",
          position: { x: 520, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: ["member", "drag_inside", "drag_overlap", "drag_far"],
      groups: [
        {
          id: "group_1",
          name: "Group 1",
          nodeIds: ["member"],
        },
      ],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/GroupDropTarget.systemsculpt-assets/policy/grants.json",
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

function createController(
  project: StudioProjectV1,
  overrides?: Partial<GroupHost>
): StudioGraphGroupController {
  return new StudioGraphGroupController({
    isBusy: () => false,
    getCurrentProject: () => project,
    getGraphZoom: () => 1,
    getNodeElement: () => null,
    notifyNodePositionsChanged: () => undefined,
    requestRender: () => undefined,
    scheduleProjectSave: () => undefined,
    commitProjectMutation: (_reason, mutator) => mutator(project) !== false,
    ...overrides,
  });
}

describe("StudioGraphGroupController drop target resolution", () => {
  it("keeps an output container drag anchored to its initial offset across session patches", () => {
    const project = createProject();
    project.graph.groups![0].outputForNodeId = "drag_far";
    project.graph.groups![0].outputOffset = {x: 96, y: 0};
    const session = new StudioProjectSession({projectPath: "test.systemsculpt", project, saveProject: async () => undefined});
    const live = session.getProject();
    const controller = createController(live, {
      getGraphZoom: () => 0.25,
      commitProjectMutation: (reason, mutator) => session.mutate(reason, mutator),
    });
    const frame = document.body.createDiv();
    const raf = jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {callback(0); return 1;});
    const harness = installWindowPointerListenerHarness();
    try {
      (controller as any).startGroupDrag("group_1", {button: 0, pointerId: 17, clientX: 100, clientY: 100, preventDefault() {}, stopPropagation() {}}, frame);
      for (let step = 1; step <= 20; step++) {
        harness.emit("pointermove", {pointerId: 17, clientX: 100 + step, clientY: 100 - step} as PointerEvent);
        if (step >= 3) expect(live.graph.groups![0].outputOffset).toEqual({x: 96 + step * 4, y: -step * 4});
      }
      harness.emit("pointerup", {pointerId: 17, clientX: 120, clientY: 80} as PointerEvent);
      expect(live.graph.groups![0].outputOffset).toEqual({x: 176, y: -80});
      expect(live.graph.nodes[0].position).toEqual({x: 180, y: 20});
    } finally { controller.clearRenderBindings(); harness.restore(); raf.mockRestore(); session.blockProjectFileWrites(); frame.remove(); }
  });

  it("matches a group when dragged node center is inside bounds", () => {
    const project = createProject();
    const controller = createController(project);
    expect(controller.resolveDropTargetGroupId(["drag_inside"])).toBe("group_1");
  });

  it("matches a group for near-edge overlap even when center is outside", () => {
    const project = createProject();
    const controller = createController(project);
    expect(controller.resolveDropTargetGroupId(["drag_overlap"])).toBe("group_1");
  });

  it("returns null when there is no meaningful overlap", () => {
    const project = createProject();
    const controller = createController(project);
    expect(controller.resolveDropTargetGroupId(["drag_far"])).toBeNull();
  });

  it("skips groups that already fully contain the dragged nodes", () => {
    const project = createProject();
    const controller = createController(project);
    expect(controller.resolveDropTargetGroupId(["member"])).toBeNull();
  });

  it("allows dragging groups while busy so graph layout can still be organized during runs", () => {
    const project = createProject();
    const notifyNodePositionsChanged = jest.fn();
    const commitProjectMutation = jest.fn((_reason, mutator) => mutator(project) !== false);
    const memberEl = createElementStub();
    const controller = createController(project, {
      isBusy: () => true,
      notifyNodePositionsChanged,
      commitProjectMutation,
      getNodeElement: (nodeId) => (nodeId === "member" ? memberEl : null),
    });
    // Drag ownership is a DOM-realm contract; use a mounted element rather
    // than the geometry-only style stub used for node transforms.
    const frameEl = document.body.createDiv();
    const startEvent = {
      button: 0,
      pointerId: 17,
      clientX: 100,
      clientY: 100,
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    } as unknown as PointerEvent;

    const harness = installWindowPointerListenerHarness();
    try {
      (controller as any).startGroupDrag("group_1", startEvent, frameEl);
      harness.emit(
        "pointermove",
        {
          pointerId: 17,
          clientX: 140,
          clientY: 160,
        } as PointerEvent
      );
      harness.emit(
        "pointerup",
        {
          pointerId: 17,
          clientX: 140,
          clientY: 160,
        } as PointerEvent
      );
    } finally {
      harness.restore();
    }

    const memberNode = project.graph.nodes.find((node) => node.id === "member");
    expect(memberNode?.position).toEqual({ x: 140, y: 160 });
    expect(memberEl.style.transform).toBe("translate(140px, 160px)");
    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(startEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(notifyNodePositionsChanged).toHaveBeenCalled();
    expect(commitProjectMutation).toHaveBeenCalledTimes(2);
    expect(commitProjectMutation).toHaveBeenNthCalledWith(
      1,
      "node.position",
      expect.any(Function),
      { captureHistory: true, mode: "continuous" }
    );
    expect(commitProjectMutation).toHaveBeenNthCalledWith(
      2,
      "node.position",
      expect.any(Function),
      { captureHistory: false, mode: "discrete" }
    );
  });
});
