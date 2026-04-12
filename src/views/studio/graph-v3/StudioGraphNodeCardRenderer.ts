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
    onEditImageWithAi,
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
    nodeEl.createEl("p", {
      cls: "ss-studio-muted",
      text: "Legacy terminal node. Interactive terminal sessions are no longer available.",
    });
  }

  mountStudioGraphNodeResizeHandle({
    node,
    nodeEl,
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
      onEditImageWithAi,
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

  // Apply overlay chrome layout for media_ingest with a loaded preview.
  // When no preview exists (empty source, failed load), the node renders
  // as a normal card with all chrome visible.
  if (
    node.kind === "studio.media_ingest" &&
    nodeEl.querySelector(".ss-studio-node-media-preview")
  ) {
    // Move Run/Remove into Quick Actions before overlay setup
    const header = nodeEl.querySelector(".ss-studio-node-header");
    const runBtn = header?.querySelector(".ss-studio-node-run");
    const removeBtn = header?.querySelector(".ss-studio-node-remove");
    const actionsContainer = nodeEl.querySelector(
      ".ss-studio-node-collapsed-visibility-buttons"
    );
    if (actionsContainer) {
      if (runBtn) actionsContainer.prepend(runBtn);
      if (removeBtn) actionsContainer.appendChild(removeBtn);
    }

    const { chromeBottom } = applyOverlayChromeLayout(nodeEl, {
      keepOnCard: [
        "ss-studio-node-media-preview",
        "ss-studio-node-resize-handle",
      ],
      topPanel: ["ss-studio-node-collapsed-visibility"],
    });

    // Collapsed mode: no Quick Actions container, so place buttons
    // directly in the bottom overlay (header is hidden by CSS).
    if (!actionsContainer && chromeBottom) {
      if (runBtn) chromeBottom.appendChild(runBtn);
      if (removeBtn) chromeBottom.appendChild(removeBtn);
    }
  }
}

/**
 * Chrome overlay layout policy. Declares which element classes stay as
 * direct card children (in-flow) and which go to the top overlay panel.
 * Everything else defaults to the bottom panel.
 */
interface ChromeOverlayPolicy {
  /** CSS classes of elements that remain as direct card children */
  keepOnCard: string[];
  /** CSS classes of elements routed to the top overlay panel */
  topPanel: string[];
}

/**
 * Splits a node card's children into two absolutely-positioned overlay
 * panels (top + bottom) based on an explicit policy. Sets
 * data-chrome-layout="overlay" so CSS can target overlay nodes
 * generically, not per node kind.
 *
 * The in-flow content (keepOnCard) stays on the card and determines its
 * size. Chrome in the overlays is hidden by default, revealed on hover.
 * Port positions remain stable because overlays use no transforms.
 */
function applyOverlayChromeLayout(
  nodeEl: HTMLElement,
  policy: ChromeOverlayPolicy
): { chromeTop: HTMLElement; chromeBottom: HTMLElement } {
  nodeEl.dataset.chromeLayout = "overlay";

  const chromeTop = nodeEl.createDiv({
    cls: "ss-studio-node-chrome-overlay-top",
  });
  const chromeBottom = nodeEl.createDiv({
    cls: "ss-studio-node-chrome-overlay",
  });

  const keepSet = new Set(policy.keepOnCard);
  const topSet = new Set(policy.topPanel);

  for (const child of Array.from(nodeEl.children)) {
    if (child === chromeTop || child === chromeBottom) continue;

    const isKeep = keepSet.size > 0 && Array.from(child.classList).some((c) => keepSet.has(c));
    if (isKeep) continue;

    const isTop = topSet.size > 0 && Array.from(child.classList).some((c) => topSet.has(c));
    if (isTop) {
      chromeTop.appendChild(child);
    } else {
      chromeBottom.appendChild(child);
    }
  }

  return { chromeTop, chromeBottom };
}
