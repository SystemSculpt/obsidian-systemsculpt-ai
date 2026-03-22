import { StudioGraphConnectionEngineV2 } from "../connections-v2/StudioGraphConnectionEngineV2";
import type { StudioProjectV1 } from "../../../studio/types";

function createProject(): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_connection_engine",
    name: "Connection Engine",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "0.0.0",
    },
    graph: {
      nodes: [
        {
          id: "source",
          kind: "studio.input",
          version: "1.0.0",
          title: "Source",
          position: { x: 100, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
        {
          id: "target",
          kind: "studio.text_generation",
          version: "1.0.0",
          title: "Target",
          position: { x: 360, y: 100 },
          config: {},
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: ["source", "target"],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "SystemSculpt/Studio/ConnectionEngine.systemsculpt-assets/policy/grants.json",
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

describe("StudioGraphConnectionEngineV2", () => {
  it("creates connections through the host mutation API", () => {
    const project = createProject();
    const recomputeEntryNodes = jest.fn();
    const requestRender = jest.fn();
    const commitProjectMutation = jest.fn((_reason, mutator) => mutator(project) !== false);
    const engine = new StudioGraphConnectionEngineV2({
      isBusy: () => false,
      getCurrentProject: () => project,
      setError: () => undefined,
      recomputeEntryNodes,
      scheduleProjectSave: () => undefined,
      commitProjectMutation,
      requestRender,
      getPortType: (nodeId, direction, portId) => {
        if (nodeId === "source" && direction === "out" && portId === "text") {
          return "text";
        }
        if (nodeId === "target" && direction === "in" && portId === "prompt") {
          return "text";
        }
        return null;
      },
      portTypeCompatible: (sourceType, targetType) => sourceType === targetType,
      getGraphZoom: () => 1,
    });

    engine.beginConnection("source", "text");
    engine.completeConnection("target", "prompt");

    expect(commitProjectMutation).toHaveBeenCalledTimes(1);
    expect(commitProjectMutation).toHaveBeenCalledWith(
      "graph.connection",
      expect.any(Function)
    );
    expect(project.graph.edges).toHaveLength(1);
    expect(project.graph.edges[0]).toMatchObject({
      fromNodeId: "source",
      fromPortId: "text",
      toNodeId: "target",
      toPortId: "prompt",
    });
    expect(recomputeEntryNodes).toHaveBeenCalledWith(project);
    expect(requestRender).toHaveBeenCalled();
  });

  it("removes connections through the host mutation API", () => {
    const project = createProject();
    project.graph.edges.push({
      id: "edge_existing",
      fromNodeId: "source",
      fromPortId: "text",
      toNodeId: "target",
      toPortId: "prompt",
    });
    const recomputeEntryNodes = jest.fn();
    const requestRender = jest.fn();
    const commitProjectMutation = jest.fn((_reason, mutator) => mutator(project) !== false);
    const engine = new StudioGraphConnectionEngineV2({
      isBusy: () => false,
      getCurrentProject: () => project,
      setError: () => undefined,
      recomputeEntryNodes,
      scheduleProjectSave: () => undefined,
      commitProjectMutation,
      requestRender,
      getPortType: () => null,
      portTypeCompatible: () => true,
      getGraphZoom: () => 1,
    });
    (engine as any).closeEdgeContextMenu = jest.fn();

    (engine as any).removeEdge("edge_existing");

    expect(commitProjectMutation).toHaveBeenCalledTimes(1);
    expect(commitProjectMutation).toHaveBeenCalledWith(
      "graph.connection",
      expect.any(Function)
    );
    expect(project.graph.edges).toHaveLength(0);
    expect(recomputeEntryNodes).toHaveBeenCalledWith(project);
    expect(requestRender).toHaveBeenCalled();
  });
});
