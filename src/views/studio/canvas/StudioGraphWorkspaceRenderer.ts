import { StudioEditorRevision } from "../../../studio/document/StudioEditorRevision";
import { materializeStudioProject } from "../../../studio/document/StudioProjectCollaboration";
import { cloneStudioProjectSnapshot } from "../../../studio/StudioProjectSnapshots";
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
  onToggleNodeDetailMode: () => void;
  onOpenNodeContextMenu: (event: MouseEvent) => void;
  onCreateTextNodeAtPosition: (position: { x: number; y: number }) => void;
  /** Active gestures and native editors keep ownership of their mounted card. */
  shouldPreserveNodeElement?: (nodeId: string) => boolean;
};

export type StudioGraphWorkspaceRenderResult = {
  viewportEl: HTMLElement | null;
  /** Zoomed graph-coordinate layer; canvas gestures measure against it. */
  canvasEl: HTMLElement | null;
  /** Applies a new snapshot without replacing the workspace or unaffected cards. */
  refresh: (options: StudioGraphWorkspaceRendererOptions) => boolean;
  dispose: () => void;
};

function studioNodeContentSignature(
  node: StudioProjectV1["graph"]["nodes"][number],
  options: StudioGraphWorkspaceRendererOptions,
): string {
  const { position: _position, size: _size, ...content } = node;
  const inboundEdges = options.currentProject?.graph.edges.filter(edge => edge.toNodeId === node.id) ?? [];
  return JSON.stringify({
    content,
    inboundEdges,
    outputs: options.getNodeRunState(node.id).outputs,
    busy: options.busy,
    nodeDetailMode: options.nodeDetailMode,
  });
}

function studioNodeStructureSignature(
  node: StudioProjectV1["graph"]["nodes"][number],
  options: StudioGraphWorkspaceRendererOptions,
): string {
  return studioNodeContentSignature({ ...node, title: "" }, options);
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

  const alignmentGuides = viewport.createDiv({ cls: "ss-studio-alignment-guides-layer" });
  graphInteraction.registerAlignmentGuidesElement(alignmentGuides);

  const controls = editor.createDiv({ cls: "ss-studio-graph-workspace-controls" });
  let currentBusy = busy;
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
    disabled: busy,
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
    disabled: busy,
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
      disabled: busy,
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
  const cardHandles = new Map<string, StudioGraphNodeCardHandle>();
  const nodeSignatures = new Map<string, string>();
  const nodeStructureSignatures = new Map<string, string>();
  const editorBases = new WeakMap<object, StudioProjectV1>();
  const mountCard = (node: StudioProjectV1["graph"]["nodes"][number], renderOptions: StudioGraphWorkspaceRendererOptions): StudioGraphNodeCardHandle => {
    const inboundEdges = renderOptions.currentProject!.graph.edges
      .filter(edge => edge.toNodeId === node.id)
      .map(edge => ({ fromNodeId: edge.fromNodeId, fromPortId: edge.fromPortId, toPortId: edge.toPortId }));
    let editor: StudioEditorRevision | undefined;
    if (renderOptions.currentProject?.document) {
      let basis = editorBases.get(renderOptions);
      if (!basis) {
        basis = cloneStudioProjectSnapshot(materializeStudioProject(renderOptions.currentProject));
        renderOptions.currentProject.document = basis.document ? {...basis.document, heads: [...basis.document.heads]} : undefined;
        editorBases.set(renderOptions, basis);
      }
      editor = new StudioEditorRevision(basis);
    }
    const handle = renderStudioGraphNodeCard( {
      ...renderOptions,
      onNodeConfigValueChange: (nodeId, key, value, changeOptions) => {
        const project = renderOptions.currentProject!;
        if (!editor || typeof value !== "string" || !renderOptions.onNodeConfigValueChange) {
          renderOptions.onNodeConfigValueChange?.(nodeId, key, value, changeOptions); return;
        }
        const merged = editor.edit(nodeId, {config: key}, value, project);
        const next = merged.graph.nodes.find(node => node.id === nodeId);
        if (!next) return;
        renderOptions.onNodeConfigValueChange(nodeId, key, next.config[key], changeOptions);
        project.document = merged.document;
      },
      onNodeTitleInput: (node, value) => {
        const project = renderOptions.currentProject!;
        if (!editor) { renderOptions.onNodeTitleInput(node, value); return; }
        const merged = editor.edit(node.id, {title: true}, value, project);
        const next = merged.graph.nodes.find(item => item.id === node.id);
        if (!next) return;
        renderOptions.onNodeTitleInput(node, next.title);
        project.document = merged.document;
      },
      projectId: renderOptions.currentProject!.projectId,
      projectPath: renderOptions.currentProjectPath!,
      projectNodes: renderOptions.currentProject!.graph.nodes,
      getRelatedNodeRunState: renderOptions.getNodeRunState,
      layer: nodeLayer,
      node,
      inboundEdges,
      nodeRunState: renderOptions.getNodeRunState(node.id),
      nodeActivity: renderOptions.getNodeActivity?.(node.id),
    });
    cardHandles.set(node.id, handle);
    nodeSignatures.set(node.id, studioNodeContentSignature(node, renderOptions));
    nodeStructureSignatures.set(node.id, studioNodeStructureSignature(node, renderOptions));
    return handle;
  };
  for (const node of currentProject.graph.nodes) {
    mountCard(node, options);
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
    void Promise.resolve().then(() => { if (!disposed) refresh(latestOptions); });
  });

  const refresh = (next: StudioGraphWorkspaceRendererOptions): boolean => {
    const project = next.currentProject;
    if (disposed || !project || next.currentProjectPath !== currentProjectPath || project.projectId !== currentProject.projectId) return false;
    latestOptions = next;
    const nextIds = new Set(project.graph.nodes.map(node => node.id));
    let registrationsChanged = false;
    let geometryChanged = false;
    for (const [nodeId, handle] of cardHandles) {
      if (nextIds.has(nodeId)) continue;
      handle.dispose();
      handle.element.remove();
      cardHandles.delete(nodeId);
      nodeSignatures.delete(nodeId);
      nodeStructureSignatures.delete(nodeId);
      graphInteraction.onNodeRemoved(nodeId);
      registrationsChanged = true;
    }
    for (const node of project.graph.nodes) {
      const existing = cardHandles.get(node.id);
      if (!existing) {
        mountCard(node, next);
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
      const signature = studioNodeContentSignature(node, next);
      if (nodeSignatures.get(node.id) === signature) continue;
      const active = existing.element.ownerDocument.activeElement;
      const titleInput = existing.element.querySelector<HTMLInputElement>(".ss-studio-node-title-input");
      if (titleInput && active !== titleInput) titleInput.value = node.title;
      const structureSignature = studioNodeStructureSignature(node, next);
      if (nodeStructureSignatures.get(node.id) === structureSignature) {
        nodeSignatures.set(node.id, signature);
        continue;
      }
      if ((active && existing.element.contains(active)) || preserveForGesture) continue;
      const replacement = mountCard(node, next);
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
    currentBusy = next.busy;
    currentActiveCanvasTool = next.activeCanvasTool;
    viewport.classList.toggle("is-arrow-tool", next.activeCanvasTool === "arrow");
    viewport.classList.toggle("is-shape-tool", resolveStudioCanvasToolShape(next.activeCanvasTool) !== null);
    const runButton = editor.querySelector<HTMLButtonElement>('[aria-label="Run Studio graph"]');
    const addButton = editor.querySelector<HTMLButtonElement>('[aria-label="Add node"]');
    if (runButton) runButton.disabled = next.busy;
    if (addButton) addButton.disabled = next.busy;
    const detailButton = editor.querySelector<HTMLButtonElement>('[aria-label="Toggle node detail mode"]');
    if (detailButton) {
      detailButton.setText(next.nodeDetailMode === "collapsed" ? "Expand" : "Collapse");
      detailButton.setAttribute("aria-pressed", String(next.nodeDetailMode === "collapsed"));
    }
    for (const button of editor.querySelectorAll<HTMLButtonElement>(".ss-studio-graph-workspace-control-row.is-tools button")) {
      button.disabled = next.busy;
      const selected = button.dataset.testid === `studio.workspace.tool.${next.activeCanvasTool === "rectangle" ? "square" : next.activeCanvasTool}`;
      button.setAttribute("aria-pressed", String(selected));
    }
    return true;
  };

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
      nodeSignatures.clear();
      nodeStructureSignatures.clear();
    },
  };
}
