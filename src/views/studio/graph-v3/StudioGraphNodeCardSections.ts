import { Notice } from "obsidian";
import type { StudioJsonValue, StudioNodeDefinition, StudioNodeInstance } from "../../../studio/types";
import { isStudioVisualOnlyNodeKind } from "../../../studio/StudioNodeKinds";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import {
  isStudioCollapsedSectionApplicableToNode,
  listStudioCollapsedDetailSections,
  resolveStudioCollapsedSectionLabel,
  resolveStudioNodeDetailSectionVisibility,
  STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY,
  writeStudioCollapsedSectionVisibilityOverride,
  type StudioNodeDetailMode,
} from "./StudioGraphNodeDetailMode";
import {
  statusLabelForNode,
  type StudioNodeRunDisplayState,
} from "../StudioRunPresentationState";
import { createStudioAction } from "../StudioAction";

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

  const isVisualOnlyNode = isStudioVisualOnlyNodeKind(node.kind);
  createStudioAction(header, {
    className: "ss-studio-node-run",
    label: "Run",
    ariaLabel: isVisualOnlyNode
      ? "Interactive node (not part of graph execution)"
      : "Run node",
    title: isVisualOnlyNode
      ? "Interactive node (not part of graph execution)"
      : "Run node",
    size: "small",
    disabled: interactionLocked || isVisualOnlyNode,
    onSelect: () => {
      if (!isVisualOnlyNode) {
        onRunNode(node.id);
      }
    },
  });

  if (node.kind === "studio.text_generation") {
    const outputLocked = node.config.lockOutput === true;
    createStudioAction(header, {
      className: "ss-studio-node-copy-prompt",
      label: "Copy",
      ariaLabel: "Copy prompt bundle for handoff",
      title: "Copy prompt bundle for handoff",
      size: "small",
      disabled: interactionLocked,
      onSelect: () => onCopyTextGenerationPromptBundle(node.id),
    });

    createStudioAction(header, {
      className: "ss-studio-node-lock-output",
      label: outputLocked ? "Unlock" : "Lock",
      ariaLabel: outputLocked ? "Unlock text output" : "Lock text output",
      title: outputLocked ? "Unlock text output" : "Lock text output",
      size: "small",
      selected: outputLocked,
      disabled: interactionLocked,
      onSelect: () => onToggleTextGenerationOutputLock(node.id),
    });
  }

  createStudioAction(header, {
    className: "ss-studio-node-remove",
    label: "×",
    ariaLabel: "Remove node",
    title: "Remove node",
    size: "small",
    disabled: interactionLocked,
    onSelect: () => onRemoveNode(node.id),
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
  const statusEl = statusRow.createDiv({
    cls: `ss-studio-node-run-status is-${statusTone}`,
    text: statusText,
  });
  const statusMessage = isPlaceholder ? "" : nodeRunState.message.trim();
  if (statusMessage) {
    statusEl.title = statusMessage;
  }
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
        attr: {
          type: "button",
          title: `${port.id} (${port.type})`,
          "aria-label": `${port.id} input (${port.type})`,
        },
      });
      pin.dataset.nodeId = node.id;
      pin.dataset.portId = port.id;
      pin.dataset.portDirection = "in";
      pin.disabled = interactionLocked;
      row.createSpan({
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
      const isPendingSource = graphInteraction.isPendingConnectionSource(node.id, port.id);
      const row = outputsCol.createDiv({ cls: "ss-studio-port-row is-output" });
      row.createSpan({ cls: "ss-studio-port-label", text: port.id });
      const pin = row.createEl("button", {
        cls: `ss-studio-port-pin is-output ${isPendingSource ? "is-active" : ""}`,
        attr: {
          type: "button",
          title: `${port.id} (${port.type})`,
          "aria-label": `${port.id} output (${port.type})`,
          "aria-pressed": isPendingSource ? "true" : "false",
        },
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

export function renderCollapsedVisibilityControls(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  busy: boolean;
  nodeDetailMode: StudioNodeDetailMode;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue | null,
    options?: { mode?: "discrete" | "continuous"; captureHistory?: boolean }
  ) => void;
}): void {
  const {
    nodeEl,
    node,
    busy,
    nodeDetailMode,
    onNodeConfigMutated,
    onNodeConfigValueChange,
  } = options;
  if (nodeDetailMode !== "expanded") {
    return;
  }
  if (node.kind === "studio.text") {
    return;
  }

  const sections = listStudioCollapsedDetailSections().filter((section) =>
    isStudioCollapsedSectionApplicableToNode(node, section)
  );
  if (sections.length === 0) {
    return;
  }

  const wrapEl = nodeEl.createDiv({ cls: "ss-studio-node-collapsed-visibility" });
  wrapEl.createDiv({
    cls: "ss-studio-node-collapsed-visibility-title",
    text: "Collapsed view",
  });
  const buttonsEl = wrapEl.createDiv({ cls: "ss-studio-node-collapsed-visibility-buttons" });
  const commitPresentationMutation = (nextValue: StudioJsonValue | null): void => {
    if (onNodeConfigValueChange) {
      onNodeConfigValueChange(
        node.id,
        STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY,
        nextValue,
        { mode: "discrete" }
      );
      return;
    }
    onNodeConfigMutated(node);
  };

  for (const section of sections) {
    const metadata = resolveStudioCollapsedSectionLabel(section);
    let button: HTMLButtonElement;
    const syncVisualState = (): void => {
      const visibleInCollapsed = resolveStudioNodeDetailSectionVisibility({
        node,
        mode: "collapsed",
        section,
      });
      button.classList.toggle("is-selected", visibleInCollapsed);
      button.setAttr("aria-pressed", visibleInCollapsed ? "true" : "false");
    };
    button = createStudioAction(buttonsEl, {
      className: "ss-studio-node-collapsed-visibility-button",
      label: metadata.shortLabel,
      ariaLabel: `Show ${metadata.summary} in collapsed mode`,
      title: `Show ${metadata.summary} in collapsed mode`,
      size: "small",
      selected: false,
      disabled: busy,
      onSelect: () => {
        if (busy) {
          return;
        }
        const currentlyVisible = resolveStudioNodeDetailSectionVisibility({
          node,
          mode: "collapsed",
          section,
        });
        const draftNode: StudioNodeInstance = {
          ...node,
          config: {
            ...node.config,
          },
        };
        const changed = writeStudioCollapsedSectionVisibilityOverride({
          node: draftNode,
          section,
          visibleInCollapsed: !currentlyVisible,
        });
        if (!changed) {
          return;
        }
        commitPresentationMutation(
          (draftNode.config[STUDIO_NODE_COLLAPSED_VISIBILITY_CONFIG_KEY] ?? null) as StudioJsonValue | null
        );
        syncVisualState();
      },
    });
    syncVisualState();
  }
}
