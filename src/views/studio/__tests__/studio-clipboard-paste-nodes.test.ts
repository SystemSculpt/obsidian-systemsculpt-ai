/** @jest-environment jsdom */

jest.mock("obsidian", () => {
  const actual = jest.requireActual("../../../tests/mocks/obsidian.js");
  return { ...actual, Notice: jest.fn() };
});

import { Notice } from "obsidian";
import { textNode } from "../../../studio/nodes/textNode";
import { textOutputNode } from "../../../studio/nodes/textOutputNode";
import type { StudioNodeInstance } from "../../../studio/types";
import { STUDIO_GRAPH_DEFAULT_NODE_WIDTH } from "../../../studio/StudioNodeGeometry";
import { cloneConfigDefaults, prettifyNodeKind } from "../StudioViewHelpers";
import { buildPastedTextNode } from "../systemsculpt-studio-view/StudioClipboardPasteNodes";
import { SystemSculptStudioView } from "../SystemSculptStudioView";

function buildNode(options: { text: string; position?: { x: number; y: number } }): StudioNodeInstance {
  return buildPastedTextNode({
    textNodeDefinition: textNode,
    text: options.text,
    position: options.position ?? { x: 40, y: 60 },
    nextNodeId: () => "node_paste_1",
    prettifyNodeKind,
    cloneConfigDefaults,
    normalizeNodePosition: (position) => ({
      x: Math.round(position.x),
      y: Math.round(position.y),
    }),
  });
}

describe("buildPastedTextNode", () => {
  it("creates a studio.text node carrying the pasted text", () => {
    const node = buildNode({ text: "hello world", position: { x: 10.4, y: 20.6 } });

    expect(node.kind).toBe("studio.text");
    expect(node.id).toBe("node_paste_1");
    expect(node.title).toBe("Text");
    expect(node.config.value).toBe("hello world");
    expect(node.position).toEqual({ x: 10, y: 21 });
    expect(node.disabled).toBe(false);
    expect(node.continueOnError).toBe(false);
  });

  it("keeps the default text-node width and never persists a height — text height is intrinsic", () => {
    const node = buildNode({ text: "one line" });

    expect(node.size?.width).toBe(STUDIO_GRAPH_DEFAULT_NODE_WIDTH);
    expect(node.size?.height).toBeUndefined();
    // Geometry is first-class size data, never config.
    expect(node.config.width).toBeUndefined();
    expect(node.config.height).toBeUndefined();
  });

  it("stays width-only for large multi-line pastes — the card reflows to content", () => {
    const node = buildNode({
      text: Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n"),
    });

    expect(node.size).toEqual({ width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH });
  });

  it("keeps the remaining label config defaults intact", () => {
    const node = buildNode({ text: "styled" });

    expect(node.config.fontSize).toBe(textNode.configDefaults.fontSize);
  });
});

type PasteClipboardTextContext = {
  currentProject: { graph: { nodes: StudioNodeInstance[]; edges: unknown[] } } | null;
  currentProjectPath: string | null;
  nodeDefinitions: unknown[];
  resolvePasteAnchorPosition: jest.Mock;
  normalizeNodePosition: (position: { x: number; y: number }) => { x: number; y: number };
  commitCurrentProjectMutation: jest.Mock;
  graphInteraction: {
    selectOnlyNode: jest.Mock;
    clearPendingConnection: jest.Mock;
  };
  recomputeEntryNodes: jest.Mock;
  render: jest.Mock;
};

const pasteClipboardText = (SystemSculptStudioView as unknown as {
  prototype: { pasteClipboardText: (this: PasteClipboardTextContext, text: string) => void };
}).prototype.pasteClipboardText;

function createPasteClipboardTextContext(): PasteClipboardTextContext {
  const project = { graph: { nodes: [] as StudioNodeInstance[], edges: [] as unknown[] } };
  return {
    currentProject: project,
    currentProjectPath: "Studio/Project.json",
    nodeDefinitions: [textOutputNode, textNode],
    resolvePasteAnchorPosition: jest.fn(() => ({ x: 120, y: 240 })),
    normalizeNodePosition: (position) => position,
    commitCurrentProjectMutation: jest.fn(
      (_reason: string, mutate: (project: unknown) => boolean) => mutate(project)
    ),
    graphInteraction: {
      selectOnlyNode: jest.fn(),
      clearPendingConnection: jest.fn(),
    },
    recomputeEntryNodes: jest.fn(),
    render: jest.fn(),
  };
}

describe("SystemSculptStudioView.pasteClipboardText", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("pastes plain text as a visual studio.text node, not a studio.text_output node", () => {
    const context = createPasteClipboardTextContext();

    pasteClipboardText.call(context, "pasted body");

    const nodes = context.currentProject?.graph.nodes ?? [];
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe("studio.text");
    expect(nodes[0].config.value).toBe("pasted body");
    expect(context.graphInteraction.selectOnlyNode).toHaveBeenCalledWith(nodes[0].id);
    expect(context.graphInteraction.clearPendingConnection).toHaveBeenCalled();
    expect(context.render).toHaveBeenCalled();
  });

  it("announces the paste with the text wording", () => {
    const context = createPasteClipboardTextContext();

    pasteClipboardText.call(context, "pasted body");

    expect(Notice).toHaveBeenCalledWith("Pasted as text.");
  });
});

type HandleWindowPasteContext = {
  isActiveStudioView: jest.Mock;
  busy: boolean;
  currentProject: unknown;
  currentProjectPath: string | null;
  isEditableKeyboardTarget: jest.Mock;
  graphClipboardPayload: unknown;
  graphClipboardPasteCount: number;
  pasteGraphClipboardPayload: jest.Mock;
  setError: jest.Mock;
  pasteClipboardMedia: jest.Mock;
  resolveMarkdownVaultPathFromReference: jest.Mock;
  insertVaultNoteNodes: jest.Mock;
  resolvePasteAnchorPosition: jest.Mock;
  pasteClipboardText: jest.Mock;
};

const handleWindowPaste = (SystemSculptStudioView as unknown as {
  prototype: {
    handleWindowPaste: (this: HandleWindowPasteContext, event: ClipboardEvent) => Promise<void>;
  };
}).prototype.handleWindowPaste;

function createHandleWindowPasteContext(
  overrides: Partial<HandleWindowPasteContext> = {}
): HandleWindowPasteContext {
  return {
    isActiveStudioView: jest.fn(() => true),
    busy: false,
    currentProject: { graph: { nodes: [], edges: [] } },
    currentProjectPath: "Studio/Project.json",
    isEditableKeyboardTarget: jest.fn(() => false),
    graphClipboardPayload: null,
    graphClipboardPasteCount: 0,
    pasteGraphClipboardPayload: jest.fn(),
    setError: jest.fn(),
    pasteClipboardMedia: jest.fn(async () => {}),
    resolveMarkdownVaultPathFromReference: jest.fn(() => null),
    insertVaultNoteNodes: jest.fn(async () => {}),
    resolvePasteAnchorPosition: jest.fn(() => ({ x: 0, y: 0 })),
    pasteClipboardText: jest.fn(),
    ...overrides,
  };
}

function createClipboardEventStub(options: { text?: string; files?: File[] }): ClipboardEvent {
  const files = options.files ?? [];
  return {
    defaultPrevented: false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    target: null,
    clipboardData: {
      getData: (type: string) => (type === "text/plain" ? options.text ?? "" : ""),
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      files,
    },
  } as unknown as ClipboardEvent;
}

describe("SystemSculptStudioView.handleWindowPaste", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("skips pasting when the event target is an editable element", async () => {
    const context = createHandleWindowPasteContext({
      isEditableKeyboardTarget: jest.fn(() => true),
    });
    const event = createClipboardEventStub({ text: "typed into an input" });

    await handleWindowPaste.call(context, event);

    expect(context.pasteClipboardText).not.toHaveBeenCalled();
    expect(context.pasteClipboardMedia).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("prioritizes clipboard media files over clipboard text", async () => {
    const context = createHandleWindowPasteContext();
    const file = new File(["png-bytes"], "shot.png", { type: "image/png" });
    const event = createClipboardEventStub({ text: "caption text", files: [file] });

    await handleWindowPaste.call(context, event);

    expect(context.pasteClipboardMedia).toHaveBeenCalledWith([file]);
    expect(context.pasteClipboardText).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("prioritizes single-line vault note references over text pasting", async () => {
    const context = createHandleWindowPasteContext({
      resolveMarkdownVaultPathFromReference: jest.fn(() => "Notes/Reference.md"),
    });
    const event = createClipboardEventStub({ text: "Notes/Reference.md" });

    await handleWindowPaste.call(context, event);

    expect(context.insertVaultNoteNodes).toHaveBeenCalledWith(
      ["Notes/Reference.md"],
      { x: 0, y: 0 },
      { source: "paste" }
    );
    expect(context.pasteClipboardText).not.toHaveBeenCalled();
  });

  it("routes plain text to pasteClipboardText", async () => {
    const context = createHandleWindowPasteContext();
    const event = createClipboardEventStub({ text: "plain body" });

    await handleWindowPaste.call(context, event);

    expect(context.pasteClipboardText).toHaveBeenCalledWith("plain body");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("never consults the vault resolver for multi-line text", async () => {
    const context = createHandleWindowPasteContext();
    const event = createClipboardEventStub({ text: "first line\nsecond line" });

    await handleWindowPaste.call(context, event);

    expect(context.resolveMarkdownVaultPathFromReference).not.toHaveBeenCalled();
    expect(context.pasteClipboardText).toHaveBeenCalledWith("first line\nsecond line");
  });

  it("ignores whitespace-only clipboard text", async () => {
    const context = createHandleWindowPasteContext();
    const event = createClipboardEventStub({ text: "   \n  " });

    await handleWindowPaste.call(context, event);

    expect(context.pasteClipboardText).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
