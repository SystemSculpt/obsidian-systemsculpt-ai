import type {
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../../studio/types";
import {
  STUDIO_GRAPH_CANVAS_HEIGHT,
  STUDIO_GRAPH_CANVAS_WIDTH,
  StudioGraphInteractionEngine,
} from "../StudioGraphInteractionEngine";
import type {
  StudioNodeRunDisplayState,
  StudioRunProgressDisplayState,
} from "../StudioRunPresentationState";
import { renderStudioGraphNodeCard } from "./StudioGraphNodeCardRenderer";

const SVG_NS = "http://www.w3.org/2000/svg";

export type StudioGraphWorkspaceRendererOptions = {
  root: HTMLElement;
  busy: boolean;
  currentProject: StudioProjectV1 | null;
  currentProjectPath: string | null;
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
  onOpenNodeContextMenu: (event: MouseEvent) => void;
  onRunGraph: () => void;
  onRunNode: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
};

export type StudioGraphWorkspaceRenderResult = {
  viewportEl: HTMLElement | null;
};

export function renderStudioGraphWorkspace(
  options: StudioGraphWorkspaceRendererOptions
): StudioGraphWorkspaceRenderResult {
  const {
    root,
    busy,
    currentProject,
    currentProjectPath,
    graphInteraction,
    getNodeRunState,
    runProgress,
    findNodeDefinition,
    resolveAssetPreviewSrc,
    onOpenMediaPreview,
    onOpenNodeContextMenu,
    onRunGraph,
    onRunNode,
    onRemoveNode,
    onNodeTitleInput,
  } = options;

  const editor = root.createDiv({ cls: "ss-studio-graph-workspace" });
  if (!currentProject || !currentProjectPath) {
    const emptyState = editor.createDiv({ cls: "ss-studio-empty-state" });
    emptyState.createEl("p", {
      text: "Open a .systemsculpt file from the left file explorer to edit this graph.",
      cls: "ss-studio-muted",
    });
    return { viewportEl: null };
  }

  const viewport = editor.createDiv({ cls: "ss-studio-graph-viewport" });
  graphInteraction.registerViewportElement(viewport);
  viewport.addEventListener(
    "wheel",
    (event) => graphInteraction.handleGraphViewportWheel(event as WheelEvent),
    { passive: false }
  );
  viewport.addEventListener("contextmenu", (event) => {
    const contextEvent = event as MouseEvent;
    const target = contextEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (target.closest("input, textarea, select, [contenteditable='true']")) {
      return;
    }
    if (
      target.closest(
        ".ss-studio-graph-hud, .ss-studio-graph-hint, .ss-studio-node-inspector, .ss-studio-node-context-menu"
      )
    ) {
      return;
    }
    contextEvent.preventDefault();
    contextEvent.stopPropagation();
    onOpenNodeContextMenu(contextEvent);
  });
  viewport.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    const target = pointerEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (
      target.closest(
        ".ss-studio-node-card, .ss-studio-port-pin, .ss-studio-graph-hud, .ss-studio-graph-hint, .ss-studio-link-path, .ss-studio-link-preview, .ss-studio-node-inspector, .ss-studio-node-context-menu"
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

  const hud = viewport.createDiv({ cls: "ss-studio-graph-hud" });
  const hudActions = hud.createDiv({ cls: "ss-studio-graph-hud-actions" });

  const runGraphButton = hudActions.createEl("button", {
    text: "Run Graph",
    cls: "mod-cta ss-studio-graph-hud-run",
  });
  runGraphButton.disabled = busy;
  runGraphButton.addEventListener("click", () => {
    onRunGraph();
  });

  const pendingConnection = graphInteraction.getPendingConnection();
  const linkStatus = hudActions.createEl("button", {
    text: pendingConnection ? "Cancel Link" : "Link: None",
    cls: pendingConnection ? "mod-warning" : "ss-studio-graph-hud-link",
  });
  linkStatus.disabled = !pendingConnection || busy;
  linkStatus.addEventListener("click", () => {
    graphInteraction.clearPendingConnection({ requestRender: true });
  });

  const zoomLabel = hudActions.createEl("span", {
    cls: "ss-studio-zoom-label",
    text: `${Math.round(graphInteraction.getGraphZoom() * 100)}%`,
  });
  graphInteraction.registerZoomLabelElement(zoomLabel);

  const progress = hud.createDiv({ cls: "ss-studio-run-progress" });
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

  const hint = viewport.createEl("p", {
    cls: "ss-studio-graph-hint",
    text: pendingConnection
      ? "Connection mode active: click an input dot to complete, or release on empty space to cancel."
      : "Right-click to add nodes. Drag cards to move. Hold and drag from an output dot to an input dot to connect. Pinch trackpad (or Cmd/Ctrl + wheel) to zoom. Press Delete to remove selected nodes.",
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
    renderStudioGraphNodeCard({
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
