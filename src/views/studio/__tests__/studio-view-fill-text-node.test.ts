/** @jest-environment jsdom */

import { textNode } from "../../../studio/nodes/textNode";
import { STUDIO_TEXT_NODE_WIDTH_MODE_KEY } from "../../../studio/StudioNodeGeometry";
import type { StudioNodeDefinition, StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import { StudioTextEditSessions } from "../StudioTextEditSessions";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

const viewPrototype = (SystemSculptStudioView as any).prototype;

// Real view methods driven against a synthetic context, as in
// studio-view-text-node-empty-cleanup.test.ts.
const REAL_VIEW_METHODS = [
  "createNodeFromDefinition",
  "createTextNodeAtPosition",
  "currentProjectOrThrow",
  "normalizeNodePosition",
  "findNode",
  "commitCurrentProjectMutation",
  "handleNodeResize",
  "handleSelectionResize",
  "applyNodeResizePatch",
] as const;

function createProject(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "proj_fill_text",
    name: "Fill Text",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "1.0.0" },
    graph: { nodes, edges: [], entryNodeIds: [], groups: [] },
    permissionsRef: { policyVersion: 1, policyPath: "Studio/Test.systemsculpt-assets/policy/grants.json" },
    settings: { runConcurrency: "adaptive", defaultFsScope: "vault", retention: { maxRuns: 100, maxArtifactsMb: 1024 } },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  } as StudioProjectV1;
}

function createHarness(nodes: StudioNodeInstance[] = []) {
  const project = createProject(nodes);
  const context: any = {
    busy: false,
    currentProject: project,
    currentProjectPath: "SystemSculpt/Studio/Fill Text.systemsculpt",
    nodeDefinitions: [textNode],
    nodeContextMenuOverlay: null,
    nodeActionContextMenuOverlay: null,
    textEdits: new StudioTextEditSessions(),
    projectSessionController: {
      commitMutation: (_reason: string, mutator: (target: StudioProjectV1) => boolean | void): boolean =>
        mutator(project) !== false,
    },
    graphInteraction: {
      selectOnlyNode: jest.fn(),
      clearPendingConnection: jest.fn(),
      notifyNodePositionsChanged: jest.fn(),
    },
    computeDefaultNodePosition: jest.fn(() => ({ x: 500, y: 400 })),
    setError: jest.fn(),
    render: jest.fn(),
  };
  for (const name of REAL_VIEW_METHODS) {
    context[name] = viewPrototype[name];
  }
  return { context, project, only: (): StudioNodeInstance => project.graph.nodes[0] };
}

function jsonDefinition(): StudioNodeDefinition {
  return { ...textNode, kind: "studio.json", configDefaults: {} };
}

describe("SystemSculptStudioView fill text", () => {
  it("drops a box around the double-clicked point and starts typing in it", () => {
    const harness = createHarness();

    harness.context.createTextNodeAtPosition({ x: 1000, y: 600 });

    const node = harness.only();
    expect(node.kind).toBe("studio.text");
    expect(node.config).toMatchObject({ layout: "fill", value: "" });
    expect(node.size).toEqual({ width: 320, height: 72 });
    // Centred on the click, as a caption lands on an image.
    expect(node.position).toEqual({ x: 1000 - 160, y: 600 - 36 });
    expect(harness.context.textEdits.isEditing(node.id)).toBe(true);
    expect(harness.context.textEdits.takeMountState(node.id).shouldAutoFocus).toBe(true);
    expect(harness.context.graphInteraction.selectOnlyNode).toHaveBeenCalledWith(node.id);
  });

  it("makes text added from the node menu the same kind of box", () => {
    const harness = createHarness();

    harness.context.createNodeFromDefinition(textNode);

    expect(harness.only().config.layout).toBe("fill");
    expect(harness.only().size).toEqual({ width: 320, height: 72 });
    expect(harness.only().position).toEqual({ x: 500, y: 400 });
    expect(harness.context.textEdits.isEditing(harness.only().id)).toBe(false);
  });

  it("leaves a caller that names its own layout or size alone", () => {
    const markdown = createHarness();
    markdown.context.createNodeFromDefinition(textNode, { config: { layout: "document", value: "# Notes" } });
    expect(markdown.only().config.layout).toBe("document");
    expect(markdown.only().size).toBeUndefined();

    const sized = createHarness();
    sized.context.createNodeFromDefinition(textNode, { size: { width: 640, height: 200 } });
    expect(sized.only().config.layout).toBe("fill");
    expect(sized.only().size).toEqual({ width: 640, height: 200 });
  });

  it("does not touch other kinds of node", () => {
    const harness = createHarness();

    harness.context.createNodeFromDefinition(jsonDefinition());

    expect(harness.only().config.layout).toBeUndefined();
    expect(harness.only().size).toBeUndefined();
  });

  it("saves a resized box as a box, without turning it into fixed-width Markdown", () => {
    const fill: StudioNodeInstance = {
      id: "fill",
      kind: "studio.text",
      version: "1.0.0",
      title: "Text",
      position: { x: 0, y: 0 },
      size: { width: 320, height: 72 },
      config: { layout: "fill", value: "Hello" },
      continueOnError: false,
      disabled: false,
    };
    const markdown: StudioNodeInstance = { ...fill, id: "markdown", size: { width: 320 }, config: { value: "Hello" } };
    const harness = createHarness([fill, markdown]);

    harness.context.handleNodeResize("fill", { size: { width: 640, height: 144 } });
    harness.context.handleNodeResize("markdown", { size: { width: 640 } });

    expect(fill.size).toEqual({ width: 640, height: 144 });
    expect(fill.config[STUDIO_TEXT_NODE_WIDTH_MODE_KEY]).toBeUndefined();
    expect(markdown.config[STUDIO_TEXT_NODE_WIDTH_MODE_KEY]).toBe("fixed");
  });
});
