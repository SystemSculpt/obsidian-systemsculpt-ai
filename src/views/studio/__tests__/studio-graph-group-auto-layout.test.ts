import type { StudioProjectV1 } from "../../../studio/types";
import { autoAlignGroupNodes } from "../graph-v3/StudioGraphGroupAutoLayout";

function createProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_1",
    name: "Group Layout",
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
          position: { x: 480, y: 280 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "b",
          kind: "studio.input",
          version: "1.0.0",
          title: "B",
          position: { x: 220, y: 160 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "c",
          kind: "studio.input",
          version: "1.0.0",
          title: "C",
          position: { x: 760, y: 120 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "d",
          kind: "studio.input",
          version: "1.0.0",
          title: "D",
          position: { x: 180, y: 420 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: ["a", "b", "c", "d"],
      groups: [
        {
          id: "group_1",
          name: "Group 1",
          nodeIds: ["a", "b", "c"],
        },
      ],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/Grouping.systemsculpt-assets/policy/grants.json",
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

function nodePosition(project: StudioProjectV1, nodeId: string): { x: number; y: number } {
  const node = project.graph.nodes.find((entry) => entry.id === nodeId);
  if (!node) {
    throw new Error(`Node not found: ${nodeId}`);
  }
  return { ...node.position };
}

describe("StudioGraphGroupAutoLayout", () => {
  it("aligns dependency chains left-to-right", () => {
    const project = createProject();
    project.graph.edges = [
      {
        id: "edge_1",
        fromNodeId: "a",
        fromPortId: "out",
        toNodeId: "b",
        toPortId: "in",
      },
      {
        id: "edge_2",
        fromNodeId: "b",
        fromPortId: "out",
        toNodeId: "c",
        toPortId: "in",
      },
    ];

    const result = autoAlignGroupNodes(project, "group_1");
    expect(result.changed).toBe(true);
    expect(result.movedNodeIds.length).toBeGreaterThan(0);

    const a = nodePosition(project, "a");
    const b = nodePosition(project, "b");
    const c = nodePosition(project, "c");
    expect(a.x).toBeLessThan(b.x);
    expect(b.x).toBeLessThan(c.x);
  });

  it("keeps disconnected nodes deterministic in a shared layer", () => {
    const project = createProject();
    project.graph.groups = [
      {
        id: "group_1",
        name: "Group 1",
        nodeIds: ["a", "b", "d"],
      },
    ];

    const result = autoAlignGroupNodes(project, "group_1");
    expect(result.changed).toBe(true);

    const a = nodePosition(project, "a");
    const b = nodePosition(project, "b");
    const d = nodePosition(project, "d");
    expect(a.x).toBe(b.x);
    expect(b.x).toBe(d.x);
    expect(b.y).toBeLessThan(a.y);
    expect(a.y).toBeLessThan(d.y);
  });

  it("handles cycles without throwing and keeps finite coordinates", () => {
    const project = createProject();
    project.graph.edges = [
      {
        id: "edge_1",
        fromNodeId: "a",
        fromPortId: "out",
        toNodeId: "b",
        toPortId: "in",
      },
      {
        id: "edge_2",
        fromNodeId: "b",
        fromPortId: "out",
        toNodeId: "c",
        toPortId: "in",
      },
      {
        id: "edge_3",
        fromNodeId: "c",
        fromPortId: "out",
        toNodeId: "a",
        toPortId: "in",
      },
    ];

    const result = autoAlignGroupNodes(project, "group_1");
    expect(result.changed).toBe(true);

    for (const nodeId of ["a", "b", "c"]) {
      const { x, y } = nodePosition(project, nodeId);
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(24);
      expect(y).toBeGreaterThanOrEqual(24);
    }
  });

  it("returns unchanged for missing or undersized groups", () => {
    const project = createProject();

    expect(autoAlignGroupNodes(project, "missing")).toEqual({
      changed: false,
      movedNodeIds: [],
    });

    project.graph.groups = [
      {
        id: "group_single",
        name: "Single",
        nodeIds: ["a"],
      },
    ];
    expect(autoAlignGroupNodes(project, "group_single")).toEqual({
      changed: false,
      movedNodeIds: [],
    });
  });
});
