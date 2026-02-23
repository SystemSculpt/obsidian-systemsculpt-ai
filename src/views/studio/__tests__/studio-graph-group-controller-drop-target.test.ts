import type { StudioProjectV1 } from "../../../studio/types";
import { StudioGraphGroupController } from "../StudioGraphGroupController";

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

function createController(project: StudioProjectV1): StudioGraphGroupController {
  return new StudioGraphGroupController({
    isBusy: () => false,
    getCurrentProject: () => project,
    getGraphZoom: () => 1,
    getNodeElement: () => null,
    notifyNodePositionsChanged: () => undefined,
    requestRender: () => undefined,
    scheduleProjectSave: () => undefined,
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
});
