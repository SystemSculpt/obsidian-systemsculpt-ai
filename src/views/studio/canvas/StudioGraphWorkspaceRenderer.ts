import { StudioEditorRevision } from "../../../studio/document/StudioEditorRevision";
import type { RenderStudioGraphNodeCardOptions } from "./StudioGraphNodeCardTypes";
import type { StudioProjectV1 } from "../../../studio/types";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import { renderStudioGraphNodeCard, type StudioGraphNodeCardHandle } from "./StudioGraphNodeCardRenderer";
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
import { resolveNodeMediaPreview } from "./StudioGraphMediaPreview";

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
  readOnly?: boolean;
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
  onToggleNodeDetailMode: () => void;
  onOpenNodeContextMenu: (event: MouseEvent) => void;
  onCreateTextNodeAtPosition: (position: { x: number; y: number }) => void;
  /** Active gestures and native editors keep ownership of their mounted card. */
  shouldPreserveNodeElement?: (nodeId: string) => boolean;
  /** Text cards mount their editor; entering or leaving edit mode is a card transition. */
  isTextNodeEditing?: (nodeId: string) => boolean;
  /** Image cards mount their editor in place; the card stays mounted for the whole edit. */
  isImageNodeEditing?: (nodeId: string) => boolean;
};

export type StudioGraphWorkspaceRenderResult = {
  viewportEl: HTMLElement | null;
  /** Zoomed graph-coordinate layer; canvas gestures measure against it. */
  canvasEl: HTMLElement | null;
  /** Applies a new snapshot without replacing the workspace or unaffected cards. */
  refresh: (options: StudioGraphWorkspaceRendererOptions) => boolean;
  dispose: () => void;
};

type StudioInboundEdge = { fromNodeId: string; fromPortId: string; toPortId: string };

/** Every node's inbound connections, in edge order, from one pass over the edges. */
function studioInboundEdgesByNode(project: StudioProjectV1): Map<string, StudioInboundEdge[]> {
  const byNode = new Map<string, StudioInboundEdge[]>();
  for (const edge of project.graph.edges) {
    let inbound = byNode.get(edge.toNodeId);
    if (!inbound) byNode.set(edge.toNodeId, inbound = []);
    inbound.push({ fromNodeId: edge.fromNodeId, fromPortId: edge.fromPortId, toPortId: edge.toPortId });
  }
  return byNode;
}

/**
 * What a card shows, except its geometry and the run lock: a run starting or
 * ending patches the lock in place (see StudioCardLock).
 */
function studioNodeContentSignature(
  node: StudioProjectV1["graph"]["nodes"][number],
  options: StudioGraphWorkspaceRendererOptions,
  inboundEdges: readonly StudioInboundEdge[],
): string {
  const { position: _position, size: _size, ...content } = node;
  const outputs = options.getNodeRunState(node.id).outputs;
  // A preview resolves after its bytes are confirmed; the card it turns into is different content.
  const media = resolveNodeMediaPreview(node, outputs);
  return JSON.stringify({
    content,
    inboundEdges,
    outputs,
    mediaSrc: media ? options.resolveAssetPreviewSrc?.(media.path) ?? null : null,
    // The selected model decides which inputs a media card offers; its catalog can load later.
    mediaInputPlan: options.resolveMediaNodeInputPlan?.(node) ?? null,
    nodeDetailMode: options.nodeDetailMode,
    editing: studioNodeIsEditing(node.id, options),
  });
}

function studioNodeIsEditing(nodeId: string, options: StudioGraphWorkspaceRendererOptions): boolean {
  return options.isTextNodeEditing?.(nodeId) === true || options.isImageNodeEditing?.(nodeId) === true;
}

function studioNodeStructureSignature(
  node: StudioProjectV1["graph"]["nodes"][number],
  options: StudioGraphWorkspaceRendererOptions,
  inboundEdges: readonly StudioInboundEdge[],
): string {
  return studioNodeContentSignature({ ...node, title: "" }, options, inboundEdges);
}

function studioCollectionSignature(value: unknown): string {
  return JSON.stringify(value);
}

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
    return { viewportEl: null, canvasEl: null, refresh: () => false, dispose: () => undefined };
  }

  const readOnly = options.readOnly === true;
  const viewport = editor.createDiv({ cls: "ss-studio-graph-viewport" });
  if (readOnly) {
    // Keep scrolling, zoom and readable content, but never dispatch editing/run handlers.
    for (const type of ["pointerdown", "click", "dblclick", "contextmenu", "keydown", "paste", "drop", "beforeinput"]) {
      viewport.addEventListener(type, event => {
        if (type === "pointerdown" && (event as PointerEvent).pointerType === "touch"
          && !(event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable='true']")) {
          graphInteraction.startCanvasPan(event as PointerEvent);
        }
        event.stopImmediatePropagation();
        if (type !== "pointerdown" && type !== "keydown") event.preventDefault();
      }, true);
    }
  }
  const applyReadOnlyControls = (): void => {
    if (!readOnly) return;
    for (const element of viewport.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")) element.readOnly = true;
    for (const element of viewport.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button, select, input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"]')) element.disabled = true;
    for (const element of viewport.querySelectorAll<HTMLElement>("[contenteditable]")) element.contentEditable = "false";
  };
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

  const alignmentGuides = viewport.createDiv({ cls: "ss-studio-alignment-guides-layer" });
  graphInteraction.registerAlignmentGuidesElement(alignmentGuides);

  const controls = editor.createDiv({ cls: "ss-studio-graph-workspace-controls" });
  let currentBusy = busy || readOnly;
  let currentActiveCanvasTool = activeCanvasTool;
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
    disabled: busy || readOnly,
    onSelect: () => {
      if (currentBusy) {
        return;
      }
      onRunGraph();
    },
  });

  createStudioWorkspaceControl(graphRow, {
    label: "Add",
    testId: "studio.workspace.add-node",
    ariaLabel: "Add node",
    disabled: busy || readOnly,
    onSelect: () => {
      if (currentBusy) {
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
      disabled: busy || readOnly,
      onSelect: () => {
        if (currentBusy) {
          return;
        }
        // Selecting the armed tool disarms it, back to the pointer.
        onSelectCanvasTool(currentActiveCanvasTool === control.tool ? "select" : control.tool);
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
  const cardHandles = new Map<string, StudioGraphNodeCardHandle>();
  const nodeSignatures = new Map<string, string>();
  const nodeStructureSignatures = new Map<string, string>();
  const nodeEditing = new Map<string, boolean>();
  /** The run lock each card shows. */
  const cardBusy = new Map<string, boolean>();
  const cardEditors = new Map<string, StudioEditorRevision>();
  const mountCard = (
    node: StudioProjectV1["graph"]["nodes"][number],
    renderOptions: StudioGraphWorkspaceRendererOptions,
    inboundEdges: readonly StudioInboundEdge[],
  ): StudioGraphNodeCardHandle => {
    // The card's controls show these values; later keystrokes are relative to them.
    const editor = new StudioEditorRevision();
    editor.display("title", node.title);
    for (const [key, value] of Object.entries(node.config)) editor.display(`config:${key}`, value);
    cardEditors.set(node.id, editor);
    const liveNode = (nodeId: string) => renderOptions.currentProject?.graph.nodes.find(item => item.id === nodeId);
    const handle = renderStudioGraphNodeCard( {
      ...renderOptions,
      onNodeConfigValueChange: (nodeId, key, value, changeOptions) => {
        const current = typeof value === "string" && nodeId === node.id ? liveNode(nodeId) : undefined;
        renderOptions.onNodeConfigValueChange?.(nodeId, key, current ? editor.commit(`config:${key}`, value as string, current.config[key]) : value, changeOptions);
      },
      onNodeTitleInput: (target, value) => {
        const current = target.id === node.id ? liveNode(target.id) : undefined;
        renderOptions.onNodeTitleInput(target, current ? editor.commit("title", value, current.title) : value);
      },
      projectId: renderOptions.currentProject!.projectId,
      projectPath: renderOptions.currentProjectPath!,
      projectNodes: renderOptions.currentProject!.graph.nodes,
      getRelatedNodeRunState: renderOptions.getNodeRunState,
      layer: nodeLayer,
      node,
      inboundEdges: [...inboundEdges],
      nodeRunState: renderOptions.getNodeRunState(node.id),
      nodeActivity: renderOptions.getNodeActivity?.(node.id),
    });
    cardHandles.set(node.id, handle);
    nodeEditing.set(node.id, studioNodeIsEditing(node.id, renderOptions));
    cardBusy.set(node.id, renderOptions.busy);
    nodeSignatures.set(node.id, studioNodeContentSignature(node, renderOptions, inboundEdges));
    nodeStructureSignatures.set(node.id, studioNodeStructureSignature(node, renderOptions, inboundEdges));
    return handle;
  };
  const initialInbound = studioInboundEdgesByNode(currentProject);
  for (const node of currentProject.graph.nodes) {
    mountCard(node, options, initialInbound.get(node.id) ?? []);
  }

  graphInteraction.renderGroupLayer();
  graphInteraction.refreshNodeSelectionClasses();
  graphInteraction.applyGraphZoom();
  graphInteraction.refreshSelectionResizeFrame();
  shapeHandle.refreshArrows();
  let edgesSignature = studioCollectionSignature(currentProject.graph.edges);
  let groupsSignature = studioCollectionSignature(currentProject.graph.groups);
  let disposed = false;
  let latestOptions = options;

  const rebuildElementRegistrations = (): void => {
    graphInteraction.clearGraphElementMaps();
    for (const [nodeId, handle] of cardHandles) graphInteraction.registerNodeElement(nodeId, handle.element);
    nodeLayer.querySelectorAll<HTMLElement>(".ss-studio-port-pin[data-node-id][data-port-id][data-port-direction]").forEach(pin => {
      const direction = pin.dataset.portDirection;
      if (direction !== "in" && direction !== "out") return;
      graphInteraction.registerPortElement(pin.dataset.nodeId || "", direction, pin.dataset.portId || "", pin);
    });
  };

  nodeLayer.addEventListener("focusout", () => {
    void Promise.resolve().then(() => {
      if (!disposed && latestOptions.presentation?.isVisible() !== false) refresh(latestOptions);
    });
  });

  const refresh = (next: StudioGraphWorkspaceRendererOptions): boolean => {
    const project = next.currentProject;
    if (disposed || !project || next.currentProjectPath !== currentProjectPath || project.projectId !== currentProject.projectId || (next.readOnly === true) !== readOnly) return false;
    latestOptions = next;
    const nextIds = new Set(project.graph.nodes.map(node => node.id));
    let registrationsChanged = false;
    let geometryChanged = false;
    for (const [nodeId, handle] of cardHandles) {
      if (nextIds.has(nodeId)) continue;
      handle.dispose();
      handle.element.remove();
      cardHandles.delete(nodeId);
      cardEditors.delete(nodeId);
      nodeSignatures.delete(nodeId);
      nodeStructureSignatures.delete(nodeId);
      nodeEditing.delete(nodeId);
      cardBusy.delete(nodeId);
      graphInteraction.onNodeRemoved(nodeId);
      registrationsChanged = true;
    }
    const inboundByNode = studioInboundEdgesByNode(project);
    for (const node of project.graph.nodes) {
      const inboundEdges = inboundByNode.get(node.id) ?? [];
      const existing = cardHandles.get(node.id);
      if (!existing) {
        mountCard(node, next, inboundEdges);
        registrationsChanged = true;
        continue;
      }
      const preserveForGesture = next.shouldPreserveNodeElement?.(node.id) === true;
      const nextTransform = `translate(${node.position.x}px, ${node.position.y}px)`;
      const nextWidth = `${resolveStudioGraphNodeWidth(node)}px`;
      if (!preserveForGesture) {
        geometryChanged = geometryChanged || existing.element.style.transform !== nextTransform || existing.element.style.width !== nextWidth;
        existing.updateGeometry(node);
      }
      const signature = studioNodeContentSignature(node, next, inboundEdges);
      // Entering or leaving an edit swaps preview for editor: remount even while focused or dragging.
      const editing = studioNodeIsEditing(node.id, next);
      const editingChanged = nodeEditing.get(node.id) !== editing;
      const active = existing.element.ownerDocument.activeElement;
      const focused = Boolean(active && existing.element.contains(active));
      // A run started or ended: lock the card in place. A focused card waits
      // until focus leaves, so typing isn't cut off. An open text editor picks
      // its kind by the lock as it mounts, and a card without setBusy shows
      // other nodes' run status, so those remount as before.
      let busyPending = cardBusy.get(node.id) !== next.busy;
      if (busyPending && existing.setBusy && !focused && (!editing || existing.syncNode)) {
        existing.setBusy(next.busy);
        cardBusy.set(node.id, next.busy);
        busyPending = false;
      }
      if (!busyPending && nodeSignatures.get(node.id) === signature) continue;
      if (!editingChanged && existing.syncNode) {
        // An in-place editor owns its card: hand it the change (e.g. an undo) instead of remounting.
        existing.syncNode(node);
        nodeSignatures.set(node.id, signature);
        nodeStructureSignatures.set(node.id, studioNodeStructureSignature(node, next, inboundEdges));
        continue;
      }
      const titleInput = existing.element.querySelector<HTMLInputElement>(".ss-studio-node-title-input");
      if (titleInput && active !== titleInput) { titleInput.value = node.title; cardEditors.get(node.id)?.display("title", node.title); }
      const structureSignature = studioNodeStructureSignature(node, next, inboundEdges);
      if (!editingChanged && !busyPending && nodeStructureSignatures.get(node.id) === structureSignature) {
        nodeSignatures.set(node.id, signature);
        continue;
      }
      if (!editingChanged && (focused || preserveForGesture)) continue;
      const replacement = mountCard(node, next, inboundEdges);
      existing.element.replaceWith(replacement.element);
      existing.dispose();
      registrationsChanged = true;
    }
    if (registrationsChanged) rebuildElementRegistrations();

    const nextEdgesSignature = studioCollectionSignature(project.graph.edges);
    if (registrationsChanged || geometryChanged || nextEdgesSignature !== edgesSignature) {
      edgesSignature = nextEdgesSignature;
      graphInteraction.notifyNodePositionsChanged();
    }
    const nextGroupsSignature = studioCollectionSignature(project.graph.groups);
    if (registrationsChanged || nextGroupsSignature !== groupsSignature) {
      groupsSignature = nextGroupsSignature;
      graphInteraction.renderGroupLayer();
    }
    shapeHandle.update({
      diagram: readStudioDiagramFromProject(project),
      busy: next.busy,
      activeCanvasTool: next.activeCanvasTool,
      selection: next.shapeLayer.selection,
    });
    graphInteraction.refreshNodeSelectionClasses();
    graphInteraction.refreshSelectionResizeFrame();
    currentBusy = next.busy || readOnly;
    currentActiveCanvasTool = next.activeCanvasTool;
    viewport.classList.toggle("is-arrow-tool", next.activeCanvasTool === "arrow");
    viewport.classList.toggle("is-shape-tool", resolveStudioCanvasToolShape(next.activeCanvasTool) !== null);
    const runButton = editor.querySelector<HTMLButtonElement>('[aria-label="Run Studio graph"]');
    const addButton = editor.querySelector<HTMLButtonElement>('[aria-label="Add node"]');
    if (runButton) runButton.disabled = next.busy || readOnly;
    if (addButton) addButton.disabled = next.busy || readOnly;
    const detailButton = editor.querySelector<HTMLButtonElement>('[aria-label="Toggle node detail mode"]');
    if (detailButton) {
      detailButton.setText(next.nodeDetailMode === "collapsed" ? "Expand" : "Collapse");
      detailButton.setAttribute("aria-pressed", String(next.nodeDetailMode === "collapsed"));
    }
    for (const button of editor.querySelectorAll<HTMLButtonElement>(".ss-studio-graph-workspace-control-row.is-tools button")) {
      button.disabled = next.busy || readOnly;
      const selected = button.dataset.testid === `studio.workspace.tool.${next.activeCanvasTool === "rectangle" ? "square" : next.activeCanvasTool}`;
      button.setAttribute("aria-pressed", String(selected));
    }
    applyReadOnlyControls();
    return true;
  };

  applyReadOnlyControls();
  return {
    viewportEl: viewport,
    canvasEl: world,
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      shapeHandle.cancelArrowGesture();
      for (const handle of cardHandles.values()) handle.dispose();
      cardHandles.clear();
      cardEditors.clear();
      nodeSignatures.clear();
      nodeStructureSignatures.clear();
      nodeEditing.clear();
      cardBusy.clear();
    },
  };
}
