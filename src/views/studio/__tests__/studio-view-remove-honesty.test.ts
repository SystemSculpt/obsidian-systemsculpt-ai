/** @jest-environment jsdom */

import type { StudioProjectV1 } from "../../../studio/types";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

const removeNodesFn = (SystemSculptStudioView as any).prototype.removeNodes as (
  this: any,
  nodeIds: string[]
) => boolean;

function projectWithNode(nodeId: string): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: `proj_${nodeId}`,
    name: `Project ${nodeId}`,
    createdAt: "2026-03-22T00:00:00.000Z",
    updatedAt: "2026-03-22T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes: [
        {
          id: nodeId,
          kind: "studio.text_output",
          version: "1.0.0",
          title: `Node ${nodeId}`,
          position: { x: 40, y: 40 },
          config: { value: "" },
          continueOnError: false,
          disabled: false,
        },
      ],
      edges: [],
      entryNodeIds: [nodeId],
      groups: [],
    },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json",
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

function createRemoveNodesContext(options: {
  viewProject: StudioProjectV1;
  commitTargetProject: StudioProjectV1;
}) {
  return {
    currentProject: options.viewProject,
    commitCurrentProjectMutation: jest.fn(
      (_reason: string, mutator: (project: StudioProjectV1) => boolean | void) =>
        mutator(options.commitTargetProject) !== false
    ),
    clearTransientFieldErrorsForNode: jest.fn(),
    runPresentation: { removeNode: jest.fn() },
    graphInteraction: { onNodeRemoved: jest.fn() },
    editingTextNodeIds: new Set<string>(),
    dirtyTextNodeEditIds: new Set<string>(),
    pendingTextNodeAutofocusNodeId: null,
    pendingTextNodeFocusPointByNodeId: new Map<string, { x: number; y: number }>(),
    textNodeEditorSnapshots: new Map<string, unknown>(),
    nodeContextMenuOverlay: null,
    nodeActionContextMenuOverlay: null,
    recomputeEntryNodes: jest.fn(),
    render: jest.fn(),
  };
}

describe("SystemSculptStudioView remove honesty", () => {
  it("reports failure when the committed graph does not contain the ids", () => {
    const viewProject = projectWithNode("node_a");
    const commitTargetProject = projectWithNode("node_other");
    const context = createRemoveNodesContext({ viewProject, commitTargetProject });

    const removed = removeNodesFn.call(context, ["node_a"]);

    expect(removed).toBe(false);
    expect(commitTargetProject.graph.nodes).toHaveLength(1);
    expect(context.render).not.toHaveBeenCalled();
  });

  it("removes attached visual arrows with a node while preserving other diagram items", () => {
    const project = projectWithNode("node_a");
    project.diagram = {
      shapes: [{ id: "shape_a", shape: "rectangle", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, label: "" }],
      arrows: [{ id: "arrow_a", fromShapeId: "node_a", toShapeId: "shape_a" }],
    };
    const context = createRemoveNodesContext({ viewProject: project, commitTargetProject: project });
    expect(removeNodesFn.call(context, ["node_a"])).toBe(true);
    expect(project.diagram.arrows).toEqual([]);
    expect(project.diagram.shapes).toHaveLength(1);
  });

  it("reports success when the committed graph actually removed the ids", () => {
    const viewProject = projectWithNode("node_a");
    const context = createRemoveNodesContext({
      viewProject,
      commitTargetProject: viewProject,
    });

    const removed = removeNodesFn.call(context, ["node_a"]);

    expect(removed).toBe(true);
    expect(viewProject.graph.nodes).toHaveLength(0);
    expect(context.render).toHaveBeenCalledTimes(1);
  });
});
