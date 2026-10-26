/** @jest-environment jsdom */

jest.mock("obsidian", () => {
  const actual = jest.requireActual("../../../tests/mocks/obsidian.js");
  return { ...actual, Notice: jest.fn() };
});

jest.mock("../../../utils/yieldToEventLoop", () => ({
  yieldToEventLoop: jest.fn(async () => undefined),
}));

import { App, Notice, TFile, TFolder } from "obsidian";
import { mediaIngestNode } from "../../../studio/nodes/mediaIngestNode";
import { textNode } from "../../../studio/nodes/textNode";
import type { StudioDiagram, StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import {
  StudioClipboardAndDropController,
  type StudioClipboardAndDropHost,
} from "../systemsculpt-studio-view/StudioClipboardAndDropController";
import { isSameClipboardImage, isSameClipboardPixels } from "../systemsculpt-studio-view/StudioClipboardData";
import { yieldToEventLoop } from "../../../utils/yieldToEventLoop";

function projectWithNodes(
  nodes: StudioNodeInstance[] = [],
  diagram?: StudioDiagram
): StudioProjectV1 {
  return {
    ...(diagram ? { diagram } : {}),
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
    getSelectedNodeIds: jest.Mock<string[], []>;
    finalizeCreatedNodes: jest.Mock;
    removeNodes: jest.Mock;
    removeDiagramSelection: jest.Mock;
    selectPastedShapes: jest.Mock;
    insertVaultNoteNodes: jest.Mock;
    storeAsset: jest.Mock;
    setError: jest.Mock;
  };
  copyText: jest.Mock;
  isSameImage: jest.Mock;
  getProject(): StudioProjectV1 | null;
  setProject(project: StudioProjectV1 | null, path?: string | null): void;
};

function createHarness(options?: {
  project?: StudioProjectV1 | null;
  selectedNodeIds?: string[];
  selectedShapeIds?: string[];
  copyNodeImage?: StudioClipboardAndDropHost["copyNodeImage"];
}): Harness {
  const app = new App();
  let project = options && "project" in options
    ? options.project ?? null
    : projectWithNodes();
  let projectPath: string | null = project ? "Studio/Clipboard.systemsculpt" : null;
  let id = 0;
  const copyText = jest.fn(async () => true);
  // A fake picture file carries its pixels as plain numbers.
  const pixelsOf = (image: Blob): number[] => (image as unknown as { looksLike?: number[] }).looksLike ?? [];
  const isSameImage = jest.fn(async (first: Blob, second: Blob) => isSameClipboardPixels(pixelsOf(first), pixelsOf(second)));
  let boundViewport: HTMLElement | null = null;
  const host: Harness["host"] = {
    ownsEventTarget: jest.fn(() => true),
    isBusy: jest.fn(() => false),
    isEditableTarget: jest.fn(() => false),
    getCurrentProject: jest.fn(() => project),
    getProjectPath: jest.fn(() => projectPath),
    getNodeDefinitions: jest.fn(() => [textNode, mediaIngestNode]),
    getSelectedNodeIds: jest.fn(() => options?.selectedNodeIds ?? []),
    getSelectedShapeIds: jest.fn(() => options?.selectedShapeIds ?? []),
    ...(options?.copyNodeImage ? { copyNodeImage: options.copyNodeImage } : {}),
    removeDiagramSelection: jest.fn(() => true),
    selectPastedShapes: jest.fn(),
    getGraphZoom: jest.fn(() => 1),
    // Mirror the engine: world = scroll-box px / zoom (origin 0 here, zoom 1).
    graphPointFromClient: jest.fn((clientX: number, clientY: number) => {
      if (!boundViewport) return null;
      const rect = boundViewport.getBoundingClientRect();
      return { x: boundViewport.scrollLeft + clientX - rect.left, y: boundViewport.scrollTop + clientY - rect.top };
    }),
    getViewportCenterWorldPoint: jest.fn(() =>
      boundViewport
        ? { x: boundViewport.scrollLeft + boundViewport.clientWidth * 0.5, y: boundViewport.scrollTop + boundViewport.clientHeight * 0.5 }
        : null
    ),
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
    isSameImage,
  });
  const bindViewport = controller.bindViewport.bind(controller);
  controller.bindViewport = (viewport) => {
    boundViewport = viewport;
    bindViewport(viewport);
  };
  return {
    app,
    controller,
    host,
    copyText,
    isSameImage,
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
    expect(noticeMessages()).toEqual([]);
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

  it("ignores a paste aimed at a surface the view does not own, such as a modal", async () => {
    const harness = createHarness();
    const modalButton = document.body.createEl("button");
    (harness.host.ownsEventTarget as jest.Mock).mockImplementation((target) => target !== modalButton);
    const pasteText = jest.spyOn(harness.controller, "pasteClipboardText");
    const event = { ...clipboardEvent({ text: "pasted into a modal" }), target: modalButton } as ClipboardEvent;

    await harness.controller.handlePaste(event);

    expect(harness.host.ownsEventTarget).toHaveBeenCalledWith(modalButton);
    expect(pasteText).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(harness.getProject()?.graph.nodes).toHaveLength(0);
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
    expect(noticeMessages()).toEqual([]);
  });

  describe("copying a picture node", () => {
    const picture = (id: string): StudioNodeInstance => ({
      id,
      kind: "studio.media_ingest",
      version: "1.0.0",
      title: "Media",
      position: { x: 40, y: 60 },
      config: { sourcePath: "assets/photo.png", captionBoard: { version: 2, layers: [] } },
      continueOnError: false,
      disabled: false,
    });
    const looksLike = (...pixels: number[]): File =>
      ({ type: "image/png", looksLike: pixels, arrayBuffer: async () => new ArrayBuffer(3) }) as unknown as File;
    const settle = async (): Promise<void> => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    };
    // Pastes reach the controller through the window it is bound to.
    const pictureHarness = (options: Parameters<typeof createHarness>[0], ownerWindow: Window = window): Harness => {
      const harness = createHarness(options);
      harness.controller.bindOwnerWindow(ownerWindow);
      return harness;
    };

    it("puts the picture itself on the clipboard, not a description of the node", async () => {
      const copyNodeImage = jest.fn(() => Promise.resolve(looksLike(10, 20, 30, 255) as Blob));
      const harness = pictureHarness({
        project: projectWithNodes([picture("photo")]),
        selectedNodeIds: ["photo"],
        copyNodeImage,
      });

      expect(harness.controller.copySelectedGraphNodes()).toBe(true);
      await settle();

      expect(copyNodeImage).toHaveBeenCalledWith("photo");
      expect(harness.copyText).not.toHaveBeenCalled();
      expect(noticeMessages()).toEqual([]);
    });

    it("copies the node after all when its picture cannot be put on the clipboard", async () => {
      const harness = pictureHarness({
        project: projectWithNodes([picture("photo")]),
        selectedNodeIds: ["photo"],
        copyNodeImage: jest.fn(() => Promise.resolve(null)),
      });

      harness.controller.copySelectedGraphNodes();
      await settle();

      expect(harness.copyText).toHaveBeenCalledWith(
        expect.stringContaining("systemsculpt.studio.clipboard.v1"),
        document.body,
      );
    });

    it("still copies nodes as nodes for anything but one picture", async () => {
      const copyNodeImage = jest.fn((nodeId: string) => (nodeId === "photo" ? Promise.resolve(looksLike(1, 2, 3, 255) as Blob) : null));
      const both = pictureHarness({
        project: projectWithNodes([picture("photo"), textInstance("note")]),
        selectedNodeIds: ["photo", "note"],
        copyNodeImage,
      });
      both.controller.copySelectedGraphNodes();
      await settle();
      expect(copyNodeImage).not.toHaveBeenCalled();
      expect(both.copyText).toHaveBeenCalledTimes(1);

      const text = pictureHarness({
        project: projectWithNodes([textInstance("note")]),
        selectedNodeIds: ["note"],
        copyNodeImage,
      });
      text.controller.copySelectedGraphNodes();
      await settle();
      expect(copyNodeImage).toHaveBeenCalledWith("note");
      expect(text.copyText).toHaveBeenCalledTimes(1);
    });

    it("brings the node back, edits and all, when that picture is pasted here again", async () => {
      const harness = pictureHarness({
        project: projectWithNodes([picture("photo")]),
        selectedNodeIds: ["photo"],
        copyNodeImage: jest.fn(() => Promise.resolve(looksLike(10, 20, 30, 255) as Blob)),
      });
      harness.controller.copySelectedGraphNodes();
      await settle();

      // The clipboard re-encodes: the pasted file is the same picture, a shade off.
      await harness.controller.handlePaste(clipboardEvent({ files: [looksLike(12, 19, 31, 255)] }));

      const nodes = harness.getProject()?.graph.nodes ?? [];
      expect(nodes).toHaveLength(2);
      expect(nodes[1]).toMatchObject({ kind: "studio.media_ingest", config: picture("photo").config });
      expect(nodes[1].id).not.toBe("photo");
      expect(harness.host.storeAsset).not.toHaveBeenCalled();
    });

    it("tells the pictures apart in the window the paste arrived in, such as a pop-out", async () => {
      const popout = { addEventListener: jest.fn(), removeEventListener: jest.fn() } as unknown as Window;
      const copied = looksLike(10, 20, 30, 255);
      const pasted = looksLike(10, 20, 30, 255);
      const harness = pictureHarness({
        project: projectWithNodes([picture("photo")]),
        selectedNodeIds: ["photo"],
        copyNodeImage: jest.fn(() => Promise.resolve(copied as Blob)),
      }, popout);
      harness.controller.copySelectedGraphNodes();
      await settle();

      await harness.controller.handlePaste(clipboardEvent({ files: [pasted] }));

      expect(harness.isSameImage).toHaveBeenCalledWith(copied, pasted, popout);
      expect(harness.getProject()?.graph.nodes).toHaveLength(2);
    });

    it("makes a new media node from any other picture pasted afterwards", async () => {
      const harness = pictureHarness({
        project: projectWithNodes([picture("photo")]),
        selectedNodeIds: ["photo"],
        copyNodeImage: jest.fn(() => Promise.resolve(looksLike(10, 20, 30, 255) as Blob)),
      });
      harness.host.storeAsset.mockResolvedValue({ path: "assets/other.png" });
      harness.controller.copySelectedGraphNodes();
      await settle();

      await harness.controller.handlePaste(clipboardEvent({ files: [looksLike(200, 20, 30, 255)] }));

      const nodes = harness.getProject()?.graph.nodes ?? [];
      expect(harness.host.storeAsset).toHaveBeenCalledTimes(1);
      expect(nodes[1].config).toEqual(expect.objectContaining({ sourcePath: "assets/other.png" }));
      expect(nodes[1].config.captionBoard).toBeUndefined();
    });

    it.each([
      ["the copied picture", true],
      ["another picture", false],
    ])("pastes nothing when the project changes while %s is being told apart", async (_which, same) => {
      const harness = pictureHarness({
        project: projectWithNodes([picture("photo")]),
        selectedNodeIds: ["photo"],
        copyNodeImage: jest.fn(() => Promise.resolve(looksLike(10, 20, 30, 255) as Blob)),
      });
      harness.controller.copySelectedGraphNodes();
      await settle();
      let answer: (same: boolean) => void = () => undefined;
      harness.isSameImage.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));

      const pasted = harness.controller.handlePaste(clipboardEvent({ files: [looksLike(10, 20, 30, 255)] }));
      await settle();
      const first = harness.getProject();
      const next = projectWithNodes();
      harness.setProject(next);
      answer(same);
      await pasted;

      expect(first?.graph.nodes).toHaveLength(1);
      expect(next.graph.nodes).toEqual([]);
      expect(harness.host.storeAsset).not.toHaveBeenCalled();
      expect(harness.host.finalizeCreatedNodes).not.toHaveBeenCalled();
    });

    it("forgets the picture once something else is copied", async () => {
      const copyNodeImage = jest.fn((nodeId: string) => (nodeId === "photo" ? Promise.resolve(looksLike(10, 20, 30, 255) as Blob) : null));
      let selection = ["photo"];
      const harness = pictureHarness({
        project: projectWithNodes([picture("photo"), textInstance("note")]),
        copyNodeImage,
      });
      harness.host.getSelectedNodeIds.mockImplementation(() => selection);
      harness.host.storeAsset.mockResolvedValue({ path: "assets/again.png" });
      harness.controller.copySelectedGraphNodes();
      await settle();
      selection = ["note"];
      harness.controller.copySelectedGraphNodes();
      await settle();

      // The same picture arriving now is just a picture: the copied node is the text one.
      await harness.controller.handlePaste(clipboardEvent({ files: [looksLike(10, 20, 30, 255)] }));

      expect(harness.host.storeAsset).toHaveBeenCalledTimes(1);
    });
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

  it("carries shapes and their arrows through one copy and paste", () => {
    const node = textInstance("source", { x: 40, y: 60 });
    const diagram: StudioDiagram = {
      shapes: [
        {
          id: "s1",
          shape: "rectangle",
          position: { x: 100, y: 60 },
          size: { width: 180, height: 120 },
          label: "One",
        },
        {
          id: "s2",
          shape: "ellipse",
          position: { x: 400, y: 60 },
          size: { width: 180, height: 120 },
          label: "Two",
        },
      ],
      arrows: [{ id: "a1", fromShapeId: "s1", toShapeId: "s2" }],
    };
    const harness = createHarness({
      project: projectWithNodes([node], diagram),
      selectedNodeIds: [node.id],
      selectedShapeIds: ["s1", "s2"],
    });

    expect(harness.controller.copySelectedGraphNodes()).toBe(true);
    expect(harness.controller.pasteGraphClipboardPayload()).toBe(true);

    const pastedShapes = harness.getProject()?.diagram?.shapes.slice(2) ?? [];
    expect(pastedShapes.map((shape) => shape.shape)).toEqual(["rectangle", "ellipse"]);
    // The node was the top-left of the copied set, so it anchors the paste.
    expect(pastedShapes.map((shape) => shape.position)).toEqual([
      { x: 180, y: 240 },
      { x: 480, y: 240 },
    ]);

    const pastedArrows = harness.getProject()?.diagram?.arrows.slice(1) ?? [];
    expect(pastedArrows).toHaveLength(1);
    expect(pastedArrows[0].fromShapeId).toBe(pastedShapes[0].id);
    expect(pastedArrows[0].toShapeId).toBe(pastedShapes[1].id);
    expect(harness.host.selectPastedShapes).toHaveBeenCalledWith(
      pastedShapes.map((shape) => shape.id),
    );
    // The pasted items appear selected on the canvas; no notice.
    expect(noticeMessages()).toEqual([]);
  });

  it("cuts a shape-only selection through the diagram layer", () => {
    const diagram: StudioDiagram = {
      shapes: [
        {
          id: "s1",
          shape: "note",
          position: { x: 10, y: 20 },
          size: { width: 180, height: 120 },
          label: "Only",
        },
      ],
      arrows: [],
    };
    const harness = createHarness({
      project: projectWithNodes([], diagram),
      selectedShapeIds: ["s1"],
    });

    expect(harness.controller.cutSelectedGraphNodes()).toBe(true);
    expect(harness.host.removeDiagramSelection).toHaveBeenCalledTimes(1);
    expect(harness.host.removeNodes).not.toHaveBeenCalled();
    expect(noticeMessages()).toEqual([]);
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
      "Unable to cut: the selection no longer exists in this project.",
    );
    expect(noticeMessages().some((message) => message.startsWith("Cut "))).toBe(false);

    harness.host.removeNodes.mockReturnValue(true);
    expect(harness.controller.cutSelectedGraphNodes()).toBe(true);
    // A cut that worked is visible: the nodes are gone.
    expect(noticeMessages()).toHaveLength(1);
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
    );
    const mediaNode = harness.getProject()?.graph.nodes.find(
      (node) => node.kind === "studio.media_ingest",
    );
    expect(mediaNode?.config.sourcePath).toBe(media.path);
    expect(mediaNode?.position).toEqual({ x: 30, y: 45 });
    expect(noticeMessages()).toEqual(["Dropping folders into Studio is not supported yet."]);
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

describe("telling a pasted picture from the one that was copied", () => {
  it("allows for the rounding of a re-encode, and nothing more", () => {
    const copied = [10, 20, 30, 255, 200, 100, 0, 128];

    expect(isSameClipboardPixels(copied, [12, 19, 31, 255, 201, 99, 1, 127])).toBe(true);
    expect(isSameClipboardPixels(copied, [10, 20, 60, 255, 200, 100, 0, 128])).toBe(false);
    expect(isSameClipboardPixels(copied, [10, 20, 30, 215, 200, 100, 0, 128])).toBe(false);
    expect(isSameClipboardPixels(copied, [10, 20, 30, 255])).toBe(false);
    // Colour under no alpha is not part of the picture.
    expect(isSameClipboardPixels([255, 0, 0, 0], [0, 0, 255, 0])).toBe(true);
  });

  describe("whole pictures", () => {
    type FakeBitmap = { width: number; height: number; pixels: Uint8ClampedArray; close: jest.Mock };
    const bitmap = (width: number, height: number): FakeBitmap => ({
      width,
      height,
      pixels: new Uint8ClampedArray(width * height * 4).fill(200),
      close: jest.fn(),
    });
    const file = (decoded: FakeBitmap | null): Blob => ({ decoded }) as unknown as Blob;
    // The window of the paste: pictures are decoded, drawn and paced there.
    const ownerWindow = {
      createImageBitmap: async (source: Blob) => {
        const decoded = (source as unknown as { decoded: FakeBitmap | null }).decoded;
        if (!decoded) throw new Error("not a picture");
        return decoded;
      },
      document: { defaultView: { createEl: (tag: string) => document.createElement(tag) } },
    } as unknown as Window;
    let getContext: jest.SpyInstance;

    beforeEach(() => {
      (yieldToEventLoop as jest.Mock).mockClear();
      // A canvas that hands back the rows it was asked to draw.
      getContext = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
        let drawn: Uint8ClampedArray = new Uint8ClampedArray(0);
        return {
          drawImage: (source: FakeBitmap, _sx: number, sy: number, sw: number, sh: number) => {
            drawn = source.pixels.subarray(sy * sw * 4, (sy + sh) * sw * 4);
          },
          getImageData: (_x: number, _y: number, width: number, height: number) => ({
            data: drawn.subarray(0, width * height * 4),
          }),
        } as unknown as CanvasRenderingContext2D;
      });
    });

    afterEach(() => {
      getContext.mockRestore();
    });

    it("knows its own picture again", async () => {
      const ours = bitmap(4096, 300);
      const theirs = bitmap(4096, 300);

      await expect(isSameClipboardImage(file(ours), file(theirs), ownerWindow)).resolves.toBe(true);
      expect(ours.close).toHaveBeenCalledTimes(1);
      expect(theirs.close).toHaveBeenCalledTimes(1);
    });

    it("lets the canvas breathe between the bands of a large picture, and only then", async () => {
      // Two bands: one pause between them, on the timer of the paste's own window.
      await isSameClipboardImage(file(bitmap(4096, 300)), file(bitmap(4096, 300)), ownerWindow);
      expect(yieldToEventLoop).toHaveBeenCalledTimes(1);
      expect(yieldToEventLoop).toHaveBeenCalledWith(0, ownerWindow);

      await isSameClipboardImage(file(bitmap(64, 48)), file(bitmap(64, 48)), ownerWindow);
      expect(yieldToEventLoop).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["first", 0],
      ["middle", 4096 * 150 + 17],
      ["last", 4096 * 300 - 1],
    ])("finds one pixel changed elsewhere, here the %s of a large picture", async (_where, pixel) => {
      const ours = bitmap(4096, 300);
      const theirs = bitmap(4096, 300);
      theirs.pixels[pixel * 4] = 0;

      await expect(isSameClipboardImage(file(ours), file(theirs), ownerWindow)).resolves.toBe(false);
    });

    it("takes a picture of another size for another picture without reading it", async () => {
      await expect(isSameClipboardImage(file(bitmap(64, 48)), file(bitmap(64, 49)), ownerWindow)).resolves.toBe(false);
      expect(getContext).not.toHaveBeenCalled();
    });

    it("matches nothing where pictures cannot be decoded at all", async () => {
      const bare = { document: ownerWindow.document } as unknown as Window;

      await expect(isSameClipboardImage(file(bitmap(64, 48)), file(bitmap(64, 48)), bare)).resolves.toBe(false);
    });

    it("matches nothing it cannot decode, and lets go of what it did decode", async () => {
      const ours = bitmap(64, 48);

      await expect(isSameClipboardImage(file(ours), file(null), ownerWindow)).resolves.toBe(false);
      expect(ours.close).toHaveBeenCalledTimes(1);
    });
  });
});
