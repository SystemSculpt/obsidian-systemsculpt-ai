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
import { renderStudioGraphNodeCard } from "./StudioGraphNodeCardRenderer";

const SVG_NS = "http://www.w3.org/2000/svg";

export type StudioGraphWorkspaceRendererOptions = {
  root: HTMLElement;
  busy: boolean;
  currentProject: StudioProjectV1 | null;
  currentProjectPath: string | null;
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
  onOpenNodeContextMenu: (event: MouseEvent) => void;
  onCreateLabelAtPosition: (position: { x: number; y: number }) => void;
  onRunNode: (nodeId: string) => void;
  onCopyTextGenerationPromptBundle: (nodeId: string) => void;
  onToggleTextGenerationOutputLock: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
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
    graphInteraction,
    getNodeRunState,
    findNodeDefinition,
    resolveAssetPreviewSrc,
    onOpenMediaPreview,
    onOpenNodeContextMenu,
    onCreateLabelAtPosition,
    onRunNode,
    onCopyTextGenerationPromptBundle,
    onToggleTextGenerationOutputLock,
    onRemoveNode,
    onNodeTitleInput,
    onNodeConfigMutated,
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
      onCopyTextGenerationPromptBundle,
      onToggleTextGenerationOutputLock,
      onRemoveNode,
      onNodeTitleInput,
      onNodeConfigMutated,
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
