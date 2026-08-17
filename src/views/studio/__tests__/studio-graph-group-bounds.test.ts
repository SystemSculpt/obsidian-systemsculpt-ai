import type { StudioProjectV1 } from "../../../studio/types";
import { computeStudioGraphGroupBounds } from "../graph-v3/StudioGraphGroupBounds";

function createProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_bounds",
    name: "Group bounds",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "0.0.0" },
    graph: {
      nodes: [
        {
          id: "a",
          kind: "studio.input",
          version: "1.0.0",
          title: "A",
          position: { x: 100, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: [],
      groups: [],
    },
    diagram: {
      shapes: [
        {
          id: "s1",
          shape: "rectangle",
          position: { x: 600, y: 500 },
          size: { width: 200, height: 100 },
          label: "One",
        },
      ],
      arrows: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Studio/Bounds.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: { maxRuns: 100, maxArtifactsMb: 1024 },
    },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

describe("computeStudioGraphGroupBounds", () => {
  it("stretches the frame around a grouped shape", () => {
    const project = createProject();

    const bounds = computeStudioGraphGroupBounds(project, {
      id: "group_1",
      name: "Group 1",
      nodeIds: ["a"],
      shapeIds: ["s1"],
    });

    // The node anchors the top-left; the shape's far corner sets the extent.
    expect(bounds?.left).toBe(80);
    expect(bounds?.top).toBe(82);
    expect(bounds?.width).toBe(740);
    expect(bounds?.height).toBe(550);
  });

  it("frames a shape-only group", () => {
    const project = createProject();

    const bounds = computeStudioGraphGroupBounds(project, {
      id: "group_1",
      name: "Group 1",
      nodeIds: [],
      shapeIds: ["s1"],
    });

    expect(bounds).toEqual({ left: 580, top: 482, width: 240, height: 150 });
  });

  it("returns null when no member resolves", () => {
    const project = createProject();

    expect(
      computeStudioGraphGroupBounds(project, {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["missing"],
        shapeIds: ["gone"],
      })
    ).toBeNull();
  });
});
