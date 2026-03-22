import { isManagedOutputPlaceholderNode } from "../../../studio/StudioManagedOutputNodes";
import { formatNodeConfigPreview } from "../StudioViewHelpers";
import { renderLabelNodeCard } from "./StudioGraphLabelNodeCard";
import {
  bindNodeCardPointerDown,
  renderCollapsedVisibilityControls,
  renderNodeHeader,
  renderNodePorts,
  renderNodeStatusRow,
} from "./StudioGraphNodeCardSections";
import {
  renderNodeMediaPreview,
  renderNodeOutputPreview,
  resolveMediaIngestRevealPath,
} from "./StudioGraphNodeCardPreviews";
import type { RenderStudioGraphNodeCardOptions } from "./StudioGraphNodeCardTypes";
import { renderStudioNodeInlineEditor } from "./StudioGraphNodeInlineEditors";
import { resolveStudioNodeDetailSectionVisibility } from "./StudioGraphNodeDetailMode";
import {
  isStudioExpandedTextNodeKind,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
} from "./StudioGraphNodeGeometry";
import { mountStudioGraphNodeResizeHandle } from "./StudioGraphNodeResizeHandle";

export function renderStudioGraphNodeCard(options: RenderStudioGraphNodeCardOptions): void {
  const {
    layer,
    busy,
    node,
    nodeDetailMode,
    nodeRunState,
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
    onNodeSizeChange,
    onOpenImageEditor,
    onCopyNodeImageToClipboard,
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
    mountTerminalNode,
  } = options;

  const definition = findNodeDefinition(node);
  const isPlaceholder = isManagedOutputPlaceholderNode(node);
  const interactionLocked = busy || isPlaceholder;
  const nodeEl = layer.createDiv({ cls: "ss-studio-node-card" });
  nodeEl.dataset.nodeId = node.id;
  nodeEl.dataset.nodeKind = node.kind;
  nodeEl.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
  nodeEl.style.width = `${resolveStudioGraphNodeWidth(node)}px`;
  const resolvedMinHeight = resolveStudioGraphNodeMinHeight(node);
  if (resolvedMinHeight > 0) {
    nodeEl.style.minHeight = `${resolvedMinHeight}px`;
  }
  nodeEl.classList.toggle("is-expanded-text-node", isStudioExpandedTextNodeKind(node.kind));
  nodeEl.classList.toggle("is-detail-collapsed", nodeDetailMode === "collapsed");
  nodeEl.classList.toggle("is-selected", graphInteraction.isNodeSelected(node.id));
  nodeEl.classList.toggle("is-managed-pending", isPlaceholder);
  graphInteraction.registerNodeElement(node.id, nodeEl);

  bindNodeCardPointerDown({
    nodeEl,
    nodeId: node.id,
    graphInteraction,
  });

  if (node.kind === "studio.label") {
    renderLabelNodeCard({
      nodeEl,
      node,
      busy,
      graphInteraction,
      onRemoveNode,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      onNodeSizeChange,
      onNodeGeometryMutated,
      isEditing: isLabelEditing(node.id),
      shouldAutoFocus: consumeLabelAutoFocus(node.id),
      onRequestLabelEdit,
      onStopLabelEdit,
    });
    return;
  }

  renderNodeHeader({
    nodeEl,
    node,
    interactionLocked,
    onNodeTitleInput,
    onRunNode,
    onCopyTextGenerationPromptBundle,
    onToggleTextGenerationOutputLock,
    onRemoveNode,
  });

  if (node.kind === "studio.media_ingest") {
    nodeEl.addEventListener("dblclick", (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }
      if (target.closest("input, button, select, textarea, a, .ss-studio-port-pin")) {
        return;
      }
      const revealPath = resolveMediaIngestRevealPath(
        node,
        nodeRunState.outputs as Record<string, unknown> | null,
        ""
      );
      if (!revealPath) {
        return;
      }
      event.stopPropagation();
      onRevealPathInFinder(revealPath);
    });
  }

  nodeEl.createEl("div", {
    cls: "ss-studio-node-kind",
    text: `${node.kind}@${node.version}`,
  });

  renderNodeStatusRow({
    nodeEl,
    node,
    isPlaceholder,
    nodeRunState,
    resolveNodeBadge,
  });

  renderNodePorts({
    nodeEl,
    node,
    definition,
    graphInteraction,
    interactionLocked,
  });

  if (!definition) {
    nodeEl.createEl("p", {
      cls: "ss-studio-inline-error",
      text: `Missing definition for ${node.kind}@${node.version}.`,
    });
    return;
  }

  if (node.kind === "studio.text" && isPlaceholder) {
    const pendingPreviewEl = nodeEl.createDiv({ cls: "ss-studio-node-pending-preview is-text" });
    pendingPreviewEl.createDiv({
      cls: "ss-studio-node-pending-title",
      text: "Generating text...",
    });
    pendingPreviewEl.createDiv({ cls: "ss-studio-node-pending-line" });
    pendingPreviewEl.createDiv({ cls: "ss-studio-node-pending-line" });
    pendingPreviewEl.createDiv({ cls: "ss-studio-node-pending-line is-short" });
  }

  const showTextEditor = resolveStudioNodeDetailSectionVisibility({
    node,
    mode: nodeDetailMode,
    section: "textEditor",
  });
  const showSystemPromptField = resolveStudioNodeDetailSectionVisibility({
    node,
    mode: nodeDetailMode,
    section: "systemPrompt",
  });
  const showOutputPreview = resolveStudioNodeDetailSectionVisibility({
    node,
    mode: nodeDetailMode,
    section: "outputPreview",
  });
  const showFieldHelp = resolveStudioNodeDetailSectionVisibility({
    node,
    mode: nodeDetailMode,
    section: "fieldHelp",
  });
  const renderedInlineEditor =
    !isPlaceholder &&
    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState,
      definition,
      inboundEdges: options.inboundEdges,
      interactionLocked,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      getJsonEditorPreferredMode,
      onJsonEditorPreferredModeChange,
      renderMarkdownPreview,
      resolveDynamicSelectOptions,
      nodeDetailMode,
      showTextEditor,
      showSystemPromptField,
      showOutputPreview,
      showFieldHelp,
    });

  if (!isPlaceholder && !renderedInlineEditor) {
    const configPreviewEl = nodeEl.createEl("p", {
      cls: "ss-studio-node-config-preview",
      text: formatNodeConfigPreview(node),
    });
    configPreviewEl.setAttribute("data-node-config-preview", node.id);
  }

  if (node.kind === "studio.terminal") {
    const terminalAnchorEl = nodeEl.createDiv({ cls: "ss-studio-terminal-anchor" });
    if (mountTerminalNode) {
      mountTerminalNode({
        node,
        nodeEl,
        terminalAnchorEl,
        interactionLocked,
        graphInteraction,
      });
    }
  }

  mountStudioGraphNodeResizeHandle({
    node,
    nodeEl,
    handleClassName: node.kind === "studio.terminal" ? "ss-studio-terminal-resize-handle" : undefined,
    title: node.kind === "studio.terminal" ? "Resize terminal node" : "Resize node",
    ariaLabel: node.kind === "studio.terminal" ? "Resize terminal node" : "Resize node",
    interactionLocked,
    getGraphZoom: () => graphInteraction.getGraphZoom(),
    onNodeConfigMutated,
    onNodeSizeChange,
    onNodeGeometryMutated,
    applySize: ({ width, height }) => {
      nodeEl.style.width = `${width}px`;
      if (node.kind === "studio.terminal") {
        nodeEl.style.height = `${height}px`;
        return;
      }
      nodeEl.style.minHeight = `${height}px`;
    },
    readInitialSize: () => {
      const measuredHeight = nodeEl.offsetHeight;
      const resolvedMinHeight = resolveStudioGraphNodeMinHeight(node);
      return {
        width: resolveStudioGraphNodeWidth(node),
        height:
          measuredHeight > 0
            ? measuredHeight
            : Math.max(resolvedMinHeight, 1),
      };
    },
  });

  if (!isPlaceholder) {
    renderCollapsedVisibilityControls({
      nodeEl,
      node,
      busy,
      nodeDetailMode,
      nodeRunState,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      onOpenImageEditor,
      onCopyNodeImageToClipboard,
    });
  }

  renderNodeOutputPreview({
    nodeEl,
    node,
    nodeRunState,
    showOutputPreview,
  });

  if (node.kind === "studio.media_ingest" && isPlaceholder) {
    const pendingPreviewEl = nodeEl.createDiv({ cls: "ss-studio-node-pending-preview is-media" });
    pendingPreviewEl.createDiv({
      cls: "ss-studio-node-pending-title",
      text: "Generating image...",
    });
    pendingPreviewEl.createDiv({ cls: "ss-studio-node-pending-frame" });
    return;
  }

  renderNodeMediaPreview({
    nodeEl,
    node,
    nodeRunState,
    resolveAssetPreviewSrc,
    onRevealPathInFinder,
    onOpenMediaPreview,
  });
}
