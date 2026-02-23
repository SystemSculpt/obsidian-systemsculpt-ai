import type { StudioProjectV1 } from "../types";
import { scopeProjectForRun } from "../StudioRunScope";

function baseProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_scope",
    name: "Scoped Runtime Test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [],
      edges: [],
      entryNodeIds: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Scoped.systemsculpt-assets/policy/grants.json",
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

function projectWithBranchMerge(): StudioProjectV1 {
  const project = baseProject();
  project.graph.nodes.push(
    {
      id: "a",
      kind: "studio.input",
      version: "1.0.0",
      title: "A",
      position: { x: 0, y: 0 },
      config: {},
    },
    {
      id: "b",
      kind: "studio.input",
      version: "1.0.0",
      title: "B",
      position: { x: 100, y: 0 },
      config: {},
    },
    {
      id: "c",
      kind: "studio.prompt_template",
      version: "1.0.0",
      title: "C",
      position: { x: 200, y: 0 },
      config: {},
    },
    {
      id: "d",
      kind: "studio.text_generation",
      version: "1.0.0",
      title: "D",
      position: { x: 300, y: 0 },
      config: {},
    },
    {
      id: "orphan",
      kind: "studio.input",
      version: "1.0.0",
      title: "Orphan",
      position: { x: 0, y: 300 },
      config: {},
    }
  );

  project.graph.edges.push(
    {
      id: "e1",
      fromNodeId: "a",
      fromPortId: "text",
      toNodeId: "c",
      toPortId: "text",
    },
    {
      id: "e2",
      fromNodeId: "b",
      fromPortId: "text",
      toNodeId: "c",
      toPortId: "text",
    },
    {
      id: "e3",
      fromNodeId: "c",
      fromPortId: "prompt",
      toNodeId: "d",
      toPortId: "prompt",
    }
  );

  project.graph.entryNodeIds = ["a", "b", "orphan"];
  return project;
}

describe("StudioRuntime scoped run projection", () => {
  it("keeps downstream path and required upstream dependencies when running from a node", () => {
    const project = projectWithBranchMerge();
    const scoped = scopeProjectForRun(project, ["a"]);

    const nodeIds = scoped.graph.nodes.map((node) => node.id).sort();
    const edgeIds = scoped.graph.edges.map((edge) => edge.id).sort();
    const entryIds = [...scoped.graph.entryNodeIds].sort();

    expect(nodeIds).toEqual(["a", "b", "c", "d"]);
    expect(edgeIds).toEqual(["e1", "e2", "e3"]);
    expect(entryIds).toEqual(["a", "b"]);
  });

  it("throws when a requested scoped node does not exist", () => {
    const project = projectWithBranchMerge();
    expect(() => scopeProjectForRun(project, ["missing-node"])).toThrow(
      'Cannot run from node "missing-node"'
    );
  });

  it("returns the original project when no scoped entry nodes are provided", () => {
    const project = projectWithBranchMerge();
    expect(scopeProjectForRun(project, [])).toBe(project);
  });
});
