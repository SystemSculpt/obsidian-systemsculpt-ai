/** @jest-environment jsdom */

jest.mock("obsidian", () => {
  const actual = jest.requireActual("../../../tests/mocks/obsidian.js");
  return { ...actual, Notice: jest.fn() };
});

import { App, Notice, TFile, TFolder } from "obsidian";
import { mediaIngestNode } from "../../../studio/nodes/mediaIngestNode";
import { textNode } from "../../../studio/nodes/textNode";
import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import {
  StudioClipboardAndDropController,
  type StudioClipboardAndDropHost,
} from "../systemsculpt-studio-view/StudioClipboardAndDropController";

function projectWithNodes(nodes: StudioNodeInstance[] = []): StudioProjectV1 {
  return {
    schema: "studio.project.v1",
    projectId: "project_clipboard",
    name: "Clipboard project",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    engine: { apiMode: "systemsculpt_only", minPluginVersion: "1.0.0" },
    graph: { nodes, edges: [], entryNodeIds: [], groups: [] },
    permissionsRef: {
      policyVersion: 1,
      policyPath: "Studio/Clipboard.systemsculpt-assets/policy/grants.json",
    },
    settings: {
      runConcurrency: "adaptive",
      defaultFsScope: "vault",
      retention: { maxRuns: 100, maxArtifactsMb: 1024 },
    },
    migrations: { projectSchemaVersion: "1.0.0", applied: [] },
  };
}

function textInstance(id: string, position = { x: 40, y: 60 }): StudioNodeInstance {
  return {
    id,
    kind: "studio.text",
    version: "1.0.0",
    title: "Text",
    position,
    config: { value: id },
    continueOnError: false,
    disabled: false,
  };
}

type Harness = {
  app: App;
  controller: StudioClipboardAndDropController;
  host: StudioClipboardAndDropHost & {
    finalizeCreatedNodes: jest.Mock;
    removeNodes: jest.Mock;
    insertVaultNoteNodes: jest.Mock;
    storeAsset: jest.Mock;
    setError: jest.Mock;
  };
  copyText: jest.Mock;
  getProject(): StudioProjectV1 | null;
  setProject(project: StudioProjectV1 | null, path?: string | null): void;
};

function createHarness(options?: {
  project?: StudioProjectV1 | null;
  selectedNodeIds?: string[];
}): Harness {
  const app = new App();
  let project = options && "project" in options
    ? options.project ?? null
    : projectWithNodes();
  let projectPath: string | null = project ? "Studio/Clipboard.systemsculpt" : null;
  let id = 0;
  const copyText = jest.fn(async () => true);
  const host: Harness["host"] = {
    isActive: jest.fn(() => true),
    isBusy: jest.fn(() => false),
    isEditableTarget: jest.fn(() => false),
    getCurrentProject: jest.fn(() => project),
    getProjectPath: jest.fn(() => projectPath),
    getNodeDefinitions: jest.fn(() => [textNode, mediaIngestNode]),
    getSelectedNodeIds: jest.fn(() => options?.selectedNodeIds ?? []),
    getGraphZoom: jest.fn(() => 1),
    getDefaultNodePosition: jest.fn(() => ({ x: 120, y: 240 })),
    normalizeNodePosition: jest.fn((position) => ({
      x: Math.round(position.x),
      y: Math.round(position.y),
    })),
    commitNodeCreation: jest.fn((mutator) => {
      if (!project) return false;
      return mutator(project) !== false;
    }),
    finalizeCreatedNodes: jest.fn(),
    removeNodes: jest.fn(() => true),
    insertVaultNoteNodes: jest.fn(async () => {}),
    storeAsset: jest.fn(async () => ({ path: "assets/stored.png" })),
    setError: jest.fn(),
  };
  const controller = new StudioClipboardAndDropController(app, host, {
    createId: (prefix) => `${prefix}_${++id}`,
    copyText,
  });
  return {
    app,
    controller,
    host,
    copyText,
    getProject: () => project,
    setProject: (nextProject, nextPath = nextProject ? "Studio/Next.systemsculpt" : null) => {
      project = nextProject;
      projectPath = nextPath;
    },
  };
}

function clipboardEvent(options: { text?: string; files?: File[] }): ClipboardEvent {
  const files = options.files ?? [];
  return {
    defaultPrevented: false,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
    target: null,
    clipboardData: {
      getData: (type: string) => type === "text/plain" ? options.text ?? "" : "",
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      files,
    },
  } as unknown as ClipboardEvent;
}

function dataTransfer(text: string, files: File[] = []): DataTransfer {
  return {
    types: text ? ["text/plain"] : files.length > 0 ? ["Files"] : [],
    files,
    items: [],
    dropEffect: "none",
    getData: (type: string) => type === "text/plain" ? text : "",
  } as unknown as DataTransfer;
}

function dragEvent(transfer: DataTransfer): DragEvent {
  return {
    dataTransfer: transfer,
    clientX: 25,
    clientY: 35,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  } as unknown as DragEvent;
}

function noticeMessages(): string[] {
  return (Notice as unknown as jest.Mock).mock.calls.map((call) => String(call[0] ?? ""));
}

describe("StudioClipboardAndDropController", () => {
  afterEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("materializes pasted text and finalizes selection through the narrow host", () => {
    const harness = createHarness();

    expect(harness.controller.pasteClipboardText("pasted body")).toBe(true);

    const node = harness.getProject()?.graph.nodes[0];
    expect(node?.kind).toBe("studio.text");
    expect(node?.config.value).toBe("pasted body");
    expect(node?.position).toEqual({ x: 120, y: 240 });
    expect(harness.host.finalizeCreatedNodes).toHaveBeenCalledWith(
      harness.getProject(),
      {
        selection: [node?.id],
        selectionMode: "only",
        pendingConnectionMode: "default",
      },
    );
    expect(noticeMessages()).toContain("Pasted as text.");
  });

  it("routes media before text and preserves editable and whitespace defaults", async () => {
    const harness = createHarness();
    const pasteMedia = jest.spyOn(harness.controller, "pasteClipboardMedia")
      .mockResolvedValue(true);
    const pasteText = jest.spyOn(harness.controller, "pasteClipboardText");
    const file = new File(["png"], "shot.png", { type: "image/png" });
    const mediaEvent = clipboardEvent({ text: "caption", files: [file] });

    await harness.controller.handlePaste(mediaEvent);

    expect(pasteMedia).toHaveBeenCalledWith([file]);
    expect(pasteText).not.toHaveBeenCalled();
    expect(mediaEvent.preventDefault).toHaveBeenCalled();

    (harness.host.isEditableTarget as jest.Mock).mockReturnValue(true);
    const editableEvent = clipboardEvent({ text: "editor text" });
    await harness.controller.handlePaste(editableEvent);
    expect(editableEvent.preventDefault).not.toHaveBeenCalled();

    (harness.host.isEditableTarget as jest.Mock).mockReturnValue(false);
    const whitespaceEvent = clipboardEvent({ text: "  \n  " });
    await harness.controller.handlePaste(whitespaceEvent);
    expect(whitespaceEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("routes note references to note runtime but keeps multiline content as text", async () => {
    const harness = createHarness();
    const note = new TFile({ path: "Notes/Reference.md" });
    (harness.app.vault.getAbstractFileByPath as jest.Mock)
      .mockImplementation((path) => path === note.path ? note : null);

    await harness.controller.handlePaste(clipboardEvent({ text: note.path }));

    expect(harness.host.insertVaultNoteNodes).toHaveBeenCalledWith(
      [note.path],
      { x: 120, y: 240 },
      "paste",
    );

    const pasteText = jest.spyOn(harness.controller, "pasteClipboardText");
    await harness.controller.handlePaste(clipboardEvent({ text: "first\nsecond" }));
    expect(pasteText).toHaveBeenCalledWith("first\nsecond");
  });

  it("stores mixed clipboard media and selects the last materialized node", async () => {
    const harness = createHarness();
    harness.host.storeAsset
      .mockResolvedValueOnce({ path: "assets/pasted-image.png" })
      .mockResolvedValueOnce({ path: "assets/pasted-audio.ogg" });
    const image = {
      type: "image/png",
      arrayBuffer: jest.fn(async () => new ArrayBuffer(3)),
    } as unknown as File;
    const audio = {
      type: "audio/ogg",
      arrayBuffer: jest.fn(async () => new ArrayBuffer(4)),
    } as unknown as File;

    await expect(harness.controller.pasteClipboardMedia([image, audio])).resolves.toBe(true);

    const nodes = harness.getProject()?.graph.nodes ?? [];
    expect(nodes.map((node) => node.config.sourcePath)).toEqual([
      "assets/pasted-image.png",
      "assets/pasted-audio.ogg",
    ]);
    expect(harness.host.finalizeCreatedNodes).toHaveBeenCalledWith(
      harness.getProject(),
      {
        selection: [nodes[1].id],
        selectionMode: "only",
        pendingConnectionMode: "default",
      },
    );
    expect(noticeMessages()).toContain("Pasted 2 media files as Media nodes.");
  });

  it("owns graph copy state, system mirroring, and repeated-paste offsets", async () => {
    const source = textInstance("source", { x: 40, y: 60 });
    const harness = createHarness({
      project: projectWithNodes([source]),
      selectedNodeIds: [source.id],
    });

    expect(harness.controller.copySelectedGraphNodes()).toBe(true);
    await Promise.resolve();
    expect(harness.copyText).toHaveBeenCalledWith(expect.stringContaining(
      "systemsculpt.studio.clipboard.v1",
    ));
    expect(harness.controller.pasteGraphClipboardPayload()).toBe(true);
    expect(harness.controller.pasteGraphClipboardPayload()).toBe(true);

    const pasted = harness.getProject()?.graph.nodes.slice(1) ?? [];
    expect(pasted.map((node) => node.position)).toEqual([
      { x: 120, y: 240 },
      { x: 148, y: 268 },
    ]);
    expect(harness.host.finalizeCreatedNodes).toHaveBeenLastCalledWith(
      harness.getProject(),
      expect.objectContaining({
        selectionMode: "replace",
        pendingConnectionMode: "silent",
        hideNodeMenus: true,
      }),
    );
  });

  it("mirrors graph clipboard data through the bound viewport owner realm", async () => {
    const source = textInstance("source");
    const harness = createHarness({
      project: projectWithNodes([source]),
      selectedNodeIds: [source.id],
    });
    const viewport = document.createElement("div");
    harness.controller.bindViewport(viewport);

    expect(harness.controller.copySelectedGraphNodes()).toBe(true);
    await Promise.resolve();

    expect(harness.copyText).toHaveBeenCalledWith(
      expect.stringContaining("systemsculpt.studio.clipboard.v1"),
      viewport,
    );
  });

  it("does not announce a successful cut when graph removal failed", () => {
    const source = textInstance("source");
    const harness = createHarness({
      project: projectWithNodes([source]),
      selectedNodeIds: [source.id],
    });
    harness.host.removeNodes.mockReturnValue(false);

    expect(harness.controller.cutSelectedGraphNodes()).toBe(false);
    expect(noticeMessages()).toContain(
      "Unable to cut: the selected nodes no longer exist in this project.",
    );
    expect(noticeMessages().some((message) => message.startsWith("Cut "))).toBe(false);

    harness.host.removeNodes.mockReturnValue(true);
    expect(harness.controller.cutSelectedGraphNodes()).toBe(true);
    expect(noticeMessages()).toContain("Cut 1 node.");
  });

  it("classifies mixed vault drops and materializes media at the drop point", async () => {
    const harness = createHarness();
    const note = new TFile({ path: "Notes/Drop.md" });
    const media = new TFile({ path: "Media/Drop.png" });
    const folder = new TFolder({ path: "Archive" });
    const unsupported = new TFile({ path: "Docs/Drop.pdf" });
    (harness.app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path) =>
      [note, media, folder, unsupported].find((item) => item.path === path) ?? null
    );
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      scrollLeft: { value: 10, configurable: true },
      scrollTop: { value: 20, configurable: true },
    });
    viewport.getBoundingClientRect = () => ({
      x: 5,
      y: 10,
      left: 5,
      top: 10,
      right: 505,
      bottom: 410,
      width: 500,
      height: 400,
      toJSON: () => ({}),
    });
    harness.controller.bindViewport(viewport);
    const transfer = dataTransfer([
      note.path,
      media.path,
      folder.path,
      unsupported.path,
    ].join("\n"));

    await harness.controller.handleDrop(dragEvent(transfer));

    expect(harness.host.insertVaultNoteNodes).toHaveBeenCalledWith(
      [note.path],
      { x: 30, y: 45 },
      "drop",
    );
    const mediaNode = harness.getProject()?.graph.nodes.find(
      (node) => node.kind === "studio.media_ingest",
    );
    expect(mediaNode?.config.sourcePath).toBe(media.path);
    expect(mediaNode?.position).toEqual({ x: 30, y: 45 });
    expect(noticeMessages()).toContain("Dropping folders into Studio is not supported yet.");
    expect(noticeMessages()).toContain("Added 1 media file as a Media node.");
  });

  it("claims drag-over events but advertises copy only for a writable project", () => {
    const harness = createHarness();
    const transfer = dataTransfer("Notes/Drop.md");
    const event = dragEvent(transfer);

    harness.controller.handleDragOver(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(transfer.dropEffect).toBe("copy");

    (harness.host.isBusy as jest.Mock).mockReturnValue(true);
    transfer.dropEffect = "none";
    harness.controller.handleDragOver(event);
    expect(transfer.dropEffect).toBe("none");
  });

  it("reads Obsidian path references from asynchronous DataTransfer string items", async () => {
    const harness = createHarness();
    const note = new TFile({ path: "Notes/Async item.md" });
    (harness.app.vault.getAbstractFileByPath as jest.Mock)
      .mockImplementation((path) => path === note.path ? note : null);
    const transfer = {
      types: [],
      files: [],
      items: [{
        kind: "string",
        getAsString: (receive: (value: string) => void) => receive(note.path),
      }],
      dropEffect: "none",
      getData: () => "",
    } as unknown as DataTransfer;

    await harness.controller.handleDrop(dragEvent(transfer));

    expect(harness.host.insertVaultNoteNodes).toHaveBeenCalledWith(
      [note.path],
      { x: 120, y: 240 },
      "drop",
    );
  });

  it("reports unsupported-only and unresolvable payloads without mutating the graph", async () => {
    const harness = createHarness();
    const unsupported = new TFile({ path: "Docs/Drop.pdf" });
    (harness.app.vault.getAbstractFileByPath as jest.Mock)
      .mockImplementation((path) => path === unsupported.path ? unsupported : null);

    await harness.controller.handleDrop(dragEvent(dataTransfer(unsupported.path)));
    await harness.controller.handleDrop(dragEvent(dataTransfer("Missing/item.bin")));

    expect(harness.getProject()?.graph.nodes).toHaveLength(0);
    expect(noticeMessages()).toContain(
      "Only Markdown notes and media files can be dropped into Studio.",
    );
    expect(noticeMessages()).toContain("Drop a Markdown note or media file to create a node.");
  });

  it("invalidates async media ingestion when disposed or the project changes", async () => {
    const harness = createHarness();
    let resolveStore!: (asset: { path: string }) => void;
    harness.host.storeAsset.mockImplementation(() => new Promise((resolve) => {
      resolveStore = resolve;
    }));
    const mediaFile = {
      type: "image/png",
      arrayBuffer: jest.fn(async () => new ArrayBuffer(4)),
    } as unknown as File;

    const pending = harness.controller.pasteClipboardMedia([mediaFile]);
    await Promise.resolve();
    harness.controller.dispose();
    resolveStore({ path: "assets/late.png" });

    await expect(pending).resolves.toBe(false);
    expect(harness.getProject()?.graph.nodes).toHaveLength(0);
    expect(harness.host.finalizeCreatedNodes).not.toHaveBeenCalled();

    const switched = createHarness();
    let resolveSwitchedStore!: (asset: { path: string }) => void;
    switched.host.storeAsset.mockImplementation(() => new Promise((resolve) => {
      resolveSwitchedStore = resolve;
    }));
    const previousProject = switched.getProject();
    const switchedPending = switched.controller.pasteClipboardMedia([mediaFile]);
    await Promise.resolve();
    const nextProject = projectWithNodes();
    switched.setProject(nextProject);
    resolveSwitchedStore({ path: "assets/wrong-project.png" });

    await expect(switchedPending).resolves.toBe(false);
    expect(previousProject?.graph.nodes).toHaveLength(0);
    expect(nextProject.graph.nodes).toHaveLength(0);
    expect(switched.host.finalizeCreatedNodes).not.toHaveBeenCalled();
  });

  it("moves owner-window listeners and releases viewport listeners on dispose", () => {
    const harness = createHarness();
    const firstWindow = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as Window;
    const secondWindow = {
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as Window;
    const viewport = document.createElement("div");
    const addViewportListener = jest.spyOn(viewport, "addEventListener");
    const removeViewportListener = jest.spyOn(viewport, "removeEventListener");

    harness.controller.bindOwnerWindow(firstWindow);
    harness.controller.bindOwnerWindow(firstWindow);
    harness.controller.bindOwnerWindow(secondWindow);
    harness.controller.bindViewport(viewport);
    harness.controller.dispose();

    expect(firstWindow.addEventListener).toHaveBeenCalledTimes(1);
    expect(firstWindow.removeEventListener).toHaveBeenCalledTimes(1);
    expect(secondWindow.addEventListener).toHaveBeenCalledTimes(1);
    expect(secondWindow.removeEventListener).toHaveBeenCalledTimes(1);
    expect(addViewportListener).toHaveBeenCalledWith(
      "drop",
      expect.any(Function),
    );
    expect(removeViewportListener).toHaveBeenCalledWith(
      "drop",
      expect.any(Function),
    );
  });
});
