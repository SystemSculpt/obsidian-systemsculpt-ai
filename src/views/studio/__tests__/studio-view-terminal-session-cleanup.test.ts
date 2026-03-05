/** @jest-environment jsdom */

import { SystemSculptStudioView } from "../SystemSculptStudioView";

type StudioNodeLike = {
  id: string;
  kind: string;
};

type RemoveNodesContext = {
  currentProject: {
    graph: {
      nodes: StudioNodeLike[];
      edges: { fromNodeId: string; toNodeId: string }[];
      groups: { id: string; name: string; nodeIds: string[] }[];
      entryNodeIds: string[];
    };
  } | null;
  currentProjectPath: string | null;
  plugin: {
    getStudioService: jest.Mock<{
      stopTerminalSession: jest.Mock<Promise<void>, [{ projectPath: string; nodeId: string }]>;
    }, []>;
  };
  clearTransientFieldErrorsForNode: jest.Mock<void, [string]>;
  runPresentation: {
    removeNode: jest.Mock<void, [string]>;
  };
  graphInteraction: {
    onNodeRemoved: jest.Mock<void, [string]>;
  };
  editingLabelNodeIds: Set<string>;
  pendingLabelAutofocusNodeId: string | null;
  nodeContextMenuOverlay: { hide: jest.Mock<void, []> } | null;
  nodeActionContextMenuOverlay: { hide: jest.Mock<void, []> } | null;
  recomputeEntryNodes: jest.Mock<void, [unknown]>;
  scheduleProjectSave: jest.Mock<void, []>;
  render: jest.Mock<void, []>;
  stopTerminalSessionsForRemovedNodes: (nodes: StudioNodeLike[]) => void;
};

const removeNodes = (SystemSculptStudioView as any).prototype.removeNodes as (
  this: RemoveNodesContext,
  nodeIds: string[]
) => void;

const stopTerminalSessionsForRemovedNodes = (SystemSculptStudioView as any).prototype
  .stopTerminalSessionsForRemovedNodes as (this: RemoveNodesContext, nodes: StudioNodeLike[]) => void;

function createContext(): {
  context: RemoveNodesContext;
  stopTerminalSession: jest.Mock<Promise<void>, [{ projectPath: string; nodeId: string }]>;
} {
  const stopTerminalSession = jest.fn(async () => {});
  const studioService = {
    stopTerminalSession,
  };
  const context: RemoveNodesContext = {
    currentProject: {
      graph: {
        nodes: [
          { id: "terminal_1", kind: "studio.terminal" },
          { id: "text_1", kind: "studio.text_generation" },
        ],
        edges: [
          { fromNodeId: "terminal_1", toNodeId: "text_1" },
          { fromNodeId: "text_1", toNodeId: "terminal_1" },
        ],
        groups: [
          {
            id: "group_1",
            name: "Group 1",
            nodeIds: ["terminal_1", "text_1"],
          },
        ],
        entryNodeIds: ["terminal_1"],
      },
    },
    currentProjectPath: "SystemSculpt/Studio/Test.systemsculpt",
    plugin: {
      getStudioService: jest.fn(() => studioService),
    },
    clearTransientFieldErrorsForNode: jest.fn(),
    runPresentation: {
      removeNode: jest.fn(),
    },
    graphInteraction: {
      onNodeRemoved: jest.fn(),
    },
    editingLabelNodeIds: new Set<string>(),
    pendingLabelAutofocusNodeId: null,
    nodeContextMenuOverlay: { hide: jest.fn() },
    nodeActionContextMenuOverlay: { hide: jest.fn() },
    recomputeEntryNodes: jest.fn(),
    scheduleProjectSave: jest.fn(),
    render: jest.fn(),
    stopTerminalSessionsForRemovedNodes,
  };
  return {
    context,
    stopTerminalSession,
  };
}

describe("SystemSculptStudioView terminal session cleanup on node removal", () => {
  it("stops terminal sessions when removing studio.terminal nodes", () => {
    const { context, stopTerminalSession } = createContext();

    removeNodes.call(context, ["terminal_1"]);

    expect(stopTerminalSession).toHaveBeenCalledTimes(1);
    expect(stopTerminalSession).toHaveBeenCalledWith({
      projectPath: "SystemSculpt/Studio/Test.systemsculpt",
      nodeId: "terminal_1",
    });
    expect(context.currentProject?.graph.nodes.map((node) => node.id)).toEqual(["text_1"]);
  });

  it("does not stop terminal sessions when removing non-terminal nodes", () => {
    const { context, stopTerminalSession } = createContext();

    removeNodes.call(context, ["text_1"]);

    expect(stopTerminalSession).not.toHaveBeenCalled();
    expect(context.currentProject?.graph.nodes.map((node) => node.id)).toEqual(["terminal_1"]);
  });
});
