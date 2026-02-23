import type { StudioProjectV1 } from "../../../studio/types";
import {
  computeStudioGraphCanvasSize,
  STUDIO_GRAPH_CANVAS_BASE_HEIGHT,
  STUDIO_GRAPH_CANVAS_BASE_WIDTH,
} from "../graph-v3/StudioGraphCanvasBounds";

function createProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_1",
    name: "Canvas Bounds",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [
        {
          id: "a",
          kind: "studio.input",
          version: "1.0.0",
          title: "A",
          position: { x: 80, y: 120 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: ["a"],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/CanvasBounds.systemsculpt-assets/policy/grants.json",
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

describe("StudioGraphCanvasBounds", () => {
  it("falls back to base dimensions without project", () => {
    expect(computeStudioGraphCanvasSize(null)).toEqual({
      width: STUDIO_GRAPH_CANVAS_BASE_WIDTH,
      height: STUDIO_GRAPH_CANVAS_BASE_HEIGHT,
    });
  });

  it("expands to include far-away nodes with padding", () => {
    const project = createProject();
    project.graph.nodes.push({
      id: "far",
      kind: "studio.input",
      version: "1.0.0",
      title: "Far",
      position: { x: 9600, y: 6400 },
      config: {},
      continueOnError: false,
      disabled: false,
    });

    const size = computeStudioGraphCanvasSize(project);
    expect(size.width).toBeGreaterThan(STUDIO_GRAPH_CANVAS_BASE_WIDTH);
    expect(size.height).toBeGreaterThan(STUDIO_GRAPH_CANVAS_BASE_HEIGHT);
  });

  it("respects configured max bounds", () => {
    const project = createProject();
    project.graph.nodes.push({
      id: "very_far",
      kind: "studio.input",
      version: "1.0.0",
      title: "Very Far",
      position: { x: 50000, y: 40000 },
      config: {},
      continueOnError: false,
      disabled: false,
    });

    const size = computeStudioGraphCanvasSize(project, {
      maxWidth: 12000,
      maxHeight: 9000,
    });
    expect(size).toEqual({
      width: 12000,
      height: 9000,
    });
  });
});
