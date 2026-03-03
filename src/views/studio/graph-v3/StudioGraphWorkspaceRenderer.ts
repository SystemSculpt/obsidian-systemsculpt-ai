import type {
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
  StudioProjectV1,
} from "../../../studio/types";
import {
  STUDIO_GRAPH_CANVAS_HEIGHT,
  STUDIO_GRAPH_CANVAS_WIDTH,
  StudioGraphInteractionEngine,
} from "../StudioGraphInteractionEngine";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import type { StudioNodeDetailMode } from "./StudioGraphNodeDetailMode";
import { renderStudioGraphNodeCard } from "./StudioGraphNodeCardRenderer";

const SVG_NS = "http://www.w3.org/2000/svg";

export type StudioGraphWorkspaceRendererOptions = {
  root: HTMLElement;
  busy: boolean;
  currentProject: StudioProjectV1 | null;
  currentProjectPath: string | null;
  nodeDetailMode: StudioNodeDetailMode;
  graphInteraction: StudioGraphInteractionEngine;
  getNodeRunState: (nodeId: string) => StudioNodeRunDisplayState;
  findNodeDefinition: (node: StudioNodeInstance) => StudioNodeDefinition | null;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenMediaPreview?: (options: {
    kind: "image" | "video";
    path: string;
    src: string;
    title: string;
  }) => void;
  onRunGraph: () => void;
  onOpenAddNodeMenuAtViewportCenter: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleNodeDetailMode: () => void;
  onOpenNodeContextMenu: (event: MouseEvent) => void;
  onCreateLabelAtPosition: (position: { x: number; y: number }) => void;
  onRunNode: (nodeId: string) => void;
  onCopyTextGenerationPromptBundle: (nodeId: string) => void;
  onToggleTextGenerationOutputLock: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodePresentationMutated?: (node: StudioNodeInstance) => void;
  getJsonEditorPreferredMode?: () => "composer" | "raw";
  onJsonEditorPreferredModeChange?: (mode: "composer" | "raw") => void;
  renderMarkdownPreview?: (
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ) => Promise<void> | void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
  isLabelEditing: (nodeId: string) => boolean;
  consumeLabelAutoFocus: (nodeId: string) => boolean;
  onRequestLabelEdit: (nodeId: string) => void;
  onStopLabelEdit: (nodeId: string) => void;
  onRevealPathInFinder: (path: string) => void;
  resolveNodeBadge?: (node: StudioNodeInstance) => {
    text: string;
    tone?: "neutral" | "warning";
    title?: string;
  } | null;
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
    nodeDetailMode,
    graphInteraction,
    getNodeRunState,
    findNodeDefinition,
    resolveAssetPreviewSrc,
    onOpenMediaPreview,
    onRunGraph,
    onOpenAddNodeMenuAtViewportCenter,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onToggleNodeDetailMode,
    onOpenNodeContextMenu,
    onCreateLabelAtPosition,
    onRunNode,
    onCopyTextGenerationPromptBundle,
    onToggleTextGenerationOutputLock,
    onRemoveNode,
    onNodeTitleInput,
    onNodeConfigMutated,
    onNodePresentationMutated,
    getJsonEditorPreferredMode,
    onJsonEditorPreferredModeChange,
    renderMarkdownPreview,
    onNodeGeometryMutated,
    resolveDynamicSelectOptions,
    isLabelEditing,
    consumeLabelAutoFocus,
    onRequestLabelEdit,
    onStopLabelEdit,
    onRevealPathInFinder,
    resolveNodeBadge,
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
        ".ss-studio-node-inspector, .ss-studio-node-context-menu, .ss-studio-simple-context-menu, .ss-studio-group-tag, .ss-studio-group-tag-input"
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
        ".ss-studio-node-card, .ss-studio-port-pin, .ss-studio-link-path, .ss-studio-link-preview, .ss-studio-node-inspector, .ss-studio-node-context-menu, .ss-studio-simple-context-menu, .ss-studio-group-frame, .ss-studio-group-tag, .ss-studio-group-tag-input"
      )
    ) {
      return;
    }
    graphInteraction.startMarqueeSelection(pointerEvent);
  });
  viewport.addEventListener("dblclick", (event) => {
    const dblEvent = event as MouseEvent;
    const target = dblEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (
      target.closest(
        ".ss-studio-node-card, .ss-studio-port-pin, .ss-studio-link-path, .ss-studio-link-preview, .ss-studio-node-inspector, .ss-studio-node-context-menu, .ss-studio-simple-context-menu, .ss-studio-group-frame, .ss-studio-group-tag, .ss-studio-group-tag-input"
      )
    ) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const localX = dblEvent.clientX - rect.left;
    const localY = dblEvent.clientY - rect.top;
    if (!Number.isFinite(localX) || !Number.isFinite(localY)) {
      return;
    }
    const zoom = graphInteraction.getGraphZoom() || 1;
    const graphX = (viewport.scrollLeft + localX) / zoom;
    const graphY = (viewport.scrollTop + localY) / zoom;
    onCreateLabelAtPosition({
      x: graphX,
      y: graphY,
    });
  });

  const surface = viewport.createDiv({ cls: "ss-studio-graph-surface" });
  graphInteraction.registerSurfaceElement(surface);

  const canvas = surface.createDiv({ cls: "ss-studio-graph-canvas" });
  canvas.style.width = `${STUDIO_GRAPH_CANVAS_WIDTH}px`;
  canvas.style.height = `${STUDIO_GRAPH_CANVAS_HEIGHT}px`;
  graphInteraction.registerCanvasElement(canvas);

  const marquee = viewport.createDiv({ cls: "ss-studio-marquee-select" });
  graphInteraction.registerMarqueeElement(marquee);

  const controls = editor.createDiv({ cls: "ss-studio-graph-workspace-controls" });
  const runButton = controls.createEl("button", {
    cls: "ss-studio-graph-workspace-control-button is-run",
    text: "Run",
    attr: {
      "aria-label": "Run Studio graph",
      title: "Run graph",
    },
  });
  runButton.type = "button";
  runButton.disabled = busy;
  runButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    onRunGraph();
  });

  const addButton = controls.createEl("button", {
    cls: "ss-studio-graph-workspace-control-button",
    text: "Add",
    attr: {
      "aria-label": "Add node",
      title: "Add node",
    },
  });
  addButton.type = "button";
  addButton.disabled = busy;
  addButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    onOpenAddNodeMenuAtViewportCenter();
  });

  const zoomRow = controls.createDiv({ cls: "ss-studio-graph-workspace-control-zoom-row" });
  const zoomOutButton = zoomRow.createEl("button", {
    cls: "ss-studio-graph-workspace-control-button",
    text: "-",
    attr: {
      "aria-label": "Zoom out",
      title: "Zoom out",
    },
  });
  zoomOutButton.type = "button";
  zoomOutButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onZoomOut();
  });

  const zoomLabel = zoomRow.createDiv({ cls: "ss-studio-graph-workspace-control-zoom-label" });
  graphInteraction.registerZoomLabelElement(zoomLabel);

  const zoomInButton = zoomRow.createEl("button", {
    cls: "ss-studio-graph-workspace-control-button",
    text: "+",
    attr: {
      "aria-label": "Zoom in",
      title: "Zoom in",
    },
  });
  zoomInButton.type = "button";
  zoomInButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onZoomIn();
  });

  const zoomResetButton = controls.createEl("button", {
    cls: "ss-studio-graph-workspace-control-button",
    text: "100%",
    attr: {
      "aria-label": "Reset zoom",
      title: "Reset zoom",
    },
  });
  zoomResetButton.type = "button";
  zoomResetButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onZoomReset();
  });

  const detailButton = controls.createEl("button", {
    cls: "ss-studio-graph-workspace-control-button",
    text: nodeDetailMode === "collapsed" ? "Expand" : "Collapse",
    attr: {
      "aria-label": "Toggle node detail mode",
      title:
        nodeDetailMode === "collapsed"
          ? "Switch to expanded node details"
          : "Switch to collapsed node details",
    },
  });
  detailButton.type = "button";
  detailButton.classList.toggle("is-active", nodeDetailMode === "collapsed");
  detailButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggleNodeDetailMode();
  });

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
  const inboundEdgesByNode = new Map<
    string,
    Array<{ fromNodeId: string; fromPortId: string; toPortId: string }>
  >();
  for (const edge of currentProject.graph.edges) {
    const bucket = inboundEdgesByNode.get(edge.toNodeId) || [];
    bucket.push({
      fromNodeId: edge.fromNodeId,
      fromPortId: edge.fromPortId,
      toPortId: edge.toPortId,
    });
    inboundEdgesByNode.set(edge.toNodeId, bucket);
  }
  for (const node of currentProject.graph.nodes) {
    renderStudioGraphNodeCard({
      layer: nodeLayer,
      busy,
      node,
      nodeDetailMode,
      inboundEdges: inboundEdgesByNode.get(node.id) || [],
      nodeRunState: getNodeRunState(node.id),
      graphInteraction,
      findNodeDefinition,
      resolveAssetPreviewSrc,
      onOpenMediaPreview,
      onRunNode,
      onCopyTextGenerationPromptBundle,
      onToggleTextGenerationOutputLock,
      onRemoveNode,
      onNodeTitleInput,
      onNodeConfigMutated,
      onNodePresentationMutated,
      getJsonEditorPreferredMode,
      onJsonEditorPreferredModeChange,
      renderMarkdownPreview,
      onNodeGeometryMutated,
      resolveDynamicSelectOptions,
      isLabelEditing,
      consumeLabelAutoFocus,
      onRequestLabelEdit,
      onStopLabelEdit,
      onRevealPathInFinder,
      resolveNodeBadge,
    });
  }

  graphInteraction.renderGroupLayer();
  graphInteraction.refreshNodeSelectionClasses();
  graphInteraction.applyGraphZoom();
  return { viewportEl: viewport };
}
