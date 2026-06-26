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
      fields: [],
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
  onRequestLabelEdit: jest.Mock;
  onStopLabelEdit: jest.Mock;
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
  isLabelEditing?: boolean;
}): RenderNodeCardHarness {
  const {
    kind,
    config = {},
    nodeRunState = IDLE_NODE_RUN_STATE,
    resolveAssetPreviewSrc,
    onOpenImageEditor,
    onEditImageWithAi,
    onCopyNodeImageToClipboard,
    isLabelEditing = false,
  } = options;
  const node = createNode(kind, config);
  const layer = document.body.createDiv({ cls: "ss-studio-test-layer" });
  const graphInteraction = createGraphInteractionStub();
  const onRequestLabelEdit = jest.fn();
  const onStopLabelEdit = jest.fn();

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
    onRunNode: jest.fn(),
    onCopyTextGenerationPromptBundle: jest.fn(),
    onToggleTextGenerationOutputLock: jest.fn(),
    onRemoveNode: jest.fn(),
    onNodeTitleInput: jest.fn(),
    onNodeConfigMutated: jest.fn(),
    onOpenImageEditor,
    onEditImageWithAi,
    onCopyNodeImageToClipboard,
    onNodeGeometryMutated: jest.fn(),
    isLabelEditing: jest.fn(() => isLabelEditing),
    consumeLabelAutoFocus: jest.fn(() => false),
    onRequestLabelEdit,
    onStopLabelEdit,
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
    onRequestLabelEdit,
    onStopLabelEdit,
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

  it("mounts the shared resize handle on text nodes", () => {
    const nodeEl = renderNodeCard({ kind: "studio.text" });

    expect(nodeEl.classList.contains("has-resize-handle")).toBe(true);
    expect(nodeEl.classList.contains("is-expanded-text-node")).toBe(true);
    expect(nodeEl.querySelector(".ss-studio-node-resize-handle")).not.toBeNull();
  });

  it("mounts the shared resize handle on standard workflow nodes", () => {
    const nodeEl = renderNodeCard({ kind: "studio.http_request" });
    const handleEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-resize-handle");

    expect(nodeEl.classList.contains("has-resize-handle")).toBe(true);
    expect(handleEl).not.toBeNull();
    expect(handleEl?.getAttribute("aria-label")).toBe("Resize node");
  });

  it("starts dragging display-mode label cards from the label body", () => {
    const { graphInteraction, node, nodeEl } = renderNodeCardHarness({
      kind: "studio.label",
      config: { value: "Move me" },
    });
    const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-label-display");

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
      kind: "studio.label",
      config: { value: "Editable text" },
      isLabelEditing: true,
    });
    const editorEl = nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-label-editor");

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
    const { graphInteraction, node, nodeEl, onRequestLabelEdit } = renderNodeCardHarness({
      kind: "studio.label",
      config: { value: "Double click me" },
    });
    const displayEl = nodeEl.querySelector<HTMLElement>(".ss-studio-label-display");

    displayEl?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

    expect(graphInteraction.ensureSingleSelection).toHaveBeenCalledWith(node.id);
    expect(onRequestLabelEdit).toHaveBeenCalledWith(node.id);
  });

  it("opens label edit on a repeated tap even when selection re-renders the card", () => {
    const nowSpy = jest.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValueOnce(1000);
      const firstRender = renderNodeCardHarness({
        kind: "studio.label",
        config: { value: "Tap twice" },
      });
      const firstDisplayEl = firstRender.nodeEl.querySelector<HTMLElement>(".ss-studio-label-display");
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
      expect(firstRender.onRequestLabelEdit).not.toHaveBeenCalled();

      document.body.innerHTML = "";
      nowSpy.mockReturnValueOnce(1200);
      const secondRender = renderNodeCardHarness({
        kind: "studio.label",
        config: { value: "Tap twice" },
      });
      const secondDisplayEl = secondRender.nodeEl.querySelector<HTMLElement>(".ss-studio-label-display");
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
      expect(secondRender.onRequestLabelEdit).toHaveBeenCalledWith(secondRender.node.id);
      expect(secondRender.graphInteraction.startNodeDrag).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
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

  it("renders quick actions for image media-ingest nodes", () => {
    const onOpenImageEditor = jest.fn();
    const onEditImageWithAi = jest.fn();
    const onCopyNodeImageToClipboard = jest.fn();
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
      onOpenImageEditor,
      onEditImageWithAi,
      onCopyNodeImageToClipboard,
    });

    const quickActions = nodeEl.querySelector<HTMLElement>(".ss-studio-node-collapsed-visibility");
    const buttons = Array.from(nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-collapsed-visibility-button"));
    const aiEditButton = buttons.find((button) => button.textContent?.trim() === "Edit with AI");
    const editButton = buttons.find((button) => button.textContent?.trim() === "Edit Image");
    const copyButton = buttons.find((button) => button.textContent?.trim() === "Copy Image");

    expect(quickActions?.textContent).toContain("Quick Actions");
    expect(aiEditButton).toBeDefined();
    expect(editButton).toBeDefined();
    expect(copyButton).toBeDefined();

    aiEditButton?.click();
    editButton?.click();
    copyButton?.click();

    expect(onEditImageWithAi).toHaveBeenCalledTimes(1);
    expect(onOpenImageEditor).toHaveBeenCalledTimes(1);
    expect(onCopyNodeImageToClipboard).toHaveBeenCalledTimes(1);
  });
});
