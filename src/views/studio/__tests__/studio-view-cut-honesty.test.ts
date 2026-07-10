/** @jest-environment jsdom */

import type { StudioProjectV1 } from "../../../studio/types";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

// Spy on the actual CJS module object so the view's `new Notice(...)` call
// sites (compiled to property access on the module) are intercepted.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidian = require("obsidian");

const removeNodesFn = (SystemSculptStudioView as any).prototype.removeNodes as (
  this: any,
  nodeIds: string[]
) => boolean;
const cutFn = (SystemSculptStudioView as any).prototype.cutSelectedGraphNodesToClipboard as (
  this: any
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

describe("SystemSculptStudioView cut/remove honesty", () => {
  let noticeSpy: jest.SpyInstance;

  beforeEach(() => {
    noticeSpy = jest
      .spyOn(obsidian as any, "Notice")
      .mockImplementation(function noticeStub() {
        return {};
      } as any);
  });

  afterEach(() => {
    noticeSpy.mockRestore();
  });

  function noticeMessages(): string[] {
    return noticeSpy.mock.calls.map((call) => String(call[0] ?? ""));
  }

  it("removeNodes reports failure when the committed graph does not contain the ids", () => {
    const viewProject = projectWithNode("node_a");
    const commitTargetProject = projectWithNode("node_other");
    const context = createRemoveNodesContext({ viewProject, commitTargetProject });

    const removed = removeNodesFn.call(context, ["node_a"]);

    expect(removed).toBe(false);
    expect(commitTargetProject.graph.nodes).toHaveLength(1);
    expect(context.render).not.toHaveBeenCalled();
  });

  it("removeNodes reports success when the committed graph actually removed the ids", () => {
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

  it("does not announce a cut when removal failed", () => {
    const context = {
      busy: false,
      currentProject: projectWithNode("node_a"),
      graphInteraction: { getSelectedNodeIds: jest.fn(() => ["node_a"]) },
      copySelectedGraphNodesToClipboard: jest.fn(() => true),
      removeNodes: jest.fn(() => false),
    };

    const result = cutFn.call(context);

    expect(result).toBe(false);
    expect(noticeMessages().filter((message) => message.startsWith("Cut "))).toEqual([]);
  });

  it("announces the cut only when removal actually happened", () => {
    const context = {
      busy: false,
      currentProject: projectWithNode("node_a"),
      graphInteraction: { getSelectedNodeIds: jest.fn(() => ["node_a"]) },
      copySelectedGraphNodesToClipboard: jest.fn(() => true),
      removeNodes: jest.fn(() => true),
    };

    const result = cutFn.call(context);

    expect(result).toBe(true);
    expect(noticeMessages()).toContain("Cut 1 node.");
  });
});
