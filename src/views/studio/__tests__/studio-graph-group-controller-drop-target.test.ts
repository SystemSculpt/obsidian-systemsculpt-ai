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
    const frameEl = createElementStub();
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
