/** @jest-environment jsdom */

import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import { SystemSculptStudioView } from "../SystemSculptStudioView";
import { createStudioGraphHistoryState } from "../systemsculpt-studio-view/StudioGraphHistoryState";

// Spy on the actual CJS module object so the view's `new Notice(...)` call
// sites (compiled to property access on the module) are intercepted.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const obsidian = require("obsidian");

const viewPrototype = (SystemSculptStudioView as any).prototype;

// Real view methods driven against a synthetic context, mirroring the
// prototype-context pattern in studio-view-cut-honesty.test.ts. Each name
// listed here resolves `this.<name>(...)` calls inside the methods under
// test to the real implementation.
const REAL_VIEW_METHODS = [
  "stopTextNodeEdit",
  "removeTextNodeIfEmptyOnEditEnd",
  "removeNodes",
  "findNode",
  "commitCurrentProjectMutation",
  "captureProjectHistoryCheckpoint",
  "handleNodeConfigValueChange",
  "setHistoryCurrentSnapshot",
  "resetProjectHistory",
  "undoGraphHistory",
  "redoGraphHistory",
  "applyHistorySnapshot",
] as const;

function createTextNode(
  nodeId: string,
  value: string,
  kind: string = "studio.text"
): StudioNodeInstance {
  return {
    id: nodeId,
    kind,
    version: "1.0.0",
    title: "Text",
    position: { x: 40, y: 40 },
    config: { value },
    continueOnError: false,
    disabled: false,
  };
}

function createProject(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_text_cleanup",
    name: "Text Cleanup",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    engine: {
      apiMode: "systemsculpt_only",
      minPluginVersion: "1.0.0",
    },
    graph: {
      nodes,
      edges: [],
      entryNodeIds: [],
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

type EditEndHarness = {
  context: any;
  commitReasons: string[];
  nodeIds: () => string[];
  findValue: (nodeId: string) => unknown;
};

function createEditEndHarness(options: {
  nodes: StudioNodeInstance[];
  editingNodeIds?: string[];
  busy?: boolean;
}): EditEndHarness {
  const project = createProject(options.nodes);
  const commitReasons: string[] = [];
  const sessionRef = { project };
  const session = {
    mutate: (
      reason: string,
      mutator: (target: StudioProjectV1) => boolean | void
    ): boolean => {
      commitReasons.push(reason);
      return mutator(sessionRef.project) !== false;
    },
    replaceProjectSnapshot: (next: StudioProjectV1) => {
      sessionRef.project = next;
    },
    schedulePersist: jest.fn(),
    getProject: () => sessionRef.project,
  };

  const context: any = {
    busy: options.busy ?? false,
    currentProject: project,
    currentProjectPath: "SystemSculpt/Studio/Text Cleanup.systemsculpt",
    currentProjectSession: session,
    historyState: createStudioGraphHistoryState(),
    editingTextNodeIds: new Set<string>(options.editingNodeIds ?? []),
    dirtyTextNodeEditIds: new Set<string>(),
    pendingTextNodeAutofocusNodeId: null,
    pendingTextNodeFocusPointByNodeId: new Map<string, { x: number; y: number }>(),
    textNodeEditorSnapshots: new Map<string, unknown>(),
    transientFieldErrorsByNodeId: new Map<string, unknown>(),
    nodeContextMenuOverlay: null,
    nodeActionContextMenuOverlay: null,
    runPresentation: { removeNode: jest.fn(), reset: jest.fn() },
    graphInteraction: {
      getSelectedNodeIds: jest.fn(() => [] as string[]),
      onNodeRemoved: jest.fn(),
      clearPendingConnection: jest.fn(),
      clearProjectState: jest.fn(),
      setSelectedNodeIds: jest.fn(),
    },
    recomputeEntryNodes: jest.fn(),
    clearTransientFieldErrorsForNode: jest.fn(),
    cloneJsonValue: jest.fn((value: unknown) => value),
    refreshNodeCardPreview: jest.fn(),
    handleNoteNodeConfigMutated: jest.fn(),
    render: jest.fn(),
    commitCurrentProjectMutationAsync: jest.fn(() => Promise.resolve(false)),
  };
  for (const methodName of REAL_VIEW_METHODS) {
    context[methodName] = viewPrototype[methodName];
  }

  return {
    context,
    commitReasons,
    nodeIds: () =>
      (context.currentProject as StudioProjectV1).graph.nodes.map((node) => node.id),
    findValue: (nodeId: string) =>
      (context.currentProject as StudioProjectV1).graph.nodes.find(
        (node) => node.id === nodeId
      )?.config.value,
  };
}

describe("SystemSculptStudioView empty text node cleanup (tldraw parity)", () => {
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

  it("deletes an empty studio.text node when its edit session ends, silently and in one commit", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_text", "")],
      editingNodeIds: ["node_text"],
    });

    harness.context.stopTextNodeEdit("node_text");

    expect(harness.nodeIds()).toEqual([]);
    expect(harness.commitReasons).toEqual(["graph.node.remove"]);
    expect(harness.context.editingTextNodeIds.size).toBe(0);
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it("deletes a whitespace-only studio.text node on edit end", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_text", "  \n\t  ")],
      editingNodeIds: ["node_text"],
    });

    harness.context.stopTextNodeEdit("node_text");

    expect(harness.nodeIds()).toEqual([]);
    expect(harness.commitReasons).toEqual(["graph.node.remove"]);
    expect(noticeSpy).not.toHaveBeenCalled();
  });

  it("keeps a studio.text node that still has content on edit end", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_text", "keep me")],
      editingNodeIds: ["node_text"],
    });

    harness.context.stopTextNodeEdit("node_text");

    expect(harness.nodeIds()).toEqual(["node_text"]);
    expect(harness.commitReasons).toEqual([]);
    expect(harness.context.editingTextNodeIds.size).toBe(0);
    expect(harness.context.render).toHaveBeenCalledTimes(1);
  });

  it("never deletes studio.text_output nodes on edit end, even when empty", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_output", "", "studio.text_output")],
      editingNodeIds: ["node_output"],
    });

    harness.context.stopTextNodeEdit("node_output");

    expect(harness.nodeIds()).toEqual(["node_output"]);
    expect(harness.commitReasons).toEqual([]);
  });

  it("leaves empty text nodes alone when no edit session was ever active", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_text", "")],
      editingNodeIds: [],
    });

    harness.context.stopTextNodeEdit("node_text");

    expect(harness.nodeIds()).toEqual(["node_text"]);
    expect(harness.commitReasons).toEqual([]);
    expect(harness.context.render).not.toHaveBeenCalled();
  });

  it("leaves the node alone while the view is busy, matching manual-removal gating", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_text", "")],
      editingNodeIds: ["node_text"],
      busy: true,
    });

    harness.context.stopTextNodeEdit("node_text");

    expect(harness.nodeIds()).toEqual(["node_text"]);
    expect(harness.commitReasons).toEqual([]);
    expect(harness.context.editingTextNodeIds.size).toBe(0);
  });

  it("groups a complete text edit into one graph undo transaction", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_text", "before")],
      editingNodeIds: ["node_text"],
    });
    harness.context.resetProjectHistory(harness.context.currentProject);

    for (const value of ["a", "af", "after"]) {
      harness.context.handleNodeConfigValueChange("node_text", "value", value, {
        mode: "continuous",
        captureHistory: false,
      });
    }
    harness.context.stopTextNodeEdit("node_text");

    expect(harness.context.historyState.undoSnapshots).toHaveLength(1);
    expect(harness.findValue("node_text")).toBe("after");

    expect(harness.context.undoGraphHistory()).toBe(true);
    expect(harness.findValue("node_text")).toBe("before");
  });

  it("restores the auto-deleted node with a single undo, edit session closed", () => {
    const harness = createEditEndHarness({
      nodes: [createTextNode("node_text", "hello")],
      editingNodeIds: ["node_text"],
    });
    // History is synced to the loaded project, as after any real session start.
    harness.context.resetProjectHistory(harness.context.currentProject);

    // The user clears the text (a continuous keystroke commit), then ends the edit.
    harness.context.commitCurrentProjectMutation(
      "node.config",
      (project: StudioProjectV1) => {
        const node = project.graph.nodes.find((entry) => entry.id === "node_text");
        if (!node) {
          return false;
        }
        node.config.value = "";
        return true;
      },
      { mode: "continuous" }
    );
    harness.context.stopTextNodeEdit("node_text");

    expect(harness.nodeIds()).toEqual([]);
    // The whole clear-and-auto-delete interaction lands as one undo entry.
    expect(harness.context.historyState.undoSnapshots).toHaveLength(1);

    const undone = harness.context.undoGraphHistory();

    expect(undone).toBe(true);
    expect(harness.nodeIds()).toEqual(["node_text"]);
    expect(harness.findValue("node_text")).toBe("hello");
    expect(harness.context.editingTextNodeIds.size).toBe(0);

    const redone = harness.context.redoGraphHistory();

    expect(redone).toBe(true);
    expect(harness.nodeIds()).toEqual([]);
  });
});
