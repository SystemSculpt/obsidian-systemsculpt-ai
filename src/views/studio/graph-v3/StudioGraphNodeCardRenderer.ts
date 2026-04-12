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

  // ── Chrome layout: single entry point for ALL non-label nodes ──
  // Functional nodes: top-only (Quick Actions hover-reveal, everything else stays)
  // Content-prominent nodes: top + bottom (full overlay, content-only card sizing)
  const isContentOverlay =
    node.kind === "studio.media_ingest" &&
    !!nodeEl.querySelector(".ss-studio-node-media-preview");

  applyChromeLayout(nodeEl, {
    mode: isContentOverlay ? "full" : "top-only",
    keepOnCard: isContentOverlay
      ? ["ss-studio-node-media-preview", "ss-studio-node-resize-handle"]
      : [],
    topPanel: ["ss-studio-node-collapsed-visibility"],
  });
}

/**
 * Chrome layout policy — single source of truth for how chrome is
 * arranged on any node card.
 *
 * - "top-only": Quick Actions in a hover-reveal top panel. Everything
 *   else stays on the card as normal in-flow content. Used by functional
 *   nodes (text_generation, input, cli_command, etc.).
 *
 * - "full": Top panel (Quick Actions) + bottom panel (remaining chrome).
 *   Only keepOnCard elements stay in-flow. Used by content-prominent
 *   nodes (media_ingest) where the primary content IS the card.
 */
interface ChromeLayoutPolicy {
  mode: "top-only" | "full";
  /** CSS classes of elements that remain as direct card children (full mode only) */
  keepOnCard: string[];
  /** CSS classes of elements routed to the top overlay panel */
  topPanel: string[];
}

/**
 * Single entry point for chrome layout on all node types. Moves header
 * buttons into Quick Actions, then arranges chrome into overlay panels
 * based on the policy mode. Sets data attributes so CSS can target
 * layout state generically.
 */
function applyChromeLayout(
  nodeEl: HTMLElement,
  policy: ChromeLayoutPolicy
): void {
  // Move header action buttons into the Quick Actions toolbar
  const headerEl = nodeEl.querySelector(".ss-studio-node-header");
  const buttonsContainer = nodeEl.querySelector(
    ".ss-studio-node-collapsed-visibility-buttons"
  );
  if (headerEl && buttonsContainer) {
    for (const btn of Array.from(headerEl.querySelectorAll("button"))) {
      buttonsContainer.appendChild(btn);
    }
  }

  // Create the top overlay panel and route topPanel elements into it
  const topSet = new Set(policy.topPanel);
  const chromeTop = nodeEl.createDiv({
    cls: "ss-studio-node-chrome-overlay-top",
  });
  for (const child of Array.from(nodeEl.children)) {
    if (child === chromeTop) continue;
    if (
      topSet.size > 0 &&
      Array.from(child.classList).some((c) => topSet.has(c))
    ) {
      chromeTop.appendChild(child);
    }
  }

  // "full" mode: additionally create a bottom panel for remaining chrome
  if (policy.mode === "full") {
    nodeEl.dataset.chromeLayout = "overlay";
    const keepSet = new Set([
      ...policy.keepOnCard,
      "ss-studio-node-chrome-overlay-top",
    ]);
    const chromeBottom = nodeEl.createDiv({
      cls: "ss-studio-node-chrome-overlay",
    });

    for (const child of Array.from(nodeEl.children)) {
      if (child === chromeTop || child === chromeBottom) continue;
      const isKeep =
        keepSet.size > 0 &&
        Array.from(child.classList).some((c) => keepSet.has(c));
      if (!isKeep) {
        chromeBottom.appendChild(child);
      }
    }

    // Collapsed mode fallback: if buttons weren't moved (no Quick Actions
    // container), extract them from the hidden header into the bottom panel.
    if (!buttonsContainer && headerEl) {
      const headerInBottom = chromeBottom.querySelector(
        ".ss-studio-node-header"
      );
      if (headerInBottom) {
        for (const btn of Array.from(
          headerInBottom.querySelectorAll("button")
        )) {
          chromeBottom.appendChild(btn);
        }
      }
    }
  }
}
