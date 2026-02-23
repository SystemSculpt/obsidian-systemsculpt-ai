import { Notice } from "obsidian";
import type {
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../studio/types";
import {
  STUDIO_GRAPH_CANVAS_HEIGHT,
  STUDIO_GRAPH_CANVAS_WIDTH,
  StudioGraphInteractionEngine,
} from "./StudioGraphInteractionEngine";
import { definitionKey, formatNodeConfigPreview, prettifyNodeKind } from "./StudioViewHelpers";
import {
  formatNodeOutputPreview,
  statusLabelForNode,
  type StudioNodeRunDisplayState,
  type StudioRunProgressDisplayState,
} from "./StudioRunPresentationState";

const SVG_NS = "http://www.w3.org/2000/svg";

type RenderGraphNodeOptions = {
  layer: HTMLElement;
  busy: boolean;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  graphInteraction: StudioGraphInteractionEngine;
  findNodeDefinition: (node: StudioNodeInstance) => StudioNodeDefinition | null;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenMediaPreview?: (options: {
    kind: "image" | "video";
    path: string;
    src: string;
    title: string;
  }) => void;
  onRunNode: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
};

export type StudioGraphEditorRendererOptions = {
  root: HTMLElement;
  busy: boolean;
  currentProject: StudioProjectV1 | null;
  currentProjectPath: string | null;
  nodeDefinitions: StudioNodeDefinition[];
  nodePickerKey: string;
  graphInteraction: StudioGraphInteractionEngine;
  getNodeRunState: (nodeId: string) => StudioNodeRunDisplayState;
  runProgress: StudioRunProgressDisplayState;
  findNodeDefinition: (node: StudioNodeInstance) => StudioNodeDefinition | null;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenMediaPreview?: (options: {
    kind: "image" | "video";
    path: string;
    src: string;
    title: string;
  }) => void;
  onNodePickerChange: (key: string) => void;
  onRunGraph: () => void;
  onCreateNode: () => void;
  onRunNode: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
};

export type StudioGraphEditorRenderResult = {
  viewportEl: HTMLElement | null;
};

type StudioNodeMediaPreview = {
  kind: "image" | "video";
  path: string;
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "avif"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg"]);

function isAbsoluteFilesystemPath(path: string): boolean {
  const normalized = String(path || "").replace(/\\/g, "/");
  return normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized);
}
function extractPathExtension(path: string): string {
  const normalized = String(path || "").trim();
  if (!normalized) {
    return "";
  }
  const withoutQuery = normalized.split(/[?#]/, 1)[0];
  const dot = withoutQuery.lastIndexOf(".");
  if (dot < 0) {
    return "";
  }
  return withoutQuery.slice(dot + 1).trim().toLowerCase();
}

function inferMediaKind(value: { mimeType?: unknown; path?: unknown }): "image" | "video" | null {
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.trim().toLowerCase() : "";
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }

  const path = typeof value.path === "string" ? value.path.trim() : "";
  const extension = extractPathExtension(path);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return null;
}

function extractMediaPreviewFromAssetValue(value: unknown): StudioNodeMediaPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const path = typeof candidate.path === "string" ? candidate.path.trim() : "";
  if (!path) {
    return null;
  }
  const kind = inferMediaKind(candidate);
  if (!kind) {
    return null;
  }
  return {
    kind,
    path,
  };
}

function resolveNodeMediaPreview(
  node: StudioNodeInstance,
  outputs: Record<string, unknown> | null
): StudioNodeMediaPreview | null {
  if (node.kind === "studio.image_generation") {
    return null;
  }

  if (node.kind === "studio.media_ingest") {
    const config = (node.config || {}) as Record<string, unknown>;
    const previewPath = typeof outputs?.preview_path === "string" ? outputs.preview_path.trim() : "";
    const configuredPath = typeof config.sourcePath === "string" ? config.sourcePath.trim() : "";
    const outputPath = typeof outputs?.path === "string" ? outputs.path.trim() : "";
    const mediaKindPath = outputPath || configuredPath || previewPath;
    const renderPath = previewPath || outputPath || configuredPath;
    if (!mediaKindPath || !renderPath) {
      return null;
    }
    if (!previewPath && isAbsoluteFilesystemPath(mediaKindPath)) {
      // Absolute local paths are not directly previewable in the renderer sandbox.
      // media_ingest should emit preview_path (vault asset) for these cases.
      return null;
    }
    const kind = inferMediaKind({ path: mediaKindPath });
    if (!kind) {
      return null;
    }
    return {
      kind,
      path: renderPath,
    };
  }

  const pathOutput = typeof outputs?.path === "string" ? outputs.path.trim() : "";
  if (pathOutput) {
    const kind = inferMediaKind({ path: pathOutput });
    if (kind) {
      return {
        kind,
        path: pathOutput,
      };
    }
  }

  const images = Array.isArray(outputs?.images) ? outputs?.images : [];
  for (const image of images) {
    const preview = extractMediaPreviewFromAssetValue(image);
    if (preview?.kind === "image") {
      return preview;
    }
  }
  return null;
}

function renderGraphNode(options: RenderGraphNodeOptions): void {
  const {
    layer,
    busy,
    node,
    nodeRunState,
    graphInteraction,
    findNodeDefinition,
    resolveAssetPreviewSrc,
    onOpenMediaPreview,
    onRunNode,
    onRemoveNode,
    onNodeTitleInput,
  } = options;

  const definition = findNodeDefinition(node);

  const nodeEl = layer.createDiv({ cls: "ss-studio-node-card" });
  nodeEl.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
  nodeEl.classList.toggle("is-selected", graphInteraction.isNodeSelected(node.id));
  graphInteraction.registerNodeElement(node.id, nodeEl);

  const header = nodeEl.createDiv({ cls: "ss-studio-node-header" });
  const titleInput = header.createEl("input", {
    type: "text",
    cls: "ss-studio-node-title-input",
  });
  titleInput.value = node.title;
  titleInput.disabled = busy;
  titleInput.addEventListener("input", (event) => {
    onNodeTitleInput(node, (event.target as HTMLInputElement).value);
  });

  const runButton = header.createEl("button", {
    text: "Run",
    cls: "ss-studio-node-run",
  });
  runButton.disabled = busy;
  runButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onRunNode(node.id);
  });

  const removeButton = header.createEl("button", {
    text: "×",
    cls: "ss-studio-node-remove",
  });
  removeButton.disabled = busy;
  removeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onRemoveNode(node.id);
  });

  nodeEl.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    const target = pointerEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (target.closest("input, button, select, textarea, a, .ss-studio-port-pin")) {
      return;
    }

    const modifierToggle = pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey;
    if (modifierToggle) {
      graphInteraction.toggleNodeSelection(node.id);
      return;
    }

    // Preserve multi-selection when dragging any already-selected node.
    if (!graphInteraction.isNodeSelected(node.id)) {
      graphInteraction.ensureSingleSelection(node.id);
    }
    graphInteraction.startNodeDrag(node.id, pointerEvent, nodeEl);
  });

  nodeEl.createEl("div", {
    cls: "ss-studio-node-kind",
    text: `${node.kind}@${node.version}`,
  });

  const statusRow = nodeEl.createDiv({ cls: "ss-studio-node-run-status-row" });
  statusRow.createDiv({
    cls: `ss-studio-node-run-status is-${nodeRunState.status}`,
    text: statusLabelForNode(nodeRunState.status),
  });
  const statusMessage = nodeRunState.message.trim();
  if (statusMessage) {
    statusRow.createDiv({
      cls: "ss-studio-node-run-message",
      text: statusMessage,
    });
  }

  const ports = nodeEl.createDiv({ cls: "ss-studio-node-ports" });
  const inputsCol = ports.createDiv({ cls: "ss-studio-node-ports-col" });
  const outputsCol = ports.createDiv({ cls: "ss-studio-node-ports-col" });

  const inputPorts = definition?.inputPorts || [];
  if (inputPorts.length === 0) {
    inputsCol.createEl("div", { cls: "ss-studio-node-port-empty", text: "No inputs" });
  } else {
    for (const port of inputPorts) {
      const row = inputsCol.createDiv({ cls: "ss-studio-port-row" });
      const pin = row.createEl("button", {
        cls: "ss-studio-port-pin is-input",
        attr: {
          title: `${port.id} (${port.type})`,
        },
      });
      pin.dataset.nodeId = node.id;
      pin.dataset.portId = port.id;
      pin.dataset.portDirection = "in";
      pin.disabled = busy;
      row.createEl("span", {
        cls: "ss-studio-port-label",
        text: `${port.id}${port.required ? "*" : ""}`,
      });

      graphInteraction.registerPortElement(node.id, "in", port.id, pin);
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!graphInteraction.getPendingConnection()) {
          new Notice("Select an output port first.");
          return;
        }
        graphInteraction.completeConnection(node.id, port.id);
      });
    }
  }

  const outputPorts = definition?.outputPorts || [];
  if (outputPorts.length === 0) {
    outputsCol.createEl("div", { cls: "ss-studio-node-port-empty", text: "No outputs" });
  } else {
    for (const port of outputPorts) {
      const row = outputsCol.createDiv({ cls: "ss-studio-port-row is-output" });
      row.createEl("span", {
        cls: "ss-studio-port-label",
        text: port.id,
      });
      const pin = row.createEl("button", {
        cls: `ss-studio-port-pin is-output ${
          graphInteraction.isPendingConnectionSource(node.id, port.id)
            ? "is-active"
            : ""
        }`,
        attr: {
          title: `${port.id} (${port.type})`,
        },
      });
      pin.dataset.nodeId = node.id;
      pin.dataset.portId = port.id;
      pin.dataset.portDirection = "out";
      pin.disabled = busy;
      graphInteraction.registerPortElement(node.id, "out", port.id, pin);
      pin.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        graphInteraction.startConnectionDrag(node.id, port.id, event as PointerEvent, pin);
      });
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        if (graphInteraction.consumeSuppressedOutputPortClick(node.id, port.id)) {
          return;
        }
        graphInteraction.beginConnection(node.id, port.id);
      });
    }
  }

  if (!definition) {
    nodeEl.createEl("p", {
      cls: "ss-studio-inline-error",
      text: `Missing definition for ${node.kind}@${node.version}.`,
    });
    return;
  }

  const configPreviewEl = nodeEl.createEl("p", {
    cls: "ss-studio-node-config-preview",
    text: formatNodeConfigPreview(node),
  });
  configPreviewEl.setAttribute("data-node-config-preview", node.id);

  const outputPreview =
    node.kind === "studio.image_generation" ? "" : formatNodeOutputPreview(nodeRunState.outputs);
  if (outputPreview) {
    nodeEl.createEl("p", {
      cls: "ss-studio-node-output-preview",
      text: outputPreview,
    });
  }

  const mediaPreview = resolveNodeMediaPreview(
    node,
    nodeRunState.outputs as Record<string, unknown> | null
  );
  if (mediaPreview && resolveAssetPreviewSrc) {
    const previewSrc = resolveAssetPreviewSrc(mediaPreview.path);
    if (previewSrc) {
      const previewEl = nodeEl.createDiv({ cls: "ss-studio-node-media-preview" });
      previewEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        onOpenMediaPreview?.({
          kind: mediaPreview.kind,
          path: mediaPreview.path,
          src: previewSrc,
          title: node.title || node.kind,
        });
      });
      if (mediaPreview.kind === "image") {
        const imageEl = previewEl.createEl("img", {
          cls: "ss-studio-node-media-preview-img",
        });
        imageEl.src = previewSrc;
        imageEl.alt = `${node.title || node.kind} output image`;
        imageEl.loading = "lazy";
        imageEl.decoding = "async";
        imageEl.draggable = false;
      } else {
        const videoEl = previewEl.createEl("video", {
          cls: "ss-studio-node-media-preview-video",
        });
        videoEl.src = previewSrc;
        videoEl.muted = true;
        videoEl.controls = true;
        videoEl.playsInline = true;
        videoEl.preload = "metadata";
        videoEl.setAttribute("aria-label", `${node.title || node.kind} output video`);
      }
    }
  }
}

export function renderStudioGraphEditor(
  options: StudioGraphEditorRendererOptions
): StudioGraphEditorRenderResult {
  const {
    root,
    busy,
    currentProject,
    currentProjectPath,
    nodeDefinitions,
    nodePickerKey,
    graphInteraction,
    getNodeRunState,
    runProgress,
    findNodeDefinition,
    resolveAssetPreviewSrc,
    onOpenMediaPreview,
    onNodePickerChange,
    onRunGraph,
    onCreateNode,
    onRunNode,
    onRemoveNode,
    onNodeTitleInput,
  } = options;

  const editor = root.createDiv({ cls: "ss-studio-graph" });
  if (!currentProject || !currentProjectPath) {
    const emptyState = editor.createDiv({ cls: "ss-studio-empty-state" });
    emptyState.createEl("p", {
      text: "Open a .systemsculpt file from the left file explorer to edit this graph.",
      cls: "ss-studio-muted",
    });
    return { viewportEl: null };
  }

  const header = editor.createDiv({ cls: "ss-studio-graph-header" });
  const controls = header.createDiv({ cls: "ss-studio-graph-controls" });

  const viewport = editor.createDiv({ cls: "ss-studio-graph-viewport" });
  graphInteraction.registerViewportElement(viewport);
  viewport.addEventListener(
    "wheel",
    (event) => graphInteraction.handleGraphViewportWheel(event as WheelEvent),
    { passive: false }
  );
  viewport.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    const target = pointerEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (
      target.closest(
        ".ss-studio-node-card, .ss-studio-port-pin, .ss-studio-graph-controls, .ss-studio-graph-hint, .ss-studio-edge-path, .ss-studio-edge-preview, .ss-studio-node-inspector"
      )
    ) {
      return;
    }
    graphInteraction.startMarqueeSelection(pointerEvent);
  });

  const surface = viewport.createDiv({ cls: "ss-studio-graph-surface" });
  graphInteraction.registerSurfaceElement(surface);

  const canvas = surface.createDiv({ cls: "ss-studio-graph-canvas" });
  canvas.style.width = `${STUDIO_GRAPH_CANVAS_WIDTH}px`;
  canvas.style.height = `${STUDIO_GRAPH_CANVAS_HEIGHT}px`;
  graphInteraction.registerCanvasElement(canvas);

  const picker = controls.createEl("select", { cls: "ss-studio-select" });
  for (const definition of nodeDefinitions) {
    const key = definitionKey(definition);
    const option = picker.createEl("option", {
      text: `${prettifyNodeKind(definition.kind)} (${definition.kind})`,
    });
    option.value = key;
  }
  picker.value = nodePickerKey;
  picker.disabled = busy;
  picker.addEventListener("change", (event) => {
    onNodePickerChange((event.target as HTMLSelectElement).value);
  });

  const runGraphButton = controls.createEl("button", {
    text: "Run Graph",
    cls: "mod-cta",
  });
  runGraphButton.disabled = busy;
  runGraphButton.addEventListener("click", () => {
    onRunGraph();
  });

  const addNodeButton = controls.createEl("button", {
    text: "Add Node",
  });
  addNodeButton.disabled = busy;
  addNodeButton.addEventListener("click", () => {
    onCreateNode();
  });

  const progress = controls.createDiv({ cls: "ss-studio-run-progress" });
  progress.createDiv({
    cls: "ss-studio-run-progress-label",
    text:
      runProgress.total > 0
        ? `${runProgress.completed}/${runProgress.total} (${runProgress.percent}%)`
        : "0/0 (0%)",
  });
  const progressTrack = progress.createDiv({ cls: "ss-studio-run-progress-track" });
  const progressFill = progressTrack.createDiv({ cls: "ss-studio-run-progress-fill" });
  progressFill.style.width = `${Math.max(0, Math.min(100, runProgress.percent))}%`;
  progress.dataset.status = runProgress.status;
  if (runProgress.message.trim().length > 0) {
    progress.setAttribute("title", runProgress.message.trim());
  }

  const zoomLabel = controls.createEl("span", {
    cls: "ss-studio-zoom-label",
    text: `${Math.round(graphInteraction.getGraphZoom() * 100)}%`,
  });
  graphInteraction.registerZoomLabelElement(zoomLabel);

  const pendingConnection = graphInteraction.getPendingConnection();
  const linkStatus = controls.createEl("button", {
    text: pendingConnection ? "Cancel Link" : "Link: None",
    cls: pendingConnection ? "mod-warning" : "",
  });
  linkStatus.disabled = !pendingConnection || busy;
  linkStatus.addEventListener("click", () => {
    graphInteraction.clearPendingConnection({ requestRender: true });
  });

  const hint = viewport.createEl("p", {
    cls: "ss-studio-graph-hint",
    text: pendingConnection
      ? "Connection mode active: click an input dot to complete, or release on empty space to cancel."
      : "Drag cards to move. Hold and drag from an output dot to an input dot to connect. Click an active output dot again to deselect. Pinch trackpad (or Cmd/Ctrl + wheel) to zoom. Click an edge to delete it.",
  });
  hint.setAttribute("data-connection-active", pendingConnection ? "true" : "false");

  const marquee = viewport.createDiv({ cls: "ss-studio-marquee-select" });
  graphInteraction.registerMarqueeElement(marquee);

  canvas.addEventListener("click", (event) => {
    graphInteraction.handleCanvasBackgroundClick(event.target as HTMLElement);
  });

  const edgesLayer = document.createElementNS(SVG_NS, "svg");
  edgesLayer.setAttribute("class", "ss-studio-edges-layer");
  edgesLayer.setAttribute("viewBox", `0 0 ${STUDIO_GRAPH_CANVAS_WIDTH} ${STUDIO_GRAPH_CANVAS_HEIGHT}`);
  edgesLayer.setAttribute("width", String(STUDIO_GRAPH_CANVAS_WIDTH));
  edgesLayer.setAttribute("height", String(STUDIO_GRAPH_CANVAS_HEIGHT));
  canvas.appendChild(edgesLayer);
  graphInteraction.registerEdgesLayerElement(edgesLayer);

  const nodeLayer = canvas.createDiv({ cls: "ss-studio-nodes-layer" });
  graphInteraction.clearGraphElementMaps();
  for (const node of currentProject.graph.nodes) {
    renderGraphNode({
      layer: nodeLayer,
      busy,
      node,
      nodeRunState: getNodeRunState(node.id),
      graphInteraction,
      findNodeDefinition,
      resolveAssetPreviewSrc,
      onOpenMediaPreview,
      onRunNode,
      onRemoveNode,
      onNodeTitleInput,
    });
  }

  graphInteraction.refreshNodeSelectionClasses();
  graphInteraction.applyGraphZoom();
  return { viewportEl: viewport };
}
