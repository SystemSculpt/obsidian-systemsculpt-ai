import { isManagedOutputPlaceholderNode } from "../../../studio/StudioManagedOutputNodes";
import { formatNodeConfigPreview } from "../StudioViewHelpers";
import { renderTextNodeCard } from "./StudioGraphTextNodeCard";
import {
  renderCollapsedVisibilityControls,
  renderNodeHeader,
  renderNodePorts,
  renderNodeStatusRow,
} from "./StudioGraphNodeCardSections";
import {
  bindNodeCardPointerDown,
  isStudioNodeCardInteractiveTarget,
} from "./StudioGraphNodeCardPointer";
import {
  renderNodeMediaPreview,
  renderNodeOutputPreview,
  resolveMediaIngestRevealPath,
} from "./StudioGraphNodeCardPreviews";
import type { RenderStudioGraphNodeCardOptions } from "./StudioGraphNodeCardTypes";
import { renderStudioMediaNodeActionBar } from "./StudioMediaNodeActionBar";
import { renderStudioNodeInlineEditor } from "./StudioGraphNodeInlineEditors";
import { resolveStudioNodeDetailSectionVisibility } from "./StudioGraphNodeDetailMode";
import {
  isStudioExpandedTextNodeKind,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
} from "../../../studio/StudioNodeGeometry";
import { resolveNodeMediaPreview } from "./StudioGraphMediaPreview";
import { mountStudioGraphNodeResizeFrame } from "./StudioGraphNodeResizeFrame";

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
    onRequestTextNodeEdit,
    onStopTextNodeEdit,
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

  if (node.kind === "studio.text") {
    renderTextNodeCard({
      nodeEl,
      node,
      busy,
      graphInteraction,
      onRemoveNode,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      onNodeResize,
      onNodeGeometryMutated,
      isEditing: isTextNodeEditing(node.id),
      shouldAutoFocus: consumeTextNodeAutoFocus(node.id),
      onRequestTextNodeEdit,
      onStopTextNodeEdit,
    });
    return;
  }

  if (node.kind === "studio.media_ingest") {
    nodeEl.addEventListener("dblclick", (event) => {
      if (isStudioNodeCardInteractiveTarget(event.target)) {
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

  const mediaPreviewDescriptor = resolveNodeMediaPreview(
    node,
    nodeRunState.outputs as Record<string, unknown> | null
  );
  const mediaPreviewSrc =
    mediaPreviewDescriptor && resolveAssetPreviewSrc
      ? resolveAssetPreviewSrc(mediaPreviewDescriptor.path)
      : null;

  const mountResizeFrame = (): void => {
    mountStudioGraphNodeResizeFrame({
      node,
      nodeEl,
      title: node.kind === "studio.terminal" ? "Resize terminal node" : "Resize node",
      ariaLabel: node.kind === "studio.terminal" ? "Resize terminal node" : "Resize node",
      interactionLocked,
      getGraphZoom: () => graphInteraction.getGraphZoom(),
      hasAspectMediaContent: mediaPreviewDescriptor !== null,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      onNodeResize,
      onNodeGeometryMutated,
      applySize: ({ width, height }) => {
        nodeEl.style.width = `${width}px`;
        if (height === null) {
          return;
        }
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
  };

  // ── Media layout: media nodes whose preview IS the card ──
  // The card shows only the media plus a floating action bar inside the
  // media's edge, port pins on the side edges, and a status badge only
  // while running/failed.
  if (
    node.kind === "studio.media_ingest" &&
    !isPlaceholder &&
    definition &&
    mediaPreviewDescriptor &&
    mediaPreviewSrc
  ) {
    nodeEl.dataset.chromeLayout = "media";
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
    renderNodeMediaPreview({
      nodeEl,
      node,
      nodeRunState,
      resolveAssetPreviewSrc,
      onRevealPathInFinder,
      onOpenMediaPreview,
    });
    mountResizeFrame();
    renderStudioMediaNodeActionBar({
      nodeEl,
      node,
      definition,
      mediaKind: mediaPreviewDescriptor.kind,
      interactionLocked,
      onRunNode,
      onRemoveNode,
      onNodeConfigValueChange,
      onOpenImageEditor,
      onEditImageWithAi,
      onCopyNodeImageToClipboard,
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

  if (node.kind === "studio.text_output" && isPlaceholder) {
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

  mountResizeFrame();

  if (!isPlaceholder) {
    renderCollapsedVisibilityControls({
      nodeEl,
      node,
      busy,
      nodeDetailMode,
      onNodeConfigMutated,
      onNodeConfigValueChange,
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

  // No hover chrome: every control rendered above — header actions, ports,
  // config fields, previews, status — lives on the card in normal flow,
  // visible whether or not the pointer is over the node. Media cards are the
  // one structural exception (the media-chrome branch above): the card IS
  // the media and actions live in the always-visible pill action bar.
}
