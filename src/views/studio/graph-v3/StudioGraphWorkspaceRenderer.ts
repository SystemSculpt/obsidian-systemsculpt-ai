import type {
  StudioJsonValue,
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
import type { StudioNodeConfigPathBrowseOptions } from "../StudioPathFieldPicker";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import type { StudioNodeDetailMode } from "./StudioGraphNodeDetailMode";
import { renderStudioGraphNodeCard } from "./StudioGraphNodeCardRenderer";
import type {
  StudioGraphNodeMutationOptions,
  StudioGraphNodeResizePatch,
} from "./StudioGraphNodeCardTypes";
import type {
  StudioTextNodeMarkdownEditorFactory,
  StudioTextNodeMarkdownEditorSnapshot,
} from "./StudioGraphTextNodeCard";
import type { StudioTextNodeFocusTarget } from "./StudioGraphTextNodeFocus";
import {
  resolveStudioCanvasToolShape,
  type StudioCanvasTool,
} from "../StudioCanvasTool";
import { createStudioAction } from "../StudioAction";
import { createStudioSvgElement } from "../StudioDomContext";
import {
  renderStudioShapeLayer,
  type StudioShapeLayerHandle,
  type StudioShapeLayerOptions,
} from "../shapes/StudioShapeLayer";
import { readStudioDiagramFromProject } from "../../../studio/StudioShapes";

type StudioWorkspaceControlOptions = Readonly<{
  label: string;
  testId: string;
  ariaLabel: string;
  title?: string;
  icon?: string;
  disabled?: boolean;
  selected?: boolean;
  className?: string;
  /** "icon" drops the visible label; the tools row uses it to stay compact. */
  size?: "small" | "icon";
  onSelect: () => void;
}>;

function createStudioWorkspaceControl(
  parent: HTMLElement,
  options: StudioWorkspaceControlOptions,
): HTMLButtonElement {
  const button = createStudioAction(parent, {
    label: options.label,
    testId: options.testId,
    ariaLabel: options.ariaLabel,
    icon: options.icon,
    className: `ss-studio-graph-workspace-control-button${options.className ? ` ${options.className}` : ""}`,
    size: options.size ?? "small",
    disabled: options.disabled,
    selected: options.selected,
    title: options.title ?? options.ariaLabel,
    onSelect: () => {
      options.onSelect();
    },
  });
  return button;
}

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
  /** Armed diagram tool; "select" is the normal pointer. */
  activeCanvasTool: StudioCanvasTool;
  onSelectCanvasTool: (tool: StudioCanvasTool) => void;
  /** Diagram layer callbacks — shapes and arrows, never nodes and edges. */
  shapeLayer: Pick<
    StudioShapeLayerOptions,
    | "selection"
    | "onSelect"
    | "onMoveSelection"
    | "onResizeShape"
    | "onLabelChange"
    | "onArrowLabelChange"
    | "onConnectShapes"
  > & { registerLayerHandle: (handle: StudioShapeLayerHandle | null) => void };
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomOverview: () => void;
  onToggleNodeDetailMode: () => void;
  onOpenNodeContextMenu: (event: MouseEvent) => void;
  onCreateTextNodeAtPosition: (position: { x: number; y: number }) => void;
  onRunNode: (nodeId: string) => void;
  onCopyTextGenerationPromptBundle: (nodeId: string) => void;
  onToggleTextGenerationOutputLock: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onNodeResize?: (
    nodeId: string,
    patch: StudioGraphNodeResizePatch,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onOpenImageEditor?: (node: StudioNodeInstance) => void;
  onEditImageWithAi?: (node: StudioNodeInstance) => void;
  onCopyNodeImageToClipboard?: (node: StudioNodeInstance) => void;
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
  isTextNodeEditing: (nodeId: string) => boolean;
  consumeTextNodeAutoFocus: (nodeId: string) => boolean;
  consumeTextNodeFocusPoint: (nodeId: string) => StudioTextNodeFocusTarget | undefined;
  consumeTextNodeEditorSnapshot: (
    nodeId: string
  ) => StudioTextNodeMarkdownEditorSnapshot | undefined;
  onRequestTextNodeEdit: (nodeId: string, focusAt?: StudioTextNodeFocusTarget) => void;
  onStopTextNodeEdit: (nodeId: string) => void;
  createTextNodeMarkdownEditor?: StudioTextNodeMarkdownEditorFactory;
  registerTextNodeEditorTeardown?: (
    nodeId: string,
    teardown: () => StudioTextNodeMarkdownEditorSnapshot
  ) => void;
  onRevealPathInFinder: (path: string) => void;
  pathBrowseOptions?: StudioNodeConfigPathBrowseOptions;
  resolveNodeBadge?: (node: StudioNodeInstance) => {
    text: string;
    tone?: "neutral" | "warning";
    title?: string;
  } | null;
};

export type StudioGraphWorkspaceRenderResult = {
  viewportEl: HTMLElement | null;
  /** Zoomed graph-coordinate layer; canvas gestures measure against it. */
  canvasEl: HTMLElement | null;
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
    activeCanvasTool,
    onSelectCanvasTool,
    shapeLayer,
    onZoomIn,
    onZoomOut,
    onZoomReset,
    onZoomOverview,
    onToggleNodeDetailMode,
    onOpenNodeContextMenu,
    onCreateTextNodeAtPosition,
    onRunNode,
    onCopyTextGenerationPromptBundle,
    onToggleTextGenerationOutputLock,
    onRemoveNode,
    onNodeTitleInput,
    onNodeConfigMutated,
    onNodeConfigValueChange,
    onNodeResize,
    onOpenImageEditor,
    onEditImageWithAi,
    onCopyNodeImageToClipboard,
    getJsonEditorPreferredMode,
    onJsonEditorPreferredModeChange,
    renderMarkdownPreview,
    onNodeGeometryMutated,
    resolveDynamicSelectOptions,
    isTextNodeEditing,
    consumeTextNodeAutoFocus,
    consumeTextNodeFocusPoint,
    consumeTextNodeEditorSnapshot,
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
    createTextNodeMarkdownEditor,
    registerTextNodeEditorTeardown,
    onRevealPathInFinder,
    pathBrowseOptions,
    resolveNodeBadge,
  } = options;

  const editor = root.createDiv({ cls: "ss-studio-graph-workspace" });
  if (!currentProject || !currentProjectPath) {
    const emptyState = editor.createDiv({ cls: "ss-studio-empty-state" });
    emptyState.createEl("p", {
      text: "Open a .systemsculpt file from the left file explorer to edit this graph.",
      cls: "ss-studio-muted",
    });
    return { viewportEl: null, canvasEl: null };
  }

  const viewport = editor.createDiv({ cls: "ss-studio-graph-viewport" });
  viewport.classList.toggle("is-arrow-tool", activeCanvasTool === "arrow");
  viewport.classList.toggle(
    "is-shape-tool",
    resolveStudioCanvasToolShape(activeCanvasTool) !== null
  );
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
        ".ss-studio-node-context-menu, .ss-studio-simple-context-menu, .ss-studio-group-tag, .ss-studio-group-tag-input"
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
        ".ss-studio-node-card, .ss-studio-port-pin, .ss-studio-edge-hit, .ss-studio-edge-line, .ss-studio-edge-preview, .ss-studio-shape, .ss-studio-shape-arrow-hit, .ss-studio-node-context-menu, .ss-studio-simple-context-menu, .ss-studio-group-frame, .ss-studio-group-tag, .ss-studio-group-tag-input"
      )
    ) {
      return;
    }
    if (pointerEvent.pointerType === "touch") {
      graphInteraction.startCanvasPan(pointerEvent);
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
        ".ss-studio-node-card, .ss-studio-port-pin, .ss-studio-edge-hit, .ss-studio-edge-line, .ss-studio-edge-preview, .ss-studio-shape, .ss-studio-shape-arrow-hit, .ss-studio-node-context-menu, .ss-studio-simple-context-menu, .ss-studio-group-frame, .ss-studio-group-tag, .ss-studio-group-tag-input"
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
    onCreateTextNodeAtPosition({
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

  const snapGuides = viewport.createDiv({ cls: "ss-studio-snap-guides-layer" });
  graphInteraction.registerSnapGuidesElement(snapGuides);

  const controls = editor.createDiv({ cls: "ss-studio-graph-workspace-controls" });
  const graphRow = controls.createDiv({ cls: "ss-studio-graph-workspace-control-row" });
  createStudioWorkspaceControl(graphRow, {
    label: "Run",
    testId: "studio.workspace.run",
    ariaLabel: "Run Studio graph",
    title: "Run graph",
    className: "is-run",
    disabled: busy,
    onSelect: () => {
      if (busy) {
        return;
      }
      onRunGraph();
    },
  });

  createStudioWorkspaceControl(graphRow, {
    label: "Add",
    testId: "studio.workspace.add-node",
    ariaLabel: "Add node",
    disabled: busy,
    onSelect: () => {
      if (busy) {
        return;
      }
      onOpenAddNodeMenuAtViewportCenter();
    },
  });

  const zoomRow = graphRow.createDiv({ cls: "ss-studio-graph-workspace-control-zoom-row" });
  createStudioWorkspaceControl(zoomRow, {
    label: "−",
    testId: "studio.workspace.zoom-out",
    ariaLabel: "Zoom out",
    onSelect: onZoomOut,
  });

  const zoomLabel = zoomRow.createDiv({ cls: "ss-studio-graph-workspace-control-zoom-label" });
  graphInteraction.registerZoomLabelElement(zoomLabel);

  createStudioWorkspaceControl(zoomRow, {
    label: "+",
    testId: "studio.workspace.zoom-in",
    ariaLabel: "Zoom in",
    onSelect: onZoomIn,
  });

  createStudioWorkspaceControl(graphRow, {
    label: "Reset",
    testId: "studio.workspace.zoom-reset",
    ariaLabel: "Reset zoom",
    onSelect: onZoomReset,
  });

  createStudioWorkspaceControl(graphRow, {
    label: "Fit",
    testId: "studio.workspace.zoom-overview",
    ariaLabel: "Overview graph",
    onSelect: onZoomOverview,
  });

  createStudioWorkspaceControl(graphRow, {
    label: nodeDetailMode === "collapsed" ? "Expand" : "Collapse",
    testId: "studio.workspace.detail-mode",
    ariaLabel: "Toggle node detail mode",
    title:
      nodeDetailMode === "collapsed"
        ? "Switch to expanded node details"
        : "Switch to collapsed node details",
    selected: nodeDetailMode === "collapsed",
    onSelect: onToggleNodeDetailMode,
  });

  // Second row — diagram tools. Each is an armed mode, not an immediate
  // action: the shape tools draw freeform on empty canvas, and the arrow tool
  // connects one shape to another. They act on the diagram layer only; the
  // node graph has no shape and the diagram has no node.
  const toolsRow = controls.createDiv({
    cls: "ss-studio-graph-workspace-control-row is-tools",
  });
  const toolControls: ReadonlyArray<{
    tool: StudioCanvasTool;
    label: string;
    icon: string;
    testId: string;
    title: string;
  }> = [
    {
      tool: "select",
      label: "Select tool",
      icon: "mouse-pointer-2",
      testId: "studio.workspace.tool.select",
      title: "Select (A): the plain cursor for selecting and moving",
    },
    {
      tool: "rectangle",
      label: "Square tool",
      icon: "square",
      testId: "studio.workspace.tool.square",
      title: "Square: drag on the canvas",
    },
    {
      tool: "ellipse",
      label: "Circle tool",
      icon: "circle",
      testId: "studio.workspace.tool.circle",
      title: "Circle: drag on the canvas",
    },
    {
      tool: "diamond",
      label: "Diamond tool",
      icon: "diamond",
      testId: "studio.workspace.tool.diamond",
      title: "Diamond: a decision or branch",
    },
    {
      tool: "pill",
      label: "Pill tool",
      icon: "rectangle-horizontal",
      testId: "studio.workspace.tool.pill",
      title: "Pill: a start or end point",
    },
    {
      tool: "cylinder",
      label: "Cylinder tool",
      icon: "database",
      testId: "studio.workspace.tool.cylinder",
      title: "Cylinder: a store or database",
    },
    {
      tool: "note",
      label: "Note tool",
      icon: "sticky-note",
      testId: "studio.workspace.tool.note",
      title: "Note: an aside beside the diagram",
    },
    {
      tool: "hexagon",
      label: "Hexagon tool",
      icon: "hexagon",
      testId: "studio.workspace.tool.hexagon",
      title: "Hexagon: a step of preparation",
    },
    {
      tool: "arrow",
      label: "Arrow tool",
      icon: "move-right",
      testId: "studio.workspace.tool.arrow",
      title: "Draw an arrow: drag from one shape onto another",
    },
  ];
  for (const control of toolControls) {
    createStudioWorkspaceControl(toolsRow, {
      label: control.label,
      icon: control.icon,
      testId: control.testId,
      ariaLabel: control.label,
      title: control.title,
      // Icon-only: seven shapes plus the arrow only stay one compact row
      // without labels, and each carries its name as tooltip and aria-label.
      size: "icon",
      selected: activeCanvasTool === control.tool,
      disabled: busy,
      onSelect: () => {
        if (busy) {
          return;
        }
        // Selecting the armed tool disarms it, back to the pointer.
        onSelectCanvasTool(activeCanvasTool === control.tool ? "select" : control.tool);
      },
    });
  }

  canvas.addEventListener("click", (event) => {
    graphInteraction.handleCanvasBackgroundClick(event.target as HTMLElement);
  });

  const edgesLayer = createStudioSvgElement(canvas, "svg");
  edgesLayer.setAttribute("class", "ss-studio-edges-layer");
  edgesLayer.setAttribute("viewBox", `0 0 ${STUDIO_GRAPH_CANVAS_WIDTH} ${STUDIO_GRAPH_CANVAS_HEIGHT}`);
  edgesLayer.setAttribute("width", String(STUDIO_GRAPH_CANVAS_WIDTH));
  edgesLayer.setAttribute("height", String(STUDIO_GRAPH_CANVAS_HEIGHT));
  canvas.appendChild(edgesLayer);
  graphInteraction.registerEdgesLayerElement(edgesLayer);

  // Diagram layer sits between the graph's edges and its node cards: shapes
  // never occlude a node, and it owns its gestures outright — the node graph
  // has no concept of a shape and vice versa.
  const { registerLayerHandle, ...shapeLayerOptions } = shapeLayer;
  registerLayerHandle(
    renderStudioShapeLayer({
      canvasEl: canvas,
      diagram: readStudioDiagramFromProject(currentProject),
      busy,
      activeCanvasTool,
      getGraphZoom: () => graphInteraction.getGraphZoom(),
      ...shapeLayerOptions,
    })
  );

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
      onNodeConfigValueChange,
      onNodeResize,
      onOpenImageEditor,
      onEditImageWithAi,
      onCopyNodeImageToClipboard,
      getJsonEditorPreferredMode,
      onJsonEditorPreferredModeChange,
      renderMarkdownPreview,
      onNodeGeometryMutated,
      resolveDynamicSelectOptions,
      isTextNodeEditing,
      consumeTextNodeAutoFocus,
      consumeTextNodeFocusPoint,
      consumeTextNodeEditorSnapshot,
      onRequestTextNodeEdit,
      onStopTextNodeEdit,
      createTextNodeMarkdownEditor,
      registerTextNodeEditorTeardown,
      onRevealPathInFinder,
      pathBrowseOptions,
      resolveNodeBadge,
    });
  }

  graphInteraction.renderGroupLayer();
  graphInteraction.refreshNodeSelectionClasses();
  graphInteraction.applyGraphZoom();
  graphInteraction.refreshSelectionResizeFrame();
  return { viewportEl: viewport, canvasEl: canvas };
}
