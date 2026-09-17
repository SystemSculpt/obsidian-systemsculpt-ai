import type { RenderStudioGraphNodeCardOptions } from "./StudioGraphNodeCardTypes";
import type { StudioProjectV1 } from "../../../studio/types";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import { renderStudioGraphNodeCard } from "./StudioGraphNodeCardRenderer";
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
import { resolveStudioGraphNodeWidth, resolveStudioGraphNodeMinHeight, resolveStudioGraphSafeZoom } from "../../../studio/StudioNodeGeometry";
import type { StudioNodeActivity } from "../activity/StudioActivity";

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

export type StudioGraphWorkspaceRendererOptions = Omit<RenderStudioGraphNodeCardOptions,
  "projectId" | "projectPath" | "projectNodes" | "getRelatedNodeRunState" | "layer" | "node" | "inboundEdges" | "nodeRunState" | "nodeActivity"
> & {
  root: HTMLElement;
  currentProject: StudioProjectV1 | null;
  currentProjectPath: string | null;
  getNodeRunState: (nodeId: string) => StudioNodeRunDisplayState;
  /** First-paint activity per node (views/studio/activity); the applier patches later changes. */
  getNodeActivity?: (nodeId: string) => StudioNodeActivity | undefined;
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
  onArrangeGraph?: () => void;
  automaticLayout?: boolean;
  onToggleAutomaticLayout?: () => void;
  onToggleLayoutPins?: () => void;
  onToggleNodeDetailMode: () => void;
  onOpenNodeContextMenu: (event: MouseEvent) => void;
  onCreateTextNodeAtPosition: (position: { x: number; y: number }) => void;
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
    getNodeActivity,
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
    (event) => graphInteraction.handleGraphViewportWheel(event),
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
    const pointerEvent = event;
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
    const dblEvent = event;
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
    const point = graphInteraction.graphPointFromClient(dblEvent.clientX, dblEvent.clientY);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return;
    }
    onCreateTextNodeAtPosition({ x: point.x, y: point.y });
  });

  const surface = viewport.createDiv({ cls: "ss-studio-graph-surface" });
  graphInteraction.registerSurfaceElement(surface);

  // The canvas is the scroll box; the world inside it is where every layer
  // lives in world px, translated by the elastic origin (see
  // StudioGraphWorldExtent). The interaction engine sizes both.
  const canvas = surface.createDiv({ cls: "ss-studio-graph-canvas" });
  const world = canvas.createDiv({ cls: "ss-studio-graph-world" });
  graphInteraction.registerCanvasElement(canvas, world);

  const marquee = viewport.createDiv({ cls: "ss-studio-marquee-select" });
  graphInteraction.registerMarqueeElement(marquee);

  const snapGuides = viewport.createDiv({ cls: "ss-studio-snap-guides-layer" });
  graphInteraction.registerSnapGuidesElement(snapGuides);

  const controls = editor.createDiv({ cls: "ss-studio-graph-workspace-controls" });
  const graphRow = controls.createDiv({ cls: "ss-studio-graph-workspace-control-row" });
  const commandCenter = currentProject.graph.nodes.find(node => node.kind === 'studio.command_center');
  if (commandCenter) createStudioWorkspaceControl(graphRow, {
    label: 'Home', testId: 'studio.workspace.command-center', ariaLabel: 'Go to Command Center', icon: 'house',
    onSelect: () => { graphInteraction.setSelectedNodeIds([commandCenter.id]); graphInteraction.fitSelectedNodesInViewport(); },
  });
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

  if (options.onArrangeGraph) createStudioWorkspaceControl(graphRow, {
    label: "Arrange", testId: "studio.workspace.arrange", ariaLabel: "Arrange graph from connections and groups",
    onSelect: options.onArrangeGraph,
  });
  if (options.onToggleAutomaticLayout) {
    const auto = createStudioWorkspaceControl(graphRow, {
      label: options.automaticLayout ? "Auto on" : "Auto off", testId: "studio.workspace.auto-layout",
      ariaLabel: "Toggle automatic layout", onSelect: options.onToggleAutomaticLayout,
    });
    auto.setAttribute("aria-pressed", String(Boolean(options.automaticLayout)));
  }
  if (options.onToggleLayoutPins) createStudioWorkspaceControl(graphRow, {
    label: "Pin", testId: "studio.workspace.pin-layout", ariaLabel: "Pin or unpin selected nodes and their groups",
    title: "Pin or unpin selection. Dragging in automatic mode pins the moved group.", onSelect: options.onToggleLayoutPins,
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
  // visually connects nodes and shapes without creating workflow connections.
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
      title: "Select (Shift+C or S): select and move nodes and shapes",
    },
    {
      tool: "rectangle",
      label: "Box tool",
      icon: "square",
      testId: "studio.workspace.tool.square",
      title: "Box (B): drag on the canvas",
    },
    {
      tool: "ellipse",
      label: "Circle tool",
      icon: "circle",
      testId: "studio.workspace.tool.circle",
      title: "Circle (C): drag on the canvas",
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
      title: "Arrow (A): drag between nodes or shapes to draw a visual connection",
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

  const edgesLayer = createStudioSvgElement(world, "svg");
  edgesLayer.setAttribute("class", "ss-studio-edges-layer");
  world.appendChild(edgesLayer);
  graphInteraction.registerEdgesLayerElement(edgesLayer);

  // Diagram arrows use visual card bounds while remaining separate from ports.
  const { registerLayerHandle, ...shapeLayerOptions } = shapeLayer;
  const nodesById = new Map(currentProject.graph.nodes.map((node) => [node.id, node]));
  const shapeHandle = renderStudioShapeLayer({
      canvasEl: world,
      diagram: readStudioDiagramFromProject(currentProject),
      busy,
      activeCanvasTool,
      getGraphZoom: () => graphInteraction.getGraphZoom(),
      getNodeAnchor: (nodeId) => {
        const node = nodesById.get(nodeId);
        if (!node) return null;
        const element = graphInteraction.getNodeElement(nodeId);
        const rect = element?.getBoundingClientRect();
        const origin = world.getBoundingClientRect();
        const zoom = resolveStudioGraphSafeZoom(graphInteraction.getGraphZoom());
        return {
          id: nodeId,
          shape: "rectangle",
          position: {
            x: rect?.width ? (rect.left - origin.left) / zoom : node.position.x,
            y: rect?.height ? (rect.top - origin.top) / zoom : node.position.y,
          },
          size: {
            width: element?.offsetWidth || resolveStudioGraphNodeWidth(node),
            height: element?.offsetHeight || resolveStudioGraphNodeMinHeight(node),
          },
        };
      },
      ...shapeLayerOptions,
    });
  registerLayerHandle(shapeHandle);

  const nodeLayer = world.createDiv({ cls: "ss-studio-nodes-layer" });
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
    renderStudioGraphNodeCard( {
      ...options,
      projectId: currentProject.projectId,
      projectPath: currentProjectPath,
      projectNodes: currentProject.graph.nodes,
      getRelatedNodeRunState: getNodeRunState,
      layer: nodeLayer,
      node,
      inboundEdges: inboundEdgesByNode.get(node.id) || [],
      nodeRunState: getNodeRunState(node.id),
      nodeActivity: getNodeActivity?.(node.id),
    });
  }

  graphInteraction.renderGroupLayer();
  graphInteraction.refreshNodeSelectionClasses();
  graphInteraction.applyGraphZoom();
  graphInteraction.refreshSelectionResizeFrame();
  shapeHandle.refreshArrows();
  return { viewportEl: viewport, canvasEl: world };
}
