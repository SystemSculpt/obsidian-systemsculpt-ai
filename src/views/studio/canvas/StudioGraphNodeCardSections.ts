import { Notice } from "obsidian";
import type { StudioNodeDefinition, StudioNodeInstance } from "../../../studio/types";
import { isStudioVisualOnlyNodeKind } from "../../../studio/StudioNodeKinds";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import { createStudioAction } from "../StudioAction";
import type { StudioNodeActivity } from "../activity/StudioActivity";
import { renderStudioActivityBadge } from "../activity/StudioActivityBadge";

export function renderNodeHeader(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  interactionLocked: boolean;
  runUnavailableReason?: string;
  runLocked?: boolean;
  /** Panel surfaces expose their definition through one header toggle. */
  sourceToggle?: { isActive: () => boolean; onToggle: () => void };
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
  onRunNode: (nodeId: string) => void;
  onCopyTextGenerationPromptBundle: (nodeId: string) => void;
  onToggleTextGenerationOutputLock: (nodeId: string) => void;
  onRemoveNode: (nodeId: string) => void;
}): { sourceToggle: HTMLButtonElement | null } {
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
  header.createSpan({ cls: "ss-studio-node-type", text: node.kind.replace(/^studio\./u, "").replace(/_/gu, " "), attr: { "data-testid": "studio.node.type" } });
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
  const unavailable = node.kind === 'studio.workflow';
  if (!["studio.button", "studio.command_center"].includes(node.kind)) createStudioAction(header, {
    className: "ss-studio-node-run",
    label: "Run",
    testId: "studio.node.run",
    ariaLabel: isVisualOnlyNode
      ? "Interactive node (not part of graph execution)"
      : "Run node",
    title: options.runUnavailableReason || (unavailable ? 'Execution connection unavailable' : isVisualOnlyNode
      ? "Interactive node (not part of graph execution)"
      : "Run node"),
    size: "small",
    disabled: (options.runLocked ?? interactionLocked) || isVisualOnlyNode || unavailable || Boolean(options.runUnavailableReason),
    onSelect: () => {
      if (!isVisualOnlyNode && !unavailable && !options.runUnavailableReason) {
        onRunNode(node.id);
      }
    },
  });

  if (node.kind === "studio.text_generation") {
    const outputLocked = node.config.lockOutput === true;
    createStudioAction(header, {
      className: "ss-studio-node-copy-prompt",
      label: "Copy",
      testId: "studio.node.copy-prompt",
      ariaLabel: "Copy prompt bundle for handoff",
      title: "Copy prompt bundle for handoff",
      size: "small",
      disabled: interactionLocked,
      onSelect: () => onCopyTextGenerationPromptBundle(node.id),
    });

    createStudioAction(header, {
      className: "ss-studio-node-lock-output",
      label: outputLocked ? "Unlock" : "Lock",
      testId: "studio.node.lock-output",
      ariaLabel: outputLocked ? "Unlock text output" : "Lock text output",
      title: outputLocked ? "Unlock text output" : "Lock text output",
      size: "small",
      selected: outputLocked,
      disabled: interactionLocked,
      onSelect: () => onToggleTextGenerationOutputLock(node.id),
    });
  }

  let sourceToggle: HTMLButtonElement | null = null;
  if (options.sourceToggle) {
    const toggle = options.sourceToggle;
    sourceToggle = createStudioAction(header, {
      className: "ss-studio-node-source-toggle",
      label: "Source",
      testId: "studio.node.source",
      ariaLabel: "Show source definition",
      title: "Show source definition",
      size: "small",
      selected: toggle.isActive(),
      onSelect: () => toggle.onToggle(),
    });
  }

  createStudioAction(header, {
    className: "ss-studio-node-remove",
    label: "×",
    testId: "studio.node.remove",
    ariaLabel: "Remove node",
    title: "Remove node",
    size: "small",
    disabled: interactionLocked,
    onSelect: () => onRemoveNode(node.id),
  });
  return { sourceToggle };
}

/**
 * The uniform activity row (views/studio/activity). Always rendered so run
 * state can be patched in place; it hides itself while idle unless the node
 * carries a note.
 */
export function renderNodeStatusRow(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  activity: StudioNodeActivity;
  resolveNodeBadge?: (node: StudioNodeInstance) => {
    text: string;
    tone?: "neutral" | "warning";
    title?: string;
  } | null;
}): HTMLElement {
  const { nodeEl, node, activity, resolveNodeBadge } = options;
  return renderStudioActivityBadge(nodeEl, { activity, note: resolveNodeBadge?.(node) || null });
}

export function renderNodePorts(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  definition: StudioNodeDefinition | null;
  graphInteraction: StudioGraphInteractionEngine;
  interactionLocked: boolean;
  /** Inputs the selected model does not accept; hidden unless something is wired to them. */
  hiddenInputPortIds?: ReadonlySet<string>;
  inputPortNotes?: Readonly<Record<string, string>>;
  connectedInputPortIds?: ReadonlySet<string>;
}): void {
  const { nodeEl, node, definition, graphInteraction, interactionLocked } = options;
  const hidden = options.hiddenInputPortIds;
  const connected = options.connectedInputPortIds;
  const inputPorts = (definition?.inputPorts || []).filter(port => !hidden?.has(port.id) || connected?.has(port.id));
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
      const unsupported = hidden?.has(port.id) === true;
      const note = unsupported ? "Not accepted by the selected model." : options.inputPortNotes?.[port.id] || port.description;
      const row = inputsCol.createDiv({ cls: `ss-studio-port-row${unsupported ? " is-unsupported" : ""}` });
      const pin = row.createEl("button", {
        cls: "ss-studio-port-pin is-input",
        attr: {
          type: "button",
          title: note ? `${port.id} (${port.type}) — ${note}` : `${port.id} (${port.type})`,
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
        graphInteraction.startConnectionDrag(node.id, port.id, event, pin);
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
