import { Notice } from "obsidian";
import type { StudioProjectV1 } from "../../../studio/types";
import { randomId } from "../../../studio/utils";
import type {
  ConnectionDragState,
  PendingConnection,
  StudioGraphInteractionHost,
} from "../StudioGraphInteractionTypes";
import { StudioSimpleContextMenuOverlay } from "../StudioSimpleContextMenuOverlay";
import { buildCubicLinkCurve, type CubicLinkCurve } from "./LinkGeometry";

const SVG_NS = "http://www.w3.org/2000/svg";

type StudioGraphConnectionEngineHost = StudioGraphInteractionHost & {
  getGraphZoom: () => number;
};

type ConnectionPortDirection = "in" | "out";

type PortAnchor = {
  nodeId: string;
  portId: string;
  direction: ConnectionPortDirection;
};

type LinkEdge = {
  id: string;
  source: PortAnchor;
  target: PortAnchor;
};

export class StudioGraphConnectionEngineV2 {
  private pendingConnection: PendingConnection | null = null;
  private dragState: ConnectionDragState | null = null;
  private graphCanvasEl: HTMLElement | null = null;
  private graphEdgesLayerEl: SVGSVGElement | null = null;
  private portElementsByKey = new Map<string, HTMLElement>();
  private suppressOutputClickKey: string | null = null;
  private readonly edgeContextMenu = new StudioSimpleContextMenuOverlay();

  constructor(private readonly host: StudioGraphConnectionEngineHost) {}

  getPendingConnection(): PendingConnection | null {
    return this.pendingConnection;
  }

  isPendingConnectionSource(nodeId: string, portId: string): boolean {
    return this.pendingConnection?.fromNodeId === nodeId && this.pendingConnection?.fromPortId === portId;
  }

  clearProjectState(): void {
    this.pendingConnection = null;
    this.dragState = null;
    this.closeEdgeContextMenu();
  }

  clearRenderBindings(): void {
    this.graphCanvasEl = null;
    this.graphEdgesLayerEl = null;
    this.dragState = null;
    this.suppressOutputClickKey = null;
    this.closeEdgeContextMenu();
    this.edgeContextMenu.destroy();
    this.resetPortVisualState();
    this.portElementsByKey.clear();
  }

  onNodeRemoved(nodeId: string): void {
    if (this.pendingConnection?.fromNodeId === nodeId) {
      this.pendingConnection = null;
    }
    if (this.dragState?.fromNodeId === nodeId) {
      this.dragState = null;
    }
  }

  registerCanvasElement(canvas: HTMLElement): void {
    this.graphCanvasEl = canvas;
  }

  registerEdgesLayerElement(layer: SVGSVGElement): void {
    this.graphEdgesLayerEl = layer;
  }

  clearPortElements(): void {
    this.resetPortVisualState();
    this.portElementsByKey.clear();
  }

  registerPortElement(
    nodeId: string,
    direction: ConnectionPortDirection,
    portId: string,
    element: HTMLElement
  ): void {
    this.portElementsByKey.set(this.portKey(nodeId, direction, portId), element);
  }

  clearPendingConnection(options?: { requestRender?: boolean }): void {
    const hadPending = this.pendingConnection !== null;
    this.pendingConnection = null;
    this.dragState = null;
    this.refreshActiveOutputState();
    this.renderEdgeLayer();
    if (hadPending && options?.requestRender) {
      this.host.requestRender();
    }
  }

  beginConnection(fromNodeId: string, fromPortId: string): void {
    const isSameSource =
      this.pendingConnection?.fromNodeId === fromNodeId &&
      this.pendingConnection?.fromPortId === fromPortId;
    this.pendingConnection = isSameSource
      ? null
      : {
          fromNodeId,
          fromPortId,
        };
    this.dragState = null;
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
    const sourceKey = this.portKey(fromNodeId, "out", fromPortId);
    this.dragState = {
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
        // Pointer capture may fail in some environments.
      }
    }

    const activateDrag = (): void => {
      if (!this.dragState || this.dragState.active) {
        return;
      }
      this.dragState.active = true;
      this.pendingConnection = {
        fromNodeId,
        fromPortId,
      };
      this.refreshActiveOutputState();
      this.renderEdgeLayer();
    };

    const onPointerMove = (moveEvent: PointerEvent): void => {
      if (!this.dragState || moveEvent.pointerId !== pointerId) {
        return;
      }

      this.dragState.lastClientX = moveEvent.clientX;
      this.dragState.lastClientY = moveEvent.clientY;

      const movedDistance = Math.hypot(
        moveEvent.clientX - this.dragState.startClientX,
        moveEvent.clientY - this.dragState.startClientY
      );
      if (!this.dragState.active && movedDistance > 3) {
        activateDrag();
      }

      if (this.dragState.active) {
        this.renderEdgeLayer();
      }
    };

    const finishDrag = (endEvent: PointerEvent): void => {
      if (!this.dragState || endEvent.pointerId !== pointerId) {
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

      const finishedDrag = this.dragState;
      this.dragState = null;

      if (!finishedDrag.active) {
        return;
      }

      this.suppressOutputClickKey = sourceKey;
      const target = this.resolveInputPortAtClientPoint(endEvent.clientX, endEvent.clientY);
      if (target) {
        this.completeConnection(target.nodeId, target.portId);
        return;
      }

      this.pendingConnection = null;
      this.refreshActiveOutputState();
      this.renderEdgeLayer();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  }

  consumeSuppressedOutputPortClick(nodeId: string, portId: string): boolean {
    const key = this.portKey(nodeId, "out", portId);
    if (this.suppressOutputClickKey !== key) {
      return false;
    }
    this.suppressOutputClickKey = null;
    return true;
  }

  completeConnection(targetNodeId: string, targetPortId: string): void {
    const project = this.host.getCurrentProject();
    if (!this.pendingConnection || !project) {
      return;
    }

    this.dragState = null;
    const source = this.pendingConnection;
    const sourceType = this.host.getPortType(source.fromNodeId, "out", source.fromPortId);
    const targetType = this.host.getPortType(targetNodeId, "in", targetPortId);

    if (!sourceType || !targetType) {
      this.pendingConnection = null;
      this.host.setError("Invalid port selection.");
      return;
    }

    if (!this.host.portTypeCompatible(sourceType, targetType)) {
      this.pendingConnection = null;
      this.host.setError(
        `Cannot connect ${source.fromPortId} (${sourceType}) to ${targetPortId} (${targetType}).`
      );
      return;
    }

    const duplicate = project.graph.edges.some(
      (edge) =>
        edge.fromNodeId === source.fromNodeId &&
        edge.fromPortId === source.fromPortId &&
        edge.toNodeId === targetNodeId &&
        edge.toPortId === targetPortId
    );
    if (duplicate) {
      this.pendingConnection = null;
      new Notice("That connection already exists.");
      this.host.requestRender();
      return;
    }

    project.graph.edges.push({
      id: randomId("edge"),
      fromNodeId: source.fromNodeId,
      fromPortId: source.fromPortId,
      toNodeId: targetNodeId,
      toPortId: targetPortId,
    });

    this.pendingConnection = null;
    this.host.recomputeEntryNodes(project);
    this.host.scheduleProjectSave();
    this.host.requestRender();
  }

  renderEdgeLayer(): void {
    const project = this.host.getCurrentProject();
    if (!project || !this.graphEdgesLayerEl || !this.graphCanvasEl) {
      this.closeEdgeContextMenu();
      this.resetPortVisualState();
      return;
    }

    this.graphEdgesLayerEl.textContent = "";

    const connectedInputKeys = new Set<string>();
    const connectedOutputKeys = new Set<string>();

    for (const edge of this.toLinkEdges(project)) {
      const sourceKey = this.portKey(edge.source.nodeId, edge.source.direction, edge.source.portId);
      const targetKey = this.portKey(edge.target.nodeId, edge.target.direction, edge.target.portId);
      const sourcePort = this.portElementsByKey.get(sourceKey);
      const targetPort = this.portElementsByKey.get(targetKey);
      if (!sourcePort || !targetPort) {
        continue;
      }

      connectedOutputKeys.add(sourceKey);
      connectedInputKeys.add(targetKey);

      const curve = this.computeCurve(sourcePort, targetPort);
      if (!curve) {
        continue;
      }

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", curve.path);
      path.setAttribute("class", "ss-studio-link-path");
      const onEdgeMenuRequested = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        this.openEdgeContextMenu(edge.id, event.clientX, event.clientY);
      };
      path.addEventListener("click", (event) => {
        onEdgeMenuRequested(event);
      });
      path.addEventListener("contextmenu", (event) => {
        onEdgeMenuRequested(event);
      });
      this.graphEdgesLayerEl.appendChild(path);
    }

    if (this.dragState?.active && this.pendingConnection) {
      const sourceKey = this.portKey(this.pendingConnection.fromNodeId, "out", this.pendingConnection.fromPortId);
      const sourcePort = this.portElementsByKey.get(sourceKey);
      const cursorAnchor = this.cursorAnchorPoint();
      if (sourcePort && cursorAnchor) {
        const sourceAnchor = this.portAnchorPoint(sourcePort, "out");
        if (sourceAnchor) {
          const curve = buildCubicLinkCurve(sourceAnchor, cursorAnchor);
          const preview = document.createElementNS(SVG_NS, "path");
          preview.setAttribute("d", curve.path);
          preview.setAttribute("class", "ss-studio-link-preview");
          this.graphEdgesLayerEl.appendChild(preview);
        }
      }
    }

    this.applyConnectedPortVisuals(connectedInputKeys, connectedOutputKeys);
  }

  private toLinkEdges(project: StudioProjectV1): LinkEdge[] {
    return project.graph.edges.map((edge) => ({
      id: edge.id,
      source: {
        nodeId: edge.fromNodeId,
        portId: edge.fromPortId,
        direction: "out",
      },
      target: {
        nodeId: edge.toNodeId,
        portId: edge.toPortId,
        direction: "in",
      },
    }));
  }

  private computeCurve(sourcePort: HTMLElement, targetPort: HTMLElement): CubicLinkCurve | null {
    const source = this.portAnchorPoint(sourcePort, "out");
    const target = this.portAnchorPoint(targetPort, "in");
    if (!source || !target) {
      return null;
    }
    return buildCubicLinkCurve(source, target);
  }

  private portAnchorPoint(
    portElement: HTMLElement,
    direction: ConnectionPortDirection
  ): { x: number; y: number } | null {
    if (!this.graphCanvasEl) {
      return null;
    }

    const canvasRect = this.graphCanvasEl.getBoundingClientRect();
    const portRect = portElement.getBoundingClientRect();
    const zoom = this.host.getGraphZoom() || 1;
    const x = direction === "out"
      ? (portRect.left - canvasRect.left + portRect.width) / zoom
      : (portRect.left - canvasRect.left) / zoom;
    const y = (portRect.top - canvasRect.top + portRect.height / 2) / zoom;
    return { x, y };
  }

  private cursorAnchorPoint(): { x: number; y: number } | null {
    if (!this.graphCanvasEl || !this.dragState) {
      return null;
    }
    const canvasRect = this.graphCanvasEl.getBoundingClientRect();
    const zoom = this.host.getGraphZoom() || 1;
    return {
      x: (this.dragState.lastClientX - canvasRect.left) / zoom,
      y: (this.dragState.lastClientY - canvasRect.top) / zoom,
    };
  }

  private applyConnectedPortVisuals(connectedInputKeys: Set<string>, connectedOutputKeys: Set<string>): void {
    for (const [key, element] of this.portElementsByKey.entries()) {
      const inputLinked = connectedInputKeys.has(key);
      const outputLinked = connectedOutputKeys.has(key);
      const linked = inputLinked || outputLinked;

      element.classList.toggle("is-linked", linked);
    }
  }

  private refreshActiveOutputState(): void {
    const pending = this.pendingConnection;
    for (const [key, element] of this.portElementsByKey.entries()) {
      if (!key.includes(":out:")) {
        continue;
      }
      const active =
        pending !== null &&
        key === this.portKey(pending.fromNodeId, "out", pending.fromPortId);
      element.classList.toggle("is-active", active);
    }
  }

  private resetPortVisualState(): void {
    for (const element of this.portElementsByKey.values()) {
      element.classList.remove("is-linked", "is-linked-input", "is-linked-output", "is-active");
    }
  }

  private portKey(nodeId: string, direction: ConnectionPortDirection, portId: string): string {
    return `${nodeId}:${direction}:${portId}`;
  }

  private resolveInputPortAtClientPoint(clientX: number, clientY: number): { nodeId: string; portId: string } | null {
    const rawTarget = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!rawTarget) {
      return null;
    }

    const pin = rawTarget.closest(".ss-studio-port-pin.is-input") as HTMLElement | null;
    if (!pin) {
      return null;
    }

    const nodeId = String(pin.dataset.nodeId || "").trim();
    const portId = String(pin.dataset.portId || "").trim();
    if (!nodeId || !portId) {
      return null;
    }

    return { nodeId, portId };
  }

  private removeEdge(edgeId: string): void {
    const project = this.host.getCurrentProject();
    if (!project) {
      return;
    }

    this.closeEdgeContextMenu();
    project.graph.edges = project.graph.edges.filter((edge) => edge.id !== edgeId);
    this.host.recomputeEntryNodes(project);
    this.host.scheduleProjectSave();
    this.host.requestRender();
  }

  private openEdgeContextMenu(edgeId: string, clientX: number, clientY: number): void {
    const canvas = this.graphCanvasEl;
    if (!canvas) {
      return;
    }
    const viewport = canvas.parentElement as HTMLElement | null;
    if (!viewport) {
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();
    const anchorX = Math.round(viewport.scrollLeft + (clientX - viewportRect.left));
    const anchorY = Math.round(viewport.scrollTop + (clientY - viewportRect.top));
    this.edgeContextMenu.mount(viewport);
    this.edgeContextMenu.setGraphZoom(this.host.getGraphZoom());
    this.edgeContextMenu.open({
      anchorX,
      anchorY,
      width: 210,
      items: [
        {
          id: "remove-connection",
          title: "Remove connection",
          onSelect: () => {
            this.removeEdge(edgeId);
          },
        },
      ],
    });
  }

  private closeEdgeContextMenu(): void {
    this.edgeContextMenu.hide();
  }
}
