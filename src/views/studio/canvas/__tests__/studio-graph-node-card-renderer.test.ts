/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import type { StudioNodeActivity } from "../../activity/StudioActivity";
import { renderStudioGraphNodeCard } from "../StudioGraphNodeCardRenderer";
import { EditorView } from "@codemirror/view";

const nodeTeardowns: Array<() => void> = [];

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
    ];
  }
  return [];
}

function createDefinition(kind: string): StudioNodeDefinition {
  return {
    kind,
    version: "1.0.0",
    requiredHostCapabilities: [],
    capabilityClass: "local_cpu",
    cachePolicy: "never",
    inputPorts: [],
    outputPorts: kind === "studio.text" ? [{ id: "text", type: "text" }] : [],
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
  nodeActivity?: StudioNodeActivity;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenImageEditor?: (node: StudioNodeInstance) => void;
  onEditImageWithAi?: (node: StudioNodeInstance) => void;
  onCopyNodeImageToClipboard?: (node: StudioNodeInstance) => void;
  onRunNode?: (nodeId: string) => void;
  onRemoveNode?: (nodeId: string) => void;
  isTextNodeEditing?: boolean;
  onNodeSourceApply?: (nodeId: string, source: string, expectedSource: string) => void;
}): RenderNodeCardHarness {
  const {
    kind,
    config = {},
    nodeRunState = IDLE_NODE_RUN_STATE,
    nodeActivity,
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
    nodeActivity,
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
    onNodeSourceApply: options.onNodeSourceApply,
    registerNodeTeardown: (_nodeId, teardown) => nodeTeardowns.push(teardown),
    onOpenImageEditor,
    onEditImageWithAi,
    onCopyNodeImageToClipboard,
    onNodeGeometryMutated: jest.fn(),
    takeTextNodeEditorMountState: jest.fn(() => ({ isEditing: isTextNodeEditing, shouldAutoFocus: false })),
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

describe("content-aware Studio cards", () => {
  afterEach(() => { nodeTeardowns.splice(0).forEach(teardown => teardown()); document.body.innerHTML = ""; });
  it.each([
    { value: { saved: "<b>literal</b>" } },
    { value: [1, "two"] },
    { value: null },
    { value: false },
  ])("edits a saved JSON value through the production source surface: %j", ({ value }) => {
    const apply = jest.fn();
    const nodeEl = renderNodeCard({
      kind: "studio.json",
      config: { value },
      nodeRunState: { ...IDLE_NODE_RUN_STATE, outputs: { json: { stale: true } } },
      onNodeSourceApply: apply,
    });
    const source = JSON.stringify(value, null, 2);
    expect(nodeEl.dataset.surface).toBe("code");
    expect(nodeEl.querySelector(".ss-studio-source-code")?.textContent).toBe(source);
    expect(nodeEl.querySelector(".ss-studio-source-code b")).toBeNull();
    nodeEl.querySelector<HTMLButtonElement>('[data-testid="studio.source.edit.studio.json_node"]')!.click();
    const editor = EditorView.findFromDOM(nodeEl.querySelector(".cm-editor")!)!;
    const replace = (text: string) => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
    const applyButton = nodeEl.querySelector<HTMLButtonElement>('[data-testid="studio.source.apply.studio.json_node"]')!;
    replace("{broken");
    applyButton.click();
    expect(apply).not.toHaveBeenCalled();
    expect(editor.state.doc.toString()).toBe("{broken");
    replace('{"updated":true}');
    applyButton.click();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("studio.json_node", '{"updated":true}', source);
  });
  it("never renders tabs on any surface", () => {
    for (const kind of ["studio.text", "studio.json", "studio.script", "studio.image_generation", "studio.workflow", "studio.text_generation", "studio.codex"]) {
      const nodeEl = renderNodeCard({ kind });
      expect(nodeEl.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(nodeEl.querySelector('.ss-studio-source-tabs')).toBeNull();
    }
  });
  it.each(["studio.json", "studio.script"])("shows %s source as the content with the compact chrome", kind => {
    const nodeEl = renderNodeCard({ kind });
    expect(nodeEl.dataset.surface).toBe("code");
    expect(nodeEl.classList.contains("ss-studio-surface-card")).toBe(true);
    expect(nodeEl.querySelector(".ss-studio-node-type")?.textContent).toBe(kind.replace("studio.", "").replace(/_/g, " "));
    expect(nodeEl.querySelector(".ss-studio-node-title-input")).not.toBeNull();
    expect(nodeEl.querySelector(".ss-studio-source-code")).not.toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-source-toggle")).toBeNull();
    const activity = nodeEl.querySelector<HTMLElement>('.ss-studio-node-activity');
    expect(activity?.hidden).toBe(true);
    expect(nodeEl.dataset.activity).toBe('idle');
  });
  it("renders image generation as a form with the prompt on the card and no source view", () => {
    const nodeEl = renderNodeCard({ kind: "studio.image_generation", config: { prompt: "a lighthouse" } });
    expect(nodeEl.dataset.surface).toBe("form");
    expect(nodeEl.querySelector(".ss-studio-node-inline-config-grid")).not.toBeNull();
    expect(nodeEl.querySelector<HTMLTextAreaElement>(".ss-studio-node-inline-config-textarea")?.value).toBe("a lighthouse");
    expect(nodeEl.querySelector(".ss-studio-source-code")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-source-toolbar")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-node-source-toggle")).toBeNull();
  });
  it("keeps text chromeless: no header, no source, ports only", () => {
    const nodeEl = renderNodeCard({ kind: "studio.text", config: { value: "Hello" } });
    expect(nodeEl.dataset.surface).toBe("text");
    expect(nodeEl.classList.contains("ss-studio-text-node-card")).toBe(true);
    expect(nodeEl.querySelector(".ss-studio-node-header")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-source-code")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-port-pin.is-output")).not.toBeNull();
  });
  it("opens panels on their content with one Source toggle in the header", () => {
    const nodeEl = renderNodeCard({ kind: "studio.workflow" });
    expect(nodeEl.dataset.surface).toBe("panel");
    expect(nodeEl.dataset.sourceView).toBe("panel");
    expect(nodeEl.querySelector(".ss-studio-workflow")).not.toBeNull();
    expect(nodeEl.querySelector(".ss-studio-source-code")).toBeNull();
    const toggle = nodeEl.querySelector<HTMLButtonElement>(".ss-studio-node-source-toggle")!;
    expect(toggle.dataset.testid).toBe("studio.node.source");
    expect(toggle.classList.contains("is-selected")).toBe(false);
    toggle.click();
    expect(nodeEl.dataset.sourceView).toBe("source");
    expect(nodeEl.querySelector(".ss-studio-source-code")).not.toBeNull();
    expect(toggle.classList.contains("is-selected")).toBe(true);
    toggle.click();
    expect(nodeEl.querySelector(".ss-studio-workflow")).not.toBeNull();
    expect(toggle.classList.contains("is-selected")).toBe(false);
  });
  it("shows JSON outputs beneath the source without a result view", () => {
    const nodeEl = renderNodeCard({ kind: "studio.script", config: { source: "export default () => ({ result: 1 });" }, nodeRunState: { ...IDLE_NODE_RUN_STATE, status: "succeeded", outputs: { result: { ok: true } } } });
    expect(nodeEl.querySelector('.ss-studio-source-code')?.textContent).toContain('export default');
    expect(nodeEl.querySelector('.ss-studio-node-output-preview')?.textContent).toContain('ok');
    // Settled work speaks through the content; the badge stays quiet.
    const activity = nodeEl.querySelector<HTMLElement>('.ss-studio-node-activity');
    expect(activity?.hidden).toBe(true);
    expect(activity?.dataset.activity).toBe('done');
    expect(nodeEl.dataset.activity).toBe('done');
  });
  it("paints first-frame activity from the projected snapshot when the host supplies it", () => {
    const nodeEl = renderNodeCard({ kind: "studio.json", nodeActivity: { phase: "active", label: "Running", detail: "Thinking", progress: 0.5 } });
    expect(nodeEl.dataset.activity).toBe("active");
    expect(nodeEl.getAttribute("aria-busy")).toBe("true");
    expect(nodeEl.style.getPropertyValue("--ss-activity-progress")).toBe("0.500");
    expect(nodeEl.querySelector('.ss-studio-node-activity-progress')?.textContent).toBe("50%");
  });
  it("highlights syntax and treats markup in source as literal text", () => {
    const nodeEl = renderNodeCard({kind:"studio.script", config:{source:'export default () => ({result:"<img src=x onerror=alert(1)>"});'}});
    expect(nodeEl.querySelector('.tok-keyword')).not.toBeNull();
    expect(nodeEl.querySelector('img')).toBeNull();
    expect(nodeEl.querySelector('.ss-studio-source-code')?.textContent).toContain('<img');
  });
  it("keeps source selection off the card drag path", () => {
    const h = renderNodeCardHarness({kind:"studio.json",config:{value:{note:"Select me"}}});
    h.nodeEl.querySelector('.ss-studio-source-code')!.dispatchEvent(createPointerEvent('pointerdown',{pointerId:1,clientX:20,clientY:20}));
    expect(h.graphInteraction.startNodeDrag).not.toHaveBeenCalled();
  });
  it("retains keyboard and pointer output connections", () => {
    const h = renderNodeCardHarness({kind:"studio.text",config:{value:"Hi"}});
    const pin = h.nodeEl.querySelector<HTMLButtonElement>('.ss-studio-port-pin.is-output')!;
    pin.click(); expect(h.graphInteraction.beginConnection).toHaveBeenCalledWith(h.node.id, 'text');
    pin.dispatchEvent(createPointerEvent('pointerdown',{pointerId:1,clientX:20,clientY:20}));
    expect(h.graphInteraction.startConnectionDrag).toHaveBeenCalled();
    expect(h.graphInteraction.startNodeDrag).not.toHaveBeenCalled();
  });
  it("keeps unavailable workflows inspectable with Run disabled", () => {
    const nodeEl = renderNodeCard({kind:"studio.workflow",config:{availability:{status:"unavailable"}}});
    expect(nodeEl.querySelector<HTMLButtonElement>('.ss-studio-node-run')?.disabled).toBe(true);
    expect(nodeEl.querySelector('.ss-studio-workflow')).not.toBeNull();
    nodeEl.querySelector<HTMLButtonElement>('.ss-studio-node-source-toggle')!.click();
    expect(nodeEl.querySelector('.ss-studio-source-code')).not.toBeNull();
  });
  it("retains Run and remove actions", () => {
    const run = jest.fn(), remove = jest.fn();
    const nodeEl = renderNodeCard({kind:"studio.json",onRunNode:run,onRemoveNode:remove});
    nodeEl.querySelector<HTMLButtonElement>('.ss-studio-node-run')!.click();
    nodeEl.querySelector<HTMLButtonElement>('.ss-studio-node-remove')!.click();
    expect(run).toHaveBeenCalledWith('studio.json_node'); expect(remove).toHaveBeenCalledWith('studio.json_node');
  });
  it("mounts the shared eight-zone resize frame on text nodes", () => {
    const nodeEl = renderNodeCard({ kind: "studio.text_output" });

    expect(nodeEl.classList.contains("has-resize-frame")).toBe(true);
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

});
