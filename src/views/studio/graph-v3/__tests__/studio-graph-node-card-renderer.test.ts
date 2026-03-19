/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import { renderStudioGraphNodeCard } from "../StudioGraphNodeCardRenderer";

function createNode(kind: string): StudioNodeInstance {
  return {
    id: `${kind}_node`,
    kind,
    version: "1.0.0",
    title: kind,
    position: { x: 32, y: 48 },
    config: {},
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

function renderNodeCard(kind: string): HTMLElement {
  const node = createNode(kind);
  const layer = document.body.createDiv({ cls: "ss-studio-test-layer" });
  const graphInteraction = createGraphInteractionStub();

  renderStudioGraphNodeCard({
    layer,
    busy: false,
    node,
    nodeDetailMode: "expanded",
    inboundEdges: [],
    nodeRunState: IDLE_NODE_RUN_STATE,
    graphInteraction: graphInteraction as any,
    findNodeDefinition: () => createDefinition(kind),
    onRunNode: jest.fn(),
    onCopyTextGenerationPromptBundle: jest.fn(),
    onToggleTextGenerationOutputLock: jest.fn(),
    onRemoveNode: jest.fn(),
    onNodeTitleInput: jest.fn(),
    onNodeConfigMutated: jest.fn(),
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
    const nodeEl = renderNodeCard("studio.text");

    expect(nodeEl.classList.contains("has-resize-handle")).toBe(true);
    expect(nodeEl.classList.contains("is-expanded-text-node")).toBe(true);
    expect(nodeEl.querySelector(".ss-studio-node-resize-handle")).not.toBeNull();
  });

  it("mounts the shared resize handle on standard workflow nodes", () => {
    const nodeEl = renderNodeCard("studio.http_request");
    const handleEl = nodeEl.querySelector<HTMLElement>(".ss-studio-node-resize-handle");

    expect(nodeEl.classList.contains("has-resize-handle")).toBe(true);
    expect(handleEl).not.toBeNull();
    expect(handleEl?.getAttribute("aria-label")).toBe("Resize node");
  });
});
