/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import { renderStudioGraphNodeCard } from "../StudioGraphNodeCardRenderer";

function createNode(kind: string, config: StudioNodeInstance["config"] = {}): StudioNodeInstance {
  return {
    id: `${kind}_node`,
    kind,
    version: "1.0.0",
    title: kind,
    position: { x: 32, y: 48 },
    config,
    continueOnError: false,
    disabled: false,
  };
}

function definitionFields(kind: string): StudioNodeDefinition["configSchema"]["fields"] {
  // Mirror the real media-ingest schema so the source picker renders.
  if (kind === "studio.media_ingest") {
    return [
      {
        key: "sourcePath",
        label: "Source Path",
        type: "media_path",
        required: true,
        allowOutsideVault: true,
        mediaKinds: ["image", "video", "audio"],
      },
    ];
  }
  // Mirror the real image-generation schema keys so the static-chrome
  // contract can assert every field renders on the card.
  if (kind === "studio.image_generation") {
    return [
      { key: "prompt", label: "Prompt", type: "textarea", required: false },
      { key: "count", label: "Image Count", type: "number", required: true, min: 1, max: 4, integer: true },
      { key: "aspectRatio", label: "Aspect Ratio", type: "select", required: false, options: [] },
      { key: "imageSize", label: "Resolution", type: "select", required: false, options: [] },
      { key: "seed", label: "Seed", type: "text", required: false },
    ];
  }
  return [];
}

function createDefinition(kind: string): StudioNodeDefinition {
  return {
    kind,
    version: "1.0.0",
    capabilityClass: "local_cpu",
    cachePolicy: "never",
    inputPorts: [],
    outputPorts: [],
    configDefaults: {},
    configSchema: {
      fields: definitionFields(kind),
      allowUnknownKeys: true,
    },
    async execute() {
      return { outputs: {} };
    },
  };
}

function createGraphInteractionStub() {
  return {
    isNodeSelected: jest.fn(() => false),
    registerNodeElement: jest.fn(),
    startNodeDrag: jest.fn(),
    getGraphZoom: jest.fn(() => 1),
    registerPortElement: jest.fn(),
    isPendingConnectionSource: jest.fn(() => false),
    getPendingConnection: jest.fn(() => null),
    completeConnection: jest.fn(),
    startConnectionDrag: jest.fn(),
    consumeSuppressedOutputPortClick: jest.fn(() => false),
    beginConnection: jest.fn(),
    toggleNodeSelection: jest.fn(),
    ensureSingleSelection: jest.fn(),
  };
}

const IDLE_NODE_RUN_STATE: StudioNodeRunDisplayState = {
  status: "idle",
  message: "",
  updatedAt: null,
  outputs: null,
};

type RenderNodeCardHarness = {
  graphInteraction: ReturnType<typeof createGraphInteractionStub>;
  node: StudioNodeInstance;
  nodeEl: HTMLElement;
  onRequestTextNodeEdit: jest.Mock;
  onStopTextNodeEdit: jest.Mock;
};

function createPointerEvent(
  type: string,
  options: { pointerId: number; clientX: number; clientY: number; button?: number }
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX,
    clientY: options.clientY,
    button: options.button ?? 0,
  });
  Object.defineProperty(event, "pointerId", {
    value: options.pointerId,
    configurable: true,
  });
  return event as PointerEvent;
}

function renderNodeCardHarness(options: {
  kind: string;
  config?: StudioNodeInstance["config"];
  nodeRunState?: StudioNodeRunDisplayState;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenImageEditor?: (node: StudioNodeInstance) => void;
  onEditImageWithAi?: (node: StudioNodeInstance) => void;
  onCopyNodeImageToClipboard?: (node: StudioNodeInstance) => void;
  onRunNode?: (nodeId: string) => void;
  onRemoveNode?: (nodeId: string) => void;
  isTextNodeEditing?: boolean;
}): RenderNodeCardHarness {
  const {
    kind,
    config = {},
    nodeRunState = IDLE_NODE_RUN_STATE,
    resolveAssetPreviewSrc,
    onOpenImageEditor,
    onEditImageWithAi,
    onCopyNodeImageToClipboard,
    onRunNode = jest.fn(),
    onRemoveNode = jest.fn(),
    isTextNodeEditing = false,
  } = options;
  const node = createNode(kind, config);
  const layer = document.body.createDiv({ cls: "ss-studio-test-layer" });
  const graphInteraction = createGraphInteractionStub();
  const onRequestTextNodeEdit = jest.fn();
  const onStopTextNodeEdit = jest.fn();

  renderStudioGraphNodeCard({
    layer,
    busy: false,
    node,
    nodeDetailMode: "expanded",
    inboundEdges: [],
    nodeRunState,
    graphInteraction: graphInteraction as any,
    findNodeDefinition: () => createDefinition(kind),
    resolveAssetPreviewSrc,
    onRunNode,
    onCopyTextGenerationPromptBundle: jest.fn(),
    onToggleTextGenerationOutputLock: jest.fn(),
    onRemoveNode,
    onNodeTitleInput: jest.fn(),
    onNodeConfigMutated: jest.fn(),
    onNodeConfigValueChange: jest.fn(),
    onOpenImageEditor,
    onEditImageWithAi,
    onCopyNodeImageToClipboard,
    onNodeGeometryMutated: jest.fn(),
    isTextNodeEditing: jest.fn(() => isTextNodeEditing),
    consumeTextNodeAutoFocus: jest.fn(() => false),
    consumeTextNodeFocusPoint: jest.fn(() => undefined),
    consumeTextNodeEditorSnapshot: jest.fn(() => undefined),
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
    onRevealPathInFinder: jest.fn(),
  });

  const nodeEl = layer.querySelector<HTMLElement>(".ss-studio-node-card");
  if (!nodeEl) {
    throw new Error(`Expected rendered node card for ${kind}`);
  }
  return {
    graphInteraction,
    node,
    nodeEl,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
  };
}

function renderNodeCard(options: Parameters<typeof renderNodeCardHarness>[0]): HTMLElement {
  const { nodeEl } = renderNodeCardHarness(options);
  return nodeEl;
}

describe("renderStudioGraphNodeCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Static-chrome contract: the studio has NO hover-revealed chrome. Every
  // control — header actions, config fields, status — is a plain in-flow
  // descendant of the card, present whether or not the pointer is near it.
  it("renders all chrome in normal card flow with no hover overlay containers", () => {
    const nodeEl = renderNodeCard({ kind: "studio.http_request" });

    expect(nodeEl.querySelector(".ss-studio-node-chrome-overlay")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-chrome-overlay-top")).toBeNull();

    const header = nodeEl.querySelector<HTMLElement>(".ss-studio-node-header");
    expect(header?.parentElement).toBe(nodeEl);
    expect(header?.querySelector(".ss-studio-node-run")).not.toBeNull();
    expect(header?.querySelector(".ss-studio-node-remove")).not.toBeNull();

    const statusRow = nodeEl.querySelector<HTMLElement>(".ss-studio-node-run-status-row");
    expect(statusRow?.parentElement).toBe(nodeEl);
  });

  it("keeps every image-generation config field on the card, prompt first", () => {
    const nodeEl = renderNodeCard({
      kind: "studio.image_generation",
      config: { prompt: "", count: 1 },
    });

    const grid = nodeEl.querySelector<HTMLElement>(".ss-studio-node-inline-config-grid");
    expect(grid).not.toBeNull();
    const fieldSuffixes = Array.from(
      grid?.querySelectorAll<HTMLElement>(".ss-studio-node-inline-config-field") ?? []
    ).map((fieldEl) =>
      Array.from(fieldEl.classList)
        .find((cls) => cls.startsWith("ss-studio-node-inline-config-field--"))
        ?.replace("ss-studio-node-inline-config-field--", "")
    );
    expect(fieldSuffixes).toEqual(["prompt", "count", "aspectratio", "imagesize", "seed"]);
    // Nothing gets relocated out of the grid after render.
    for (const fieldEl of Array.from(
      nodeEl.querySelectorAll<HTMLElement>(".ss-studio-node-inline-config-field")
    )) {
      expect(fieldEl.parentElement).toBe(grid);
    }
  });

  it("mounts the shared eight-zone resize frame on text nodes", () => {
    const nodeEl = renderNodeCard({ kind: "studio.text_output" });

    expect(nodeEl.classList.contains("has-resize-frame")).toBe(true);
    expect(nodeEl.classList.contains("is-expanded-text-node")).toBe(true);
    expect(nodeEl.querySelectorAll(".ss-studio-node-resize-zone")).toHaveLength(8);
  });

  it("mounts the shared eight-zone resize frame on standard workflow nodes", () => {
    const nodeEl = renderNodeCard({ kind: "studio.http_request" });
    const zoneEls = Array.from(
      nodeEl.querySelectorAll<HTMLElement>(".ss-studio-node-resize-zone")
    );

    expect(nodeEl.classList.contains("has-resize-frame")).toBe(true);
    expect(zoneEls).toHaveLength(8);
    for (const zoneEl of zoneEls) {
      expect(zoneEl.getAttribute("aria-label")).toBe("Resize node");
    }
  });

  it("starts dragging display-mode label cards from the label body", () => {
    const { graphInteraction, node, nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "Move me" },
    });
    const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");

    expect(displayEl).not.toBeNull();
    displayEl?.dispatchEvent(
      createPointerEvent("pointerdown", {
        pointerId: 17,
        clientX: 120,
        clientY: 140,
      })
    );

    expect(graphInteraction.startNodeDrag).toHaveBeenCalledWith(
      node.id,
      expect.any(MouseEvent),
      nodeEl
    );
    window.dispatchEvent(
      createPointerEvent("pointerup", {
        pointerId: 17,
        clientX: 120,
        clientY: 140,
      })
    );
  });

  it("keeps label editing textareas out of card dragging", () => {
    const { graphInteraction, nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "Editable text" },
      isTextNodeEditing: true,
    });
    const editorEl = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-text-node-editor");

    expect(editorEl).not.toBeNull();
    editorEl?.dispatchEvent(
      createPointerEvent("pointerdown", {
        pointerId: 19,
        clientX: 120,
        clientY: 140,
      })
    );

    expect(graphInteraction.startNodeDrag).not.toHaveBeenCalled();
  });

  it("opens label edit mode on double click", () => {
    const { graphInteraction, node, nodeEl, onRequestTextNodeEdit } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "Double click me" },
    });
    const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");

    displayEl?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

    expect(graphInteraction.ensureSingleSelection).toHaveBeenCalledWith(node.id);
    expect(onRequestTextNodeEdit).toHaveBeenCalledWith(node.id, { x: 0, y: 0 });
  });

  it("opens label edit on a repeated tap even when selection re-renders the card", () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValueOnce(1000);
      const firstRender = renderNodeCardHarness({
        kind: "studio.text",
        config: { value: "Tap twice" },
      });
      const firstDisplayEl = firstRender.nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");
      firstDisplayEl?.dispatchEvent(
        createPointerEvent("pointerdown", {
          pointerId: 31,
          clientX: 120,
          clientY: 140,
        })
      );
      window.dispatchEvent(
        createPointerEvent("pointerup", {
          pointerId: 31,
          clientX: 120,
          clientY: 140,
        })
      );
      expect(firstRender.onRequestTextNodeEdit).not.toHaveBeenCalled();

      document.body.innerHTML = "";
      nowSpy.mockReturnValueOnce(1200);
      const secondRender = renderNodeCardHarness({
        kind: "studio.text",
        config: { value: "Tap twice" },
      });
      const secondDisplayEl = secondRender.nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");
      secondDisplayEl?.dispatchEvent(
        createPointerEvent("pointerdown", {
          pointerId: 32,
          clientX: 123,
          clientY: 142,
        })
      );

      expect(secondRender.graphInteraction.ensureSingleSelection).toHaveBeenCalledWith(
        secondRender.node.id
      );
      expect(secondRender.onRequestTextNodeEdit).toHaveBeenCalledWith(
        secondRender.node.id,
        { x: 123, y: 142 }
      );
      expect(secondRender.graphInteraction.startNodeDrag).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("renders the text card chromeless — no buttons, text-labeled resize frame", () => {
    const { nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "Annotated" },
    });

    // tldraw parity: the text IS the node. No toolbar, no delete button
    // (select + Delete/Backspace/cut is the removal path), no font buttons
    // (font size is drag-scaled via edges/corners).
    expect(nodeEl.querySelectorAll("button")).toHaveLength(0);
    expect(nodeEl.querySelector(".ss-studio-text-node-toolbar")).toBeNull();

    const zoneEls = Array.from(
      nodeEl.querySelectorAll<HTMLElement>(".ss-studio-node-resize-zone")
    );
    expect(zoneEls).toHaveLength(8);
    for (const zoneEl of zoneEls) {
      expect(zoneEl.getAttribute("aria-label")).toBe("Resize text");
    }
  });

  it("renders text cards with intrinsic height — no explicit height style", () => {
    const { nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "line one\nline two" },
    });

    expect(nodeEl.style.width).not.toBe("");
    expect(nodeEl.style.height).toBe("");
    expect(nodeEl.style.minHeight).toBe("");
  });

  it("auto-grows the editing textarea to its content height on input", () => {
    const { nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "start" },
      isTextNodeEditing: true,
    });
    const editorEl = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-text-node-editor");
    expect(editorEl).not.toBeNull();
    if (!editorEl) {
      return;
    }

    // rows=1 is load-bearing: a textarea defaults to rows="2", whose
    // two-line scrollHeight the auto-grow sync would lock in, rendering a
    // fresh one-line text node at double height.
    expect(editorEl.rows).toBe(1);

    Object.defineProperty(editorEl, "scrollHeight", { value: 96, configurable: true });
    editorEl.value = "start\nmore\nlines";
    editorEl.dispatchEvent(new Event("input", { bubbles: true }));

    expect(editorEl.style.height).toBe("96px");
    // The card itself never carries a fixed height.
    expect(nodeEl.style.height).toBe("");
  });

  it("shows a faint Text placeholder when the text card is empty", () => {
    const { nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "" },
    });
    const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");

    expect(displayEl?.textContent).toBe("Text");
    expect(displayEl?.classList.contains("is-placeholder")).toBe(true);
  });

  it("does not mark non-empty text cards as placeholders", () => {
    const { nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "Real content" },
    });
    const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-text-node-display");

    expect(displayEl?.textContent).toBe("Real content");
    expect(displayEl?.classList.contains("is-placeholder")).toBe(false);
  });

  it("gives the text-card editor a Text placeholder", () => {
    const { nodeEl } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "" },
      isTextNodeEditing: true,
    });
    const editorEl = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-text-node-editor");

    expect(editorEl?.getAttribute("placeholder")).toBe("Text");
  });

  it("ends the text edit session through onStopTextNodeEdit when the editor blurs", () => {
    const { node, nodeEl, onStopTextNodeEdit } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "" },
      isTextNodeEditing: true,
    });
    const editorEl = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-text-node-editor");
    expect(editorEl).not.toBeNull();

    editorEl?.dispatchEvent(new FocusEvent("blur"));

    expect(onStopTextNodeEdit).toHaveBeenCalledWith(node.id);
  });

  it("routes Escape through blur so it ends the text edit session", () => {
    const { node, nodeEl, onStopTextNodeEdit } = renderNodeCardHarness({
      kind: "studio.text",
      config: { value: "draft" },
      isTextNodeEditing: true,
    });
    const editorEl = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-text-node-editor");
    expect(editorEl).not.toBeNull();
    editorEl?.focus();

    editorEl?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );

    expect(onStopTextNodeEdit).toHaveBeenCalledWith(node.id);
  });

  it("keeps media-ingest image previews in contained mode", () => {
    const nodeEl = renderNodeCard({
      kind: "studio.media_ingest",
      config: { sourcePath: "Assets/source.png" },
      nodeRunState: {
        ...IDLE_NODE_RUN_STATE,
        outputs: {
          path: "Assets/source.png",
          preview_path: "Assets/source.png",
          source_preview_path: "Assets/source.png",
        },
      },
      resolveAssetPreviewSrc: () => "app://preview/source.png",
    });

    const previewEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-media-preview");
    const imageEl = nodeEl.querySelector<HTMLImageElement>(".ss-studio-node-media-preview-img");

    expect(previewEl?.classList.contains("is-contained-image")).toBe(true);
    expect(imageEl?.getAttribute("src")).toBe("app://preview/source.png");
  });

  const IMAGE_MEDIA_HARNESS = {
    kind: "studio.media_ingest",
    config: { sourcePath: "Assets/source.png" },
    nodeRunState: {
      ...IDLE_NODE_RUN_STATE,
      outputs: {
        path: "Assets/source.png",
        preview_path: "Assets/source.png",
        source_preview_path: "Assets/source.png",
      },
    },
    resolveAssetPreviewSrc: () => "app://preview/source.png",
  } as const;

  it("renders image media nodes as media-only cards with floating chrome", () => {
    const onOpenImageEditor = jest.fn();
    const onEditImageWithAi = jest.fn();
    const onCopyNodeImageToClipboard = jest.fn();
    const onRunNode = jest.fn();
    const onRemoveNode = jest.fn();
    const { node, nodeEl } = renderNodeCardHarness({
      ...IMAGE_MEDIA_HARNESS,
      onOpenImageEditor,
      onEditImageWithAi,
      onCopyNodeImageToClipboard,
      onRunNode,
      onRemoveNode,
    });

    expect(nodeEl.dataset.chromeLayout).toBe("media");
    // Legacy chrome stays off the image entirely — no header, no title bar.
    expect(nodeEl.querySelector(".ss-studio-node-header")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-media-node-title")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-collapsed-visibility")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-inline-config-field--sourcepath")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-chrome-overlay")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-chrome-overlay-top")).toBeNull();

    const toolbar = nodeEl.querySelector<HTMLElement>(".ss-studio-media-action-bar");
    expect(toolbar).not.toBeNull();
    const buttonFor = (label: string): HTMLButtonElement | null =>
      toolbar?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? null;

    buttonFor("Run node")?.click();
    buttonFor("Edit with AI")?.click();
    buttonFor("Edit image")?.click();
    buttonFor("Copy image")?.click();
    buttonFor("Delete node")?.click();

    expect(onRunNode).toHaveBeenCalledWith(node.id);
    expect(onEditImageWithAi).toHaveBeenCalledWith(node);
    expect(onOpenImageEditor).toHaveBeenCalledWith(node);
    expect(onCopyNodeImageToClipboard).toHaveBeenCalledWith(node);
    expect(onRemoveNode).toHaveBeenCalledWith(node.id);
    expect(buttonFor("Replace media")).not.toBeNull();
  });

  it("keeps toolbar presses off the drag gesture but drags from the image", () => {
    const { graphInteraction, node, nodeEl } = renderNodeCardHarness(IMAGE_MEDIA_HARNESS);
    const toolbar = nodeEl.querySelector<HTMLElement>(".ss-studio-media-action-bar");
    const runButton = nodeEl.querySelector<HTMLElement>('button[aria-label="Run node"]');
    expect(toolbar).not.toBeNull();

    for (const el of [toolbar, runButton]) {
      el?.dispatchEvent(
        createPointerEvent("pointerdown", { pointerId: 41, clientX: 10, clientY: 10 })
      );
    }
    expect(graphInteraction.startNodeDrag).not.toHaveBeenCalled();

    const previewEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-media-preview");
    previewEl?.dispatchEvent(
      createPointerEvent("pointerdown", { pointerId: 42, clientX: 10, clientY: 10 })
    );
    expect(graphInteraction.startNodeDrag).toHaveBeenCalledWith(
      node.id,
      expect.any(MouseEvent),
      nodeEl
    );
    window.dispatchEvent(
      createPointerEvent("pointerup", { pointerId: 42, clientX: 10, clientY: 10 })
    );
  });

  it("keeps the source picker on the card while a media node has no preview", () => {
    const nodeEl = renderNodeCard({
      kind: "studio.media_ingest",
      config: { sourcePath: "" },
    });

    expect(nodeEl.dataset.chromeLayout).toBeUndefined();
    expect(nodeEl.querySelector(".ss-studio-media-action-bar")).toBeNull();
    const sourceField = nodeEl.querySelector<HTMLElement>(
      ".ss-studio-node-inline-config-field--sourcepath"
    );
    expect(sourceField).not.toBeNull();
    // The picker must not hide inside the hover-reveal bottom overlay.
    expect(sourceField?.closest(".ss-studio-node-chrome-overlay")).toBeNull();
  });

  it("omits image-only actions from the toolbar for video previews", () => {
    const nodeEl = renderNodeCard({
      kind: "studio.media_ingest",
      config: { sourcePath: "Assets/source.mp4" },
      nodeRunState: {
        ...IDLE_NODE_RUN_STATE,
        outputs: {
          path: "Assets/source.mp4",
          preview_path: "Assets/source.mp4",
          source_preview_path: "Assets/source.mp4",
        },
      },
      resolveAssetPreviewSrc: () => "app://preview/source.mp4",
      onOpenImageEditor: jest.fn(),
      onEditImageWithAi: jest.fn(),
      onCopyNodeImageToClipboard: jest.fn(),
    });

    const toolbar = nodeEl.querySelector<HTMLElement>(".ss-studio-media-action-bar");
    expect(toolbar).not.toBeNull();
    const labels = Array.from(
      toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? []
    ).map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["Run node", "Replace media", "Delete node"]);
  });
});
