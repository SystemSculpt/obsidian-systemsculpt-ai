/**
 * @jest-environment jsdom
 */
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../../studio/types";
import type { StudioNodeRunDisplayState } from "../../StudioRunPresentationState";
import type { StudioNodeActivity } from "../../activity/StudioActivity";
import { renderStudioGraphNodeCard } from "../StudioGraphNodeCardRenderer";
import { retiredImageGenerationNode } from "../../../../studio/nodes/retiredImageGenerationNode";
import { workflowNode } from "../../../../studio/nodes/workflowNode";
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
  return [];
}

function createDefinition(kind: string): StudioNodeDefinition {
  if (kind === "studio.workflow") return workflowNode;
  if (kind === "studio.image_generation") return retiredImageGenerationNode;
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
  it("opens retired images read-only with saved outputs, source inspection and no execution controls", () => {
    const config = { prompt: "a lighthouse", model: "saved-model", future: { keep: true } };
    const apply = jest.fn();
    const outputs = { images: [{ path: "saved.png", mimeType: "image/png", hash: "a".repeat(64), sizeBytes: 10 }] };
    const { nodeEl, graphInteraction } = renderNodeCardHarness({ kind: "studio.image_generation", config,
      nodeRunState: { ...IDLE_NODE_RUN_STATE, status: "succeeded", outputs },
      resolveAssetPreviewSrc: path => `app://vault/${path}`, onNodeSourceApply: apply });
    expect(nodeEl.dataset.surface).toBe("panel");
    expect(nodeEl.textContent).toContain("Image generation was retired. Saved outputs are preserved.");
    expect(nodeEl.querySelector<HTMLImageElement>("img")?.src).toBe("app://vault/saved.png");
    expect(nodeEl.querySelector(".ss-studio-node-run")).toBeNull();
    expect(nodeEl.querySelector("textarea")).toBeNull();
    expect(nodeEl.querySelector<HTMLInputElement>(".ss-studio-node-title-input")?.disabled).toBe(true);
    const pins = nodeEl.querySelectorAll<HTMLButtonElement>(".ss-studio-port-pin");
    expect(pins).toHaveLength(3);
    for (const pin of pins) { expect(pin.disabled).toBe(true); pin.click(); }
    expect(graphInteraction.beginConnection).not.toHaveBeenCalled();
    expect(graphInteraction.completeConnection).not.toHaveBeenCalled();
    nodeEl.querySelector<HTMLButtonElement>(".ss-studio-node-source-toggle")!.click();
    expect(nodeEl.querySelector(".ss-studio-source-code")?.textContent).toContain("a lighthouse");
    const edit = nodeEl.querySelector<HTMLButtonElement>('[data-testid="studio.source.edit.studio.image_generation_node"]')!;
    expect(edit.disabled).toBe(true);
    edit.click();
    expect(apply).not.toHaveBeenCalled();
    expect(config).toEqual({ prompt: "a lighthouse", model: "saved-model", future: { keep: true } });
  });
  it("keeps text chromeless: no header, no source, ports only", () => {
    const nodeEl = renderNodeCard({ kind: "studio.text", config: { value: "Hello" } });
    expect(nodeEl.dataset.surface).toBe("text");
    expect(nodeEl.classList.contains("ss-studio-text-node-card")).toBe(true);
    expect(nodeEl.querySelector(".ss-studio-node-header")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-source-code")).toBeNull();
    expect(nodeEl.querySelector(".ss-studio-port-pin.is-output")).not.toBeNull();
  });
  it("gives fill text the box card, and leaves Markdown text on its own card", () => {
    const fill = renderNodeCard({ kind: "studio.text", config: { layout: "fill", value: "Hello" } });
    expect(fill.dataset.surface).toBe("text");
    expect(fill.classList.contains("ss-studio-fill-text-card")).toBe(true);
    expect(fill.querySelector(".ss-studio-fill-text")?.textContent).toBe("Hello");
    expect(fill.querySelector(".ss-studio-text-node-display")).toBeNull();
    expect(fill.style.width).toBe("320px");
    expect(fill.style.minHeight).toBe("72px");
    expect(fill.querySelector(".ss-studio-port-pin.is-output")).not.toBeNull();
    expect(fill.querySelector(".ss-studio-node-header")).toBeNull();

    const markdown = renderNodeCard({ kind: "studio.text", config: { value: "Hello" } });
    expect(markdown.classList.contains("ss-studio-fill-text-card")).toBe(false);
    expect(markdown.querySelector(".ss-studio-text-node-display")).not.toBeNull();
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
  it("keeps retired workflows inspectable without Run or new connection actions", () => {
    const config = { description: "Saved objective", lastRunId: "saved-run", pendingRequest: { requestId: "saved-request" }, futureField: "<img src=x>" };
    const { nodeEl, node, graphInteraction } = renderNodeCardHarness({ kind: "studio.workflow", config });
    expect(nodeEl.querySelector('.ss-studio-node-run')).toBeNull();
    expect(nodeEl.querySelector('.ss-studio-workflow')?.textContent).toContain("Retired workflow note");
    expect(nodeEl.querySelector<HTMLInputElement>('.ss-studio-node-title-input')?.value).toBe(node.title);
    const pins = nodeEl.querySelectorAll<HTMLButtonElement>('.ss-studio-port-pin');
    expect(pins).toHaveLength(2);
    for (const pin of pins) {
      expect(pin.disabled).toBe(true);
      pin.click();
      pin.dispatchEvent(createPointerEvent('pointerdown', { pointerId: 1, clientX: 20, clientY: 20 }));
    }
    expect(graphInteraction.beginConnection).not.toHaveBeenCalled();
    expect(graphInteraction.completeConnection).not.toHaveBeenCalled();
    expect(graphInteraction.startConnectionDrag).not.toHaveBeenCalled();
    nodeEl.querySelector<HTMLButtonElement>('.ss-studio-node-source-toggle')!.click();
    const source = nodeEl.querySelector('.ss-studio-source-code')!;
    for (const text of ["saved-run", "saved-request", "futureField", "<img src=x>"]) expect(source.textContent).toContain(text);
    expect(source.querySelector("img")).toBeNull();
    expect(node.config).toEqual(config);
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
