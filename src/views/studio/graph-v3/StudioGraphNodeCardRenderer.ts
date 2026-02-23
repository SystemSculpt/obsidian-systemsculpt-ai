import { Notice } from "obsidian";
import type {
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import type { StudioGraphInteractionEngine } from "../StudioGraphInteractionEngine";
import { formatNodeConfigPreview } from "../StudioViewHelpers";
import { resolveNodeMediaPreview } from "./StudioGraphMediaPreview";
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
  onRemoveNode: (nodeId: string) => void;
  onNodeTitleInput: (node: StudioNodeInstance, title: string) => void;
};

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
    onRemoveNode,
    onNodeTitleInput,
  } = options;

  const definition = findNodeDefinition(node);
  const nodeEl = layer.createDiv({ cls: "ss-studio-node-card" });
  nodeEl.dataset.nodeId = node.id;
  nodeEl.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
  nodeEl.classList.toggle("is-selected", graphInteraction.isNodeSelected(node.id));
  graphInteraction.registerNodeElement(node.id, nodeEl);

  const header = nodeEl.createDiv({ cls: "ss-studio-node-header" });
  const titleInput = header.createEl("input", {
    type: "text",
    cls: "ss-studio-node-title-input",
  });
  titleInput.value = node.title;
  titleInput.disabled = busy;
  titleInput.addEventListener("input", (event) => {
    onNodeTitleInput(node, (event.target as HTMLInputElement).value);
  });

  const runButton = header.createEl("button", {
    text: "Run",
    cls: "ss-studio-node-run",
  });
  runButton.disabled = busy;
  runButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onRunNode(node.id);
  });

  const removeButton = header.createEl("button", {
    text: "×",
    cls: "ss-studio-node-remove",
  });
  removeButton.disabled = busy;
  removeButton.addEventListener("click", (event) => {
    event.stopPropagation();
    onRemoveNode(node.id);
  });

  nodeEl.addEventListener("pointerdown", (event) => {
    const pointerEvent = event as PointerEvent;
    const target = pointerEvent.target as HTMLElement | null;
    if (!target) {
      return;
    }
    if (target.closest("input, button, select, textarea, a, .ss-studio-port-pin")) {
      return;
    }

    const modifierToggle = pointerEvent.shiftKey || pointerEvent.metaKey || pointerEvent.ctrlKey;
    if (modifierToggle) {
      graphInteraction.toggleNodeSelection(node.id);
      return;
    }

    graphInteraction.startNodeDrag(node.id, pointerEvent, nodeEl);
  });

  nodeEl.createEl("div", {
    cls: "ss-studio-node-kind",
    text: `${node.kind}@${node.version}`,
  });

  const statusRow = nodeEl.createDiv({ cls: "ss-studio-node-run-status-row" });
  statusRow.createDiv({
    cls: `ss-studio-node-run-status is-${nodeRunState.status}`,
    text: statusLabelForNode(nodeRunState.status),
  });
  const statusMessage = nodeRunState.message.trim();
  if (statusMessage) {
    statusRow.createDiv({
      cls: "ss-studio-node-run-message",
      text: statusMessage,
    });
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
      pin.disabled = busy;
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
      pin.disabled = busy;
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

  const configPreviewEl = nodeEl.createEl("p", {
    cls: "ss-studio-node-config-preview",
    text: formatNodeConfigPreview(node),
  });
  configPreviewEl.setAttribute("data-node-config-preview", node.id);

  const outputPreview =
    node.kind === "studio.image_generation" ? "" : formatNodeOutputPreview(nodeRunState.outputs);
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

  const mediaPreview = resolveNodeMediaPreview(
    node,
    nodeRunState.outputs as Record<string, unknown> | null
  );
  if (mediaPreview && resolveAssetPreviewSrc) {
    const previewSrc = resolveAssetPreviewSrc(mediaPreview.path);
    if (previewSrc) {
      const previewEl = nodeEl.createDiv({ cls: "ss-studio-node-media-preview" });
      previewEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
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
