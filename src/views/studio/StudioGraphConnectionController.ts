import { Notice } from "obsidian";
import type { StudioProjectV1 } from "../../studio/types";
import { randomId } from "../../studio/utils";
import type {
  ConnectionDragState,
  PendingConnection,
  StudioGraphInteractionHost,
} from "./StudioGraphInteractionTypes";

const SVG_NS = "http://www.w3.org/2000/svg";

type StudioGraphConnectionHost = StudioGraphInteractionHost & {
  getGraphZoom: () => number;
};

export class StudioGraphConnectionController {
  private pendingConnection: PendingConnection | null = null;
  private connectionDrag: ConnectionDragState | null = null;
  private graphCanvasEl: HTMLElement | null = null;
  private graphEdgesLayerEl: SVGSVGElement | null = null;
  private portElsByKey = new Map<string, HTMLElement>();
  private suppressOutputPortClickKey: string | null = null;

  constructor(private readonly host: StudioGraphConnectionHost) {}

  getPendingConnection(): PendingConnection | null {
    return this.pendingConnection;
  }

  isPendingConnectionSource(nodeId: string, portId: string): boolean {
    return (
      this.pendingConnection?.fromNodeId === nodeId &&
      this.pendingConnection?.fromPortId === portId
    );
  }

  clearProjectState(): void {
    this.pendingConnection = null;
    this.connectionDrag = null;
  }

  clearRenderBindings(): void {
    this.graphCanvasEl = null;
    this.graphEdgesLayerEl = null;
    this.connectionDrag = null;
    this.suppressOutputPortClickKey = null;
    this.portElsByKey.clear();
  }

  onNodeRemoved(nodeId: string): void {
    if (this.pendingConnection?.fromNodeId === nodeId) {
      this.pendingConnection = null;
    }
    if (this.connectionDrag?.fromNodeId === nodeId) {
      this.connectionDrag = null;
    }
  }

  registerCanvasElement(canvas: HTMLElement): void {
    this.graphCanvasEl = canvas;
  }

  registerEdgesLayerElement(layer: SVGSVGElement): void {
    this.graphEdgesLayerEl = layer;
  }

  clearPortElements(): void {
    this.portElsByKey.clear();
  }

  registerPortElement(nodeId: string, direction: "in" | "out", portId: string, element: HTMLElement): void {
    this.portElsByKey.set(this.portElementKey(nodeId, direction, portId), element);
  }

  clearPendingConnection(options?: { requestRender?: boolean }): void {
    const hadPending = this.pendingConnection !== null;
    this.pendingConnection = null;
    this.connectionDrag = null;
    this.refreshOutputPinActiveState();
    this.renderEdgeLayer();
    if (hadPending && options?.requestRender) {
      this.host.requestRender();
    }
  }

  beginConnection(fromNodeId: string, fromPortId: string): void {
    const sameAsPending =
      this.pendingConnection?.fromNodeId === fromNodeId &&
      this.pendingConnection?.fromPortId === fromPortId;
    this.pendingConnection = sameAsPending
      ? null
      : {
          fromNodeId,
          fromPortId,
        };
    this.connectionDrag = null;
    this.host.requestRender();
  }

  private resolveInputPortAtClientPoint(clientX: number, clientY: number): {
    toNodeId: string;
    toPortId: string;
  } | null {
    const rawTarget = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!rawTarget) {
      return null;
    }

    const pin = rawTarget.closest(".ss-studio-port-pin.is-input") as HTMLElement | null;
    if (!pin) {
      return null;
    }

    const toNodeId = String(pin.dataset.nodeId || "").trim();
    const toPortId = String(pin.dataset.portId || "").trim();
    if (!toNodeId || !toPortId) {
      return null;
    }
    return { toNodeId, toPortId };
  }

  completeConnection(toNodeId: string, toPortId: string): void {
    const project = this.host.getCurrentProject();
    if (!this.pendingConnection || !project) {
      return;
    }

    this.connectionDrag = null;
    const pending = this.pendingConnection;
    const sourceType = this.host.getPortType(pending.fromNodeId, "out", pending.fromPortId);
    const targetType = this.host.getPortType(toNodeId, "in", toPortId);

    if (!sourceType || !targetType) {
      this.pendingConnection = null;
      this.host.setError("Invalid port selection.");
      return;
    }

    if (!this.host.portTypeCompatible(sourceType, targetType)) {
      this.pendingConnection = null;
      this.host.setError(
        `Cannot connect ${pending.fromPortId} (${sourceType}) to ${toPortId} (${targetType}).`
      );
      return;
    }

    const duplicate = project.graph.edges.some(
      (edge) =>
        edge.fromNodeId === pending.fromNodeId &&
        edge.fromPortId === pending.fromPortId &&
        edge.toNodeId === toNodeId &&
        edge.toPortId === toPortId
    );
    if (duplicate) {
      this.pendingConnection = null;
      new Notice("That connection already exists.");
      this.host.requestRender();
      return;
    }

    project.graph.edges.push({
      id: randomId("edge"),
      fromNodeId: pending.fromNodeId,
      fromPortId: pending.fromPortId,
      toNodeId,
      toPortId,
    });

    this.pendingConnection = null;
    this.host.recomputeEntryNodes(project);
    this.host.scheduleProjectSave();
    this.host.requestRender();
  }

  startConnectionDrag(
    fromNodeId: string,
    fromPortId: string,
    startEvent: PointerEvent,
    sourcePinEl: HTMLElement
  ): void {
    if (this.host.isBusy() || startEvent.button !== 0) {
      return;
    }

    startEvent.preventDefault();
    const pointerId = startEvent.pointerId;
    const sourceKey = this.portElementKey(fromNodeId, "out", fromPortId);
    this.connectionDrag = {
      pointerId,
      fromNodeId,
      fromPortId,
      startClientX: startEvent.clientX,
      startClientY: startEvent.clientY,
      lastClientX: startEvent.clientX,
      lastClientY: startEvent.clientY,
      active: false,
    };

    if (typeof sourcePinEl.setPointerCapture === "function") {
      try {
        sourcePinEl.setPointerCapture(pointerId);
      } catch {
        // Ignore capture failures; window listeners are the fallback.
      }
    }

    const activateDrag = (): void => {
      if (!this.connectionDrag || this.connectionDrag.active) {
        return;
      }
      this.connectionDrag.active = true;
      this.pendingConnection = {
        fromNodeId,
        fromPortId,
      };
      this.refreshOutputPinActiveState();
      this.renderEdgeLayer();
    };

    const finishDrag = (event: PointerEvent): void => {
      if (!this.connectionDrag || event.pointerId !== pointerId) {
        return;
      }

      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      if (typeof sourcePinEl.releasePointerCapture === "function") {
        try {
          sourcePinEl.releasePointerCapture(pointerId);
        } catch {
          // Ignore release failures.
        }
      }

      const dragState = this.connectionDrag;
      this.connectionDrag = null;

      if (!dragState.active) {
        return;
      }

      this.suppressOutputPortClickKey = sourceKey;
      const resolvedTarget = this.resolveInputPortAtClientPoint(event.clientX, event.clientY);
      if (resolvedTarget) {
        this.completeConnection(resolvedTarget.toNodeId, resolvedTarget.toPortId);
        return;
      }

      this.pendingConnection = null;
      this.refreshOutputPinActiveState();
      this.renderEdgeLayer();
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (!this.connectionDrag || moveEvent.pointerId !== pointerId) {
        return;
      }

      this.connectionDrag.lastClientX = moveEvent.clientX;
      this.connectionDrag.lastClientY = moveEvent.clientY;
      const movedDistance = Math.hypot(
        moveEvent.clientX - this.connectionDrag.startClientX,
        moveEvent.clientY - this.connectionDrag.startClientY
      );
      if (!this.connectionDrag.active && movedDistance > 3) {
        activateDrag();
      }

      if (this.connectionDrag.active) {
        this.renderEdgeLayer();
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  }

  consumeSuppressedOutputPortClick(nodeId: string, portId: string): boolean {
    const key = this.portElementKey(nodeId, "out", portId);
    if (this.suppressOutputPortClickKey !== key) {
      return false;
    }
    this.suppressOutputPortClickKey = null;
    return true;
  }

  renderEdgeLayer(): void {
    const project = this.host.getCurrentProject();
    if (!project || !this.graphEdgesLayerEl || !this.graphCanvasEl) {
      return;
    }

    this.graphEdgesLayerEl.textContent = "";

    for (const edge of project.graph.edges) {
      const fromPort = this.portElsByKey.get(this.portElementKey(edge.fromNodeId, "out", edge.fromPortId));
      const toPort = this.portElsByKey.get(this.portElementKey(edge.toNodeId, "in", edge.toPortId));
      if (!fromPort || !toPort) {
        continue;
      }

      const canvasRect = this.graphCanvasEl.getBoundingClientRect();
      const fromRect = fromPort.getBoundingClientRect();
      const toRect = toPort.getBoundingClientRect();
      const zoom = this.host.getGraphZoom() || 1;
      const startX = (fromRect.left - canvasRect.left + fromRect.width / 2) / zoom;
      const startY = (fromRect.top - canvasRect.top + fromRect.height / 2) / zoom;
      const endX = (toRect.left - canvasRect.left + toRect.width / 2) / zoom;
      const endY = (toRect.top - canvasRect.top + toRect.height / 2) / zoom;
      const controlX = Math.max(startX + 70, (startX + endX) / 2);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute(
        "d",
        `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`
      );
      path.setAttribute("class", "ss-studio-edge-path");
      path.addEventListener("click", (event) => {
        event.stopPropagation();
        this.removeEdge(edge.id);
      });
      this.graphEdgesLayerEl.appendChild(path);
    }

    if (this.connectionDrag?.active && this.pendingConnection) {
      const drag = this.connectionDrag;
      const sourcePin = this.portElsByKey.get(
        this.portElementKey(this.pendingConnection.fromNodeId, "out", this.pendingConnection.fromPortId)
      );
      if (sourcePin) {
        const canvasRect = this.graphCanvasEl.getBoundingClientRect();
        const sourceRect = sourcePin.getBoundingClientRect();
        const zoom = this.host.getGraphZoom() || 1;
        const startX = (sourceRect.left - canvasRect.left + sourceRect.width / 2) / zoom;
        const startY = (sourceRect.top - canvasRect.top + sourceRect.height / 2) / zoom;
        const endX = (drag.lastClientX - canvasRect.left) / zoom;
        const endY = (drag.lastClientY - canvasRect.top) / zoom;
        const controlX = Math.max(startX + 70, (startX + endX) / 2);

        const previewPath = document.createElementNS(SVG_NS, "path");
        previewPath.setAttribute(
          "d",
          `M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`
        );
        previewPath.setAttribute("class", "ss-studio-edge-preview");
        this.graphEdgesLayerEl.appendChild(previewPath);
      }
    }
  }

  private refreshOutputPinActiveState(): void {
    const pending = this.pendingConnection;
    for (const [key, element] of this.portElsByKey.entries()) {
      if (!key.includes(":out:")) {
        continue;
      }
      const active =
        pending !== null &&
        key === this.portElementKey(pending.fromNodeId, "out", pending.fromPortId);
      element.classList.toggle("is-active", active);
    }
  }

  private portElementKey(nodeId: string, direction: "in" | "out", portId: string): string {
    return `${nodeId}:${direction}:${portId}`;
  }

  private removeEdge(edgeId: string): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }

    project.graph.edges = project.graph.edges.filter((edge) => edge.id !== edgeId);
    this.host.recomputeEntryNodes(project);
    this.host.scheduleProjectSave();
    this.host.requestRender();
  }
}
