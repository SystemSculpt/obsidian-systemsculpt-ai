import { Notice } from "obsidian";
import type {
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import { isManagedOutputPlaceholderNode } from "../StudioManagedOutputNodes";
import { formatNodeConfigPreview } from "../StudioViewHelpers";
import { resolveNodeMediaPreview } from "./StudioGraphMediaPreview";
import {
  renderStudioNodeInlineEditor,
  shouldSuppressNodeOutputPreview,
} from "./StudioGraphNodeInlineEditors";
import {
  isStudioExpandedTextNodeKind,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeWidth,
  resolveStudioLabelFontSize,
  resolveStudioLabelHeight,
  resolveStudioLabelWidth,
  STUDIO_GRAPH_LABEL_DEFAULT_FONT_SIZE,
  STUDIO_GRAPH_LABEL_MAX_FONT_SIZE,
  STUDIO_GRAPH_LABEL_MAX_HEIGHT,
  STUDIO_GRAPH_LABEL_MAX_WIDTH,
  STUDIO_GRAPH_LABEL_MIN_FONT_SIZE,
  STUDIO_GRAPH_LABEL_MIN_HEIGHT,
  STUDIO_GRAPH_LABEL_MIN_WIDTH,
} from "./StudioGraphNodeGeometry";
import {
  formatNodeOutputPreview,
  statusLabelForNode,
  type StudioNodeRunDisplayState,
} from "../StudioRunPresentationState";

type RenderStudioGraphNodeCardOptions = {
  layer: HTMLElement;
  busy: boolean;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  graphInteraction: StudioGraphInteractionEngine;
  findNodeDefinition: (node: StudioNodeInstance) => StudioNodeDefinition | null;
  resolveAssetPreviewSrc?: (assetPath: string) => string | null;
  onOpenMediaPreview?: (options: {
    kind: "image" | "video";
    path: string;
    src: string;
    title: string;
  }) => void;
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

function readLabelText(node: StudioNodeInstance): string {
  const value = node.config.value;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function clampLabelMetric(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function resolveMediaIngestRevealPath(
  node: StudioNodeInstance,
  outputs: Record<string, unknown> | null,
  fallbackPath: string
): string {
  if (node.kind !== "studio.media_ingest") {
    return "";
  }

  const outputPath = typeof outputs?.path === "string" ? outputs.path.trim() : "";
  if (outputPath) {
    return outputPath;
  }
  const config = (node.config || {}) as Record<string, unknown>;
  const configuredPath = typeof config.sourcePath === "string" ? config.sourcePath.trim() : "";
  if (configuredPath) {
    return configuredPath;
  }
  return String(fallbackPath || "").trim();
}

function renderLabelNodeCard(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  busy: boolean;
  graphInteraction: StudioGraphInteractionEngine;
  onRemoveNode: (nodeId: string) => void;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  isEditing: boolean;
  shouldAutoFocus: boolean;
  onRequestLabelEdit: (nodeId: string) => void;
  onStopLabelEdit: (nodeId: string) => void;
}): void {
  const {
    nodeEl,
    node,
    busy,
    graphInteraction,
    onRemoveNode,
    onNodeConfigMutated,
    onNodeGeometryMutated,
    isEditing,
    shouldAutoFocus,
    onRequestLabelEdit,
    onStopLabelEdit,
  } = options;

  nodeEl.addClass("ss-studio-label-card");
  const applyDimensions = (): void => {
    const width = resolveStudioLabelWidth(node);
    const height = resolveStudioLabelHeight(node);
    node.config.width = width;
    node.config.height = height;
    nodeEl.style.width = `${width}px`;
    nodeEl.style.height = `${height}px`;
  };
  applyDimensions();

  const toolbarEl = nodeEl.createDiv({ cls: "ss-studio-label-toolbar" });
  const fontControlsEl = toolbarEl.createDiv({ cls: "ss-studio-label-font-controls" });

  const decreaseButton = fontControlsEl.createEl("button", {
    cls: "ss-studio-label-font-button",
    text: "A-",
    attr: {
      title: "Decrease label text size",
      "aria-label": "Decrease label text size",
    },
  });
  decreaseButton.type = "button";
  const increaseButton = fontControlsEl.createEl("button", {
    cls: "ss-studio-label-font-button",
    text: "A+",
    attr: {
      title: "Increase label text size",
      "aria-label": "Increase label text size",
    },
  });
  increaseButton.type = "button";
  const removeButton = toolbarEl.createEl("button", {
    cls: "ss-studio-label-remove",
    text: "×",
    attr: {
      title: "Delete label",
      "aria-label": "Delete label",
    },
  });
  removeButton.type = "button";

  decreaseButton.disabled = busy;
  increaseButton.disabled = busy;
  removeButton.disabled = busy;

  const getCurrentFontSize = (): number => resolveStudioLabelFontSize(node);
  let textSurfaceEl: HTMLElement | HTMLTextAreaElement | null = null;
  const applyFontSize = (fontSize: number): void => {
    if (textSurfaceEl) {
      textSurfaceEl.style.fontSize = `${fontSize}px`;
    }
  };
  const commitFontSize = (next: number): void => {
    const normalized = clampLabelMetric(
      next,
      STUDIO_GRAPH_LABEL_MIN_FONT_SIZE,
      STUDIO_GRAPH_LABEL_MAX_FONT_SIZE
    );
    node.config.fontSize = normalized;
    applyFontSize(normalized);
    onNodeConfigMutated(node);
  };
  decreaseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    commitFontSize(getCurrentFontSize() - 1);
  });
  increaseButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) {
      return;
    }
    commitFontSize(getCurrentFontSize() + 1);
  });
  removeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onRemoveNode(node.id);
  });

  const contentEl = nodeEl.createDiv({ cls: "ss-studio-label-content" });
  const labelText = readLabelText(node);
  const fontSize = getCurrentFontSize() || STUDIO_GRAPH_LABEL_DEFAULT_FONT_SIZE;

  if (isEditing) {
    const textAreaEl = contentEl.createEl("textarea", {
      cls: "ss-studio-label-editor",
      attr: {
        "aria-label": `${node.title || "Label"} content`,
      },
    });
    textAreaEl.value = labelText;
    textAreaEl.disabled = busy;
    textSurfaceEl = textAreaEl;
    applyFontSize(fontSize);
    textAreaEl.addEventListener("input", (event) => {
      node.config.value = (event.target as HTMLTextAreaElement).value;
      onNodeConfigMutated(node);
    });
    textAreaEl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      textAreaEl.blur();
    });
    textAreaEl.addEventListener("blur", () => {
      onStopLabelEdit(node.id);
    });
    if (shouldAutoFocus && !busy) {
      window.requestAnimationFrame(() => {
        textAreaEl.focus();
        textAreaEl.select();
      });
    }
  } else {
    const displayEl = contentEl.createDiv({
      cls: "ss-studio-label-display",
      text: labelText.trim().length > 0 ? labelText : "Label",
    });
    textSurfaceEl = displayEl;
    applyFontSize(fontSize);
    displayEl.addEventListener("click", (event) => {
      const pointerEvent = event as MouseEvent;
      if (pointerEvent.button !== 0) {
        return;
      }
      if (pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey) {
        graphInteraction.toggleNodeSelection(node.id);
        return;
      }
      graphInteraction.ensureSingleSelection(node.id);
    });
    displayEl.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      graphInteraction.ensureSingleSelection(node.id);
      onRequestLabelEdit(node.id);
    });
  }

  const resizeHandle = nodeEl.createDiv({
    cls: "ss-studio-label-resize-handle",
    attr: {
      title: "Resize label",
      "aria-label": "Resize label",
    },
  });
  resizeHandle.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    if (busy || pointerEvent.button !== 0) {
      return;
    }
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();

    const pointerId = pointerEvent.pointerId;
    const startWidth = resolveStudioLabelWidth(node);
    const startHeight = resolveStudioLabelHeight(node);
    const startX = pointerEvent.clientX;
    const startY = pointerEvent.clientY;
    const zoom = graphInteraction.getGraphZoom() || 1;

    if (typeof resizeHandle.setPointerCapture === "function") {
      try {
        resizeHandle.setPointerCapture(pointerId);
      } catch {
        // Ignore capture errors; window listeners are fallback.
      }
    }

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const nextWidth = clampLabelMetric(
        startWidth + (moveEvent.clientX - startX) / zoom,
        STUDIO_GRAPH_LABEL_MIN_WIDTH,
        STUDIO_GRAPH_LABEL_MAX_WIDTH
      );
      const nextHeight = clampLabelMetric(
        startHeight + (moveEvent.clientY - startY) / zoom,
        STUDIO_GRAPH_LABEL_MIN_HEIGHT,
        STUDIO_GRAPH_LABEL_MAX_HEIGHT
      );
      if (
        Number(node.config.width) === nextWidth &&
        Number(node.config.height) === nextHeight
      ) {
        return;
      }
      node.config.width = nextWidth;
      node.config.height = nextHeight;
      nodeEl.style.width = `${nextWidth}px`;
      nodeEl.style.height = `${nextHeight}px`;
      onNodeGeometryMutated(node);
    };

    const finishResize = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      if (typeof resizeHandle.releasePointerCapture === "function") {
        try {
          resizeHandle.releasePointerCapture(pointerId);
        } catch {
          // Ignore release errors.
        }
      }
      applyDimensions();
      onNodeConfigMutated(node);
      onNodeGeometryMutated(node);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  });
}

export function renderStudioGraphNodeCard(options: RenderStudioGraphNodeCardOptions): void {
  const {
    layer,
    busy,
    node,
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
  nodeEl.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
  nodeEl.style.width = `${resolveStudioGraphNodeWidth(node)}px`;
  const resolvedMinHeight = resolveStudioGraphNodeMinHeight(node);
  if (resolvedMinHeight > 0) {
    nodeEl.style.minHeight = `${resolvedMinHeight}px`;
  }
  nodeEl.classList.toggle("is-expanded-text-node", isStudioExpandedTextNodeKind(node.kind));
  nodeEl.classList.toggle("is-selected", graphInteraction.isNodeSelected(node.id));
  nodeEl.classList.toggle("is-managed-pending", isPlaceholder);
  graphInteraction.registerNodeElement(node.id, nodeEl);

  nodeEl.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    const target = pointerEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (
      target.closest(
        "input, button, select, textarea, a, .ss-studio-port-pin, .ss-studio-label-resize-handle, .ss-studio-label-display"
      )
    ) {
      return;
    }

    const modifierToggle = pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey;
    if (modifierToggle) {
      graphInteraction.toggleNodeSelection(node.id);
      return;
    }

    graphInteraction.startNodeDrag(node.id, pointerEvent, nodeEl);
  });

  if (node.kind === "studio.label") {
    renderLabelNodeCard({
      nodeEl,
      node,
      busy,
      graphInteraction,
      onRemoveNode,
      onNodeConfigMutated,
      onNodeGeometryMutated,
      isEditing: isLabelEditing(node.id),
      shouldAutoFocus: consumeLabelAutoFocus(node.id),
      onRequestLabelEdit,
      onStopLabelEdit,
    });
    return;
  }

  const header = nodeEl.createDiv({ cls: "ss-studio-node-header" });
  const titleInput = header.createEl("input", {
    type: "text",
    cls: "ss-studio-node-title-input",
  });
  titleInput.value = node.title;
  titleInput.disabled = interactionLocked;
  titleInput.addEventListener("input", (event) => {
    onNodeTitleInput(node, (event.target as HTMLInputElement).value);
  });

  const runButton = header.createEl("button", {
    text: "Run",
    cls: "ss-studio-node-run",
  });
  runButton.disabled = interactionLocked;
  runButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onRunNode(node.id);
  });

  if (node.kind === "studio.text_generation") {
    const outputLocked = node.config.lockOutput === true;
    const copyPromptButton = header.createEl("button", {
      text: "Copy",
      cls: "ss-studio-node-copy-prompt",
      attr: {
        title: "Copy prompt bundle for handoff",
        "aria-label": "Copy prompt bundle for handoff",
      },
    });
    copyPromptButton.disabled = interactionLocked;
    copyPromptButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onCopyTextGenerationPromptBundle(node.id);
    });

    const lockOutputButton = header.createEl("button", {
      text: outputLocked ? "Unlock" : "Lock",
      cls: "ss-studio-node-lock-output",
      attr: {
        title: outputLocked ? "Unlock text output" : "Lock text output",
        "aria-label": outputLocked ? "Unlock text output" : "Lock text output",
      },
    });
    lockOutputButton.disabled = interactionLocked;
    lockOutputButton.classList.toggle("is-active", outputLocked);
    lockOutputButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onToggleTextGenerationOutputLock(node.id);
    });
  }

  const removeButton = header.createEl("button", {
    text: "×",
    cls: "ss-studio-node-remove",
  });
  removeButton.disabled = interactionLocked;
  removeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onRemoveNode(node.id);
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

  const statusRow = nodeEl.createDiv({ cls: "ss-studio-node-run-status-row" });
  const statusTone = isPlaceholder ? "pending" : nodeRunState.status;
  const statusText = isPlaceholder ? "Generating" : statusLabelForNode(nodeRunState.status);
  statusRow.createDiv({
    cls: `ss-studio-node-run-status is-${statusTone}`,
    text: statusText,
  });
  const statusMessage = isPlaceholder ? "" : nodeRunState.message.trim();
  if (statusMessage) {
    statusRow.createDiv({
      cls: "ss-studio-node-run-message",
      text: statusMessage,
    });
  }
  const nodeBadge = resolveNodeBadge?.(node) || null;
  if (nodeBadge && nodeBadge.text.trim().length > 0) {
    const badgeEl = statusRow.createDiv({
      cls: `ss-studio-node-badge is-${nodeBadge.tone || "neutral"}`,
      text: nodeBadge.text.trim(),
    });
    const tooltip = String(nodeBadge.title || "").trim();
    if (tooltip) {
      badgeEl.title = tooltip;
      badgeEl.setAttribute("aria-label", tooltip);
    }
  }

  const ports = nodeEl.createDiv({ cls: "ss-studio-node-ports" });
  const inputsCol = ports.createDiv({ cls: "ss-studio-node-ports-col" });
  const outputsCol = ports.createDiv({ cls: "ss-studio-node-ports-col" });

  const inputPorts = definition?.inputPorts || [];
  if (inputPorts.length === 0) {
    inputsCol.createEl("div", { cls: "ss-studio-node-port-empty", text: "No inputs" });
  } else {
    for (const port of inputPorts) {
      const row = inputsCol.createDiv({ cls: "ss-studio-port-row" });
      const pin = row.createEl("button", {
        cls: "ss-studio-port-pin is-input",
        attr: { title: `${port.id} (${port.type})` },
      });
      pin.dataset.nodeId = node.id;
      pin.dataset.portId = port.id;
      pin.dataset.portDirection = "in";
      pin.disabled = interactionLocked;
      row.createEl("span", {
        cls: "ss-studio-port-label",
        text: `${port.id}${port.required ? "*" : ""}`,
      });
      graphInteraction.registerPortElement(node.id, "in", port.id, pin);
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!graphInteraction.getPendingConnection()) {
          new Notice("Select an output port first.");
          return;
        }
        graphInteraction.completeConnection(node.id, port.id);
      });
    }
  }

  const outputPorts = definition?.outputPorts || [];
  if (outputPorts.length === 0) {
    outputsCol.createEl("div", { cls: "ss-studio-node-port-empty", text: "No outputs" });
  } else {
    for (const port of outputPorts) {
      const row = outputsCol.createDiv({ cls: "ss-studio-port-row is-output" });
      row.createEl("span", { cls: "ss-studio-port-label", text: port.id });
      const pin = row.createEl("button", {
        cls: `ss-studio-port-pin is-output ${
          graphInteraction.isPendingConnectionSource(node.id, port.id) ? "is-active" : ""
        }`,
        attr: { title: `${port.id} (${port.type})` },
      });
      pin.dataset.nodeId = node.id;
      pin.dataset.portId = port.id;
      pin.dataset.portDirection = "out";
      pin.disabled = interactionLocked;
      graphInteraction.registerPortElement(node.id, "out", port.id, pin);
      pin.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        graphInteraction.startConnectionDrag(node.id, port.id, event as PointerEvent, pin);
      });
      pin.addEventListener("click", (event) => {
        event.stopPropagation();
        if (graphInteraction.consumeSuppressedOutputPortClick(node.id, port.id)) {
          return;
        }
        graphInteraction.beginConnection(node.id, port.id);
      });
    }
  }

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
  const renderedInlineEditor =
    !isPlaceholder &&
    renderStudioNodeInlineEditor({
      nodeEl,
      node,
      nodeRunState,
      definition,
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });

  if (!isPlaceholder && !renderedInlineEditor) {
    const configPreviewEl = nodeEl.createEl("p", {
      cls: "ss-studio-node-config-preview",
      text: formatNodeConfigPreview(node),
    });
    configPreviewEl.setAttribute("data-node-config-preview", node.id);
  }

  const outputPreview = shouldSuppressNodeOutputPreview(node.kind)
    ? ""
    : formatNodeOutputPreview(nodeRunState.outputs);
  if (outputPreview) {
    const outputPreviewEl = nodeEl.createDiv({ cls: "ss-studio-node-output-preview" });
    const separatorIndex = outputPreview.indexOf(":");
    if (separatorIndex > 0 && separatorIndex < 48) {
      const outputLabel = outputPreview.slice(0, separatorIndex).trim();
      const outputValue = outputPreview.slice(separatorIndex + 1).trim();
      outputPreviewEl.createDiv({
        cls: "ss-studio-node-output-label",
        text: outputLabel || "output",
      });
      const valueEl = outputPreviewEl.createEl("code", {
        cls: "ss-studio-node-output-value",
        text: outputValue || "—",
      });
      valueEl.title = outputValue || outputPreview;
    } else {
      const fallbackValueEl = outputPreviewEl.createEl("code", {
        cls: "ss-studio-node-output-value",
        text: outputPreview,
      });
      fallbackValueEl.title = outputPreview;
    }
  }

  if (node.kind === "studio.media_ingest" && isPlaceholder) {
    const pendingPreviewEl = nodeEl.createDiv({ cls: "ss-studio-node-pending-preview is-media" });
    pendingPreviewEl.createDiv({
      cls: "ss-studio-node-pending-title",
      text: "Generating image...",
    });
    pendingPreviewEl.createDiv({ cls: "ss-studio-node-pending-frame" });
    return;
  }

  const mediaPreview = resolveNodeMediaPreview(
    node,
    nodeRunState.outputs as Record<string, unknown> | null
  );
  if (mediaPreview && resolveAssetPreviewSrc) {
    const previewSrc = resolveAssetPreviewSrc(mediaPreview.path);
    if (previewSrc) {
      const previewEl = nodeEl.createDiv({ cls: "ss-studio-node-media-preview" });
      if (node.kind === "studio.media_ingest") {
        previewEl.setAttribute("title", "Double-click to reveal in Finder");
      }
      previewEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        const revealPath = resolveMediaIngestRevealPath(
          node,
          nodeRunState.outputs as Record<string, unknown> | null,
          mediaPreview.path
        );
        if (revealPath) {
          onRevealPathInFinder(revealPath);
          return;
        }
        onOpenMediaPreview?.({
          kind: mediaPreview.kind,
          path: mediaPreview.path,
          src: previewSrc,
          title: node.title || node.kind,
        });
      });
      if (mediaPreview.kind === "image") {
        const imageEl = previewEl.createEl("img", {
          cls: "ss-studio-node-media-preview-img",
        });
        imageEl.src = previewSrc;
        imageEl.alt = `${node.title || node.kind} output image`;
        imageEl.loading = "lazy";
        imageEl.decoding = "async";
        imageEl.draggable = false;
      } else {
        const videoEl = previewEl.createEl("video", {
          cls: "ss-studio-node-media-preview-video",
        });
        videoEl.src = previewSrc;
        videoEl.muted = true;
        videoEl.controls = true;
        videoEl.playsInline = true;
        videoEl.preload = "metadata";
        videoEl.setAttribute("aria-label", `${node.title || node.kind} output video`);
      }
    }
  }
}
