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

function renderNodeCard(options: {
  kind: string;
  config?: StudioNodeInstance["config"];
  nodeRunState?: StudioNodeRunDisplayState;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenImageEditor?: (node: StudioNodeInstance) => void;
  onCopyNodeImageToClipboard?: (node: StudioNodeInstance) => void;
}): HTMLElement {
  const {
    kind,
    config = {},
    nodeRunState = IDLE_NODE_RUN_STATE,
    resolveAssetPreviewSrc,
    onOpenImageEditor,
    onCopyNodeImageToClipboard,
  } = options;
  const node = createNode(kind, config);
  const layer = document.body.createDiv({ cls: "ss-studio-test-layer" });
  const graphInteraction = createGraphInteractionStub();

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
    onCopyNodeImageToClipboard,
    onNodeGeometryMutated: jest.fn(),
    isLabelEditing: jest.fn(() => false),
    consumeLabelAutoFocus: jest.fn(() => false),
    onRequestLabelEdit: jest.fn(),
    onStopLabelEdit: jest.fn(),
    onRevealPathInFinder: jest.fn(),
  });

  const nodeEl = layer.querySelector<HTMLElement>(".ss-studio-node-card");
  if (!nodeEl) {
    throw new Error(`Expected rendered node card for ${kind}`);
  }
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
      onCopyNodeImageToClipboard,
    });

    const quickActions = nodeEl.querySelector<HTMLElement>(".ss-studio-node-collapsed-visibility");
    const buttons = Array.from(nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-node-collapsed-visibility-button"));
    const editButton = buttons.find((button) => button.textContent?.trim() === "Edit Image");
    const copyButton = buttons.find((button) => button.textContent?.trim() === "Copy Image");

    expect(quickActions?.textContent).toContain("Quick Actions");
    expect(editButton).toBeDefined();
    expect(copyButton).toBeDefined();

    editButton?.click();
    copyButton?.click();

    expect(onOpenImageEditor).toHaveBeenCalledTimes(1);
    expect(onCopyNodeImageToClipboard).toHaveBeenCalledTimes(1);
  });
});
