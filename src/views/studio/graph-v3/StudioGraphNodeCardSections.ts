import { Notice } from "obsidian";
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../studio/types";
import { isStudioVisualOnlyNodeKind } from "../../../studio/StudioNodeKinds";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import {
  isStudioCollapsedSectionApplicableToNode,
  listStudioCollapsedDetailSections,
  resolveStudioCollapsedSectionLabel,
  resolveStudioNodeDetailSectionVisibility,
  writeStudioCollapsedSectionVisibilityOverride,
  type StudioNodeDetailMode,
} from "./StudioGraphNodeDetailMode";
import {
  statusLabelForNode,
  type StudioNodeRunDisplayState,
} from "../StudioRunPresentationState";
import { resolveNodeMediaPreview } from "./StudioGraphMediaPreview";

export function bindNodeCardPointerDown(options: {
  nodeEl: HTMLElement;
  nodeId: string;
  graphInteraction: StudioGraphInteractionEngine;
}): void {
  const { nodeEl, nodeId, graphInteraction } = options;
  nodeEl.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    const target = pointerEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (
      target.closest(
        "input, button, select, textarea, a, .ss-studio-port-pin, .ss-studio-label-resize-handle, .ss-studio-node-resize-handle, .ss-studio-label-display, .ss-studio-terminal-surface, .ss-studio-terminal-resize-handle, .ss-studio-terminal-panel"
      )
    ) {
      return;
    }

    const modifierToggle = pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey;
    if (modifierToggle) {
      graphInteraction.toggleNodeSelection(nodeId);
      return;
    }

    graphInteraction.startNodeDrag(nodeId, pointerEvent, nodeEl);
  });
}

export function renderNodeHeader(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  interactionLocked: boolean;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
  onRunNode: (nodeId: string) => void;
  onCopyTextGenerationPromptBundle: (nodeId: string) => void;
  onToggleTextGenerationOutputLock: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
}): void {
  const {
    nodeEl,
    node,
    interactionLocked,
    onNodeTitleInput,
    onRunNode,
    onCopyTextGenerationPromptBundle,
    onToggleTextGenerationOutputLock,
    onRemoveNode,
  } = options;

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
  const isVisualOnlyNode = isStudioVisualOnlyNodeKind(node.kind);
  runButton.disabled = interactionLocked || isVisualOnlyNode;
  if (isVisualOnlyNode) {
    runButton.setAttribute("title", "Interactive node (not part of graph execution)");
    runButton.setAttribute("aria-label", "Interactive node (not part of graph execution)");
  }
  runButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isVisualOnlyNode) {
      return;
    }
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
}

export function renderNodeStatusRow(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  isPlaceholder: boolean;
  nodeRunState: StudioNodeRunDisplayState;
  resolveNodeBadge?: (node: StudioNodeInstance) => {
    text: string;
    tone?: "neutral" | "warning";
    title?: string;
  } | null;
}): void {
  const { nodeEl, node, isPlaceholder, nodeRunState, resolveNodeBadge } = options;
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
}

export function renderNodePorts(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  definition: StudioNodeDefinition | null;
  graphInteraction: StudioGraphInteractionEngine;
  interactionLocked: boolean;
}): void {
  const { nodeEl, node, definition, graphInteraction, interactionLocked } = options;
  const inputPorts = definition?.inputPorts || [];
  const outputPorts = definition?.outputPorts || [];
  if (inputPorts.length === 0 && outputPorts.length === 0) {
    return;
  }

  const ports = nodeEl.createDiv({ cls: "ss-studio-node-ports" });
  if (inputPorts.length === 0 || outputPorts.length === 0) {
    ports.addClass("is-single-col");
  }

  if (inputPorts.length > 0) {
    const inputsCol = ports.createDiv({ cls: "ss-studio-node-ports-col" });
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

  if (outputPorts.length > 0) {
    const outputsCol = ports.createDiv({ cls: "ss-studio-node-ports-col" });
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
}

function extractPathExtension(path: string): string {
  const normalized = String(path || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const withoutQuery = normalized.split(/[?#]/, 1)[0];
  const dot = withoutQuery.lastIndexOf(".");
  return dot >= 0 ? withoutQuery.slice(dot + 1) : "";
}

function mediaIngestLooksLikeImage(node: StudioNodeInstance, nodeRunState: StudioNodeRunDisplayState): boolean {
  const mediaPreview = resolveNodeMediaPreview(node, nodeRunState.outputs as Record<string, unknown> | null);
  if (mediaPreview?.kind === "image") {
    return true;
  }
  if (node.kind !== "studio.media_ingest") {
    return false;
  }
  const outputs = (nodeRunState.outputs || {}) as Record<string, unknown>;
  const candidatePaths = [
    typeof outputs.preview_path === "string" ? outputs.preview_path : "",
    typeof outputs.path === "string" ? outputs.path : "",
    typeof node.config.sourcePath === "string" ? node.config.sourcePath : "",
  ];
  const extension = candidatePaths.map((value) => extractPathExtension(value)).find(Boolean) || "";
  return new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "avif", "svg"]).has(extension);
}

export function renderCollapsedVisibilityControls(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  busy: boolean;
  nodeDetailMode: StudioNodeDetailMode;
  nodeRunState: StudioNodeRunDisplayState;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onOpenImageEditor?: (node: StudioNodeInstance) => void;
  onCopyNodeImageToClipboard?: (node: StudioNodeInstance) => void;
  onNodePresentationMutated?: (node: StudioNodeInstance) => void;
}): void {
  const {
    nodeEl,
    node,
    busy,
    nodeDetailMode,
    nodeRunState,
    onNodeConfigMutated,
    onOpenImageEditor,
    onCopyNodeImageToClipboard,
    onNodePresentationMutated,
  } = options;
  if (nodeDetailMode !== "expanded") {
    return;
  }
  if (node.kind === "studio.label") {
    return;
  }

  const sections = listStudioCollapsedDetailSections().filter((section) =>
    isStudioCollapsedSectionApplicableToNode(node, section)
  );
  const hasImageActions = mediaIngestLooksLikeImage(node, nodeRunState);
  const showEditorAction = node.kind === "studio.media_ingest" && hasImageActions && typeof onOpenImageEditor === "function";
  const showCopyImageAction = hasImageActions && typeof onCopyNodeImageToClipboard === "function";
  if (sections.length === 0 && !showEditorAction && !showCopyImageAction) {
    return;
  }

  const wrapEl = nodeEl.createDiv({ cls: "ss-studio-node-collapsed-visibility" });
  wrapEl.createDiv({
    cls: "ss-studio-node-collapsed-visibility-title",
    text: "Quick Actions",
  });
  const buttonsEl = wrapEl.createDiv({ cls: "ss-studio-node-collapsed-visibility-buttons" });
  const commitPresentationMutation = (): void => {
    if (onNodePresentationMutated) {
      onNodePresentationMutated(node);
      return;
    }
    onNodeConfigMutated(node);
  };

  for (const section of sections) {
    const metadata = resolveStudioCollapsedSectionLabel(section);
    const button = buttonsEl.createEl("button", {
      cls: "ss-studio-node-collapsed-visibility-button",
      text: metadata.shortLabel,
      attr: {
        "aria-label": `Show ${metadata.summary} in collapsed mode`,
        title: `Show ${metadata.summary} in collapsed mode`,
      },
    });
    button.type = "button";
    button.disabled = busy;

    const syncVisualState = (): void => {
      const visibleInCollapsed = resolveStudioNodeDetailSectionVisibility({
        node,
        mode: "collapsed",
        section,
      });
      button.classList.toggle("is-active", visibleInCollapsed);
      button.setAttr("aria-pressed", visibleInCollapsed ? "true" : "false");
    };
    syncVisualState();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (busy) {
        return;
      }
      const currentlyVisible = resolveStudioNodeDetailSectionVisibility({
        node,
        mode: "collapsed",
        section,
      });
      const changed = writeStudioCollapsedSectionVisibilityOverride({
        node,
        section,
        visibleInCollapsed: !currentlyVisible,
      });
      if (!changed) {
        return;
      }
      commitPresentationMutation();
      syncVisualState();
    });
  }

  if (showEditorAction) {
    const button = buttonsEl.createEl("button", {
      cls: "ss-studio-node-collapsed-visibility-button",
      text: "Edit Image",
      attr: {
        "aria-label": "Open image editor",
        title: "Open image editor",
      },
    });
    button.type = "button";
    button.disabled = busy;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) {
        onOpenImageEditor?.(node);
      }
    });
  }

  if (showCopyImageAction) {
    const button = buttonsEl.createEl("button", {
      cls: "ss-studio-node-collapsed-visibility-button",
      text: "Copy Image",
      attr: {
        "aria-label": "Copy image to clipboard",
        title: "Copy image to clipboard",
      },
    });
    button.type = "button";
    button.disabled = busy;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) {
        onCopyNodeImageToClipboard?.(node);
      }
    });
  }
}
