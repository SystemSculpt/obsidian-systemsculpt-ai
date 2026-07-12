import { Notice } from "obsidian";
import type { StudioNodeInstance, StudioProjectV1, StudioRunEvent } from "../../../studio/types";
import { randomId } from "../../../studio/utils";
import {
  resolveStudioPortAnchorWorldPoint,
  type StudioPortLocalOffset,
} from "./StudioPortAnchorGeometry";
import type {
  ConnectionAutoCreateRequest,
  PendingConnection,
  StudioGraphInteractionHost,
} from "../StudioGraphInteractionTypes";
import { StudioSimpleContextMenuOverlay } from "../StudioSimpleContextMenuOverlay";
import { StudioLinkStore, type PortAnchor } from "./StudioLinkStore";
import { StudioLinkFlowBridge } from "./StudioLinkFlowBridge";
import { StudioEdgeRenderer } from "./StudioEdgeRenderer";
import { StudioLinkAnimator } from "./StudioLinkAnimator";
import { StudioPortInteraction } from "./StudioPortInteraction";

type PortDirection = "in" | "out";

type Host = StudioGraphInteractionHost & {
  getGraphZoom: () => number;
};

export class StudioGraphConnectionEngineV3 {
  private readonly store = new StudioLinkStore();
  private readonly flowBridge = new StudioLinkFlowBridge(this.store);
  private readonly edgeContextMenu = new StudioSimpleContextMenuOverlay();
  private readonly portInteraction: StudioPortInteraction;
  private renderer: StudioEdgeRenderer | null = null;
  private animator: StudioLinkAnimator | null = null;
  private graphCanvasEl: HTMLElement | null = null;
  private graphEdgesLayerEl: SVGSVGElement | null = null;
  private autoCreateHintEl: HTMLElement | null = null;
  private boundEdgeLayer: SVGSVGElement | null = null;
  private edgeLayerHandler: ((event: MouseEvent) => void) | null = null;
  private storeUnsub: (() => void) | null = null;
  private edgeLayerResizeObserver: ResizeObserver | null = null;
  // Last good per-port pin offset (card-local world px), keyed
  // `nodeId:direction:portId`. Persists across renders so a render while the
  // leaf is hidden/unlaid-out still resolves precise anchors from the last
  // measurement instead of dropping the edge.
  private readonly portOffsetCache = new Map<string, StudioPortLocalOffset>();

  constructor(private readonly host: Host) {
    this.portInteraction = new StudioPortInteraction(host, this.store, {
      onConnectionCommit: (target) => this.commitConnectionFromSnap(target),
      onAutoCreateHint: (visible, label, clientX, clientY) =>
        this.handleAutoCreateHint(visible, label, clientX, clientY),
      onAutoCreateRelease: (request) => this.requestAutoCreateNode(request),
      onDragStateChange: () => this.renderer?.render(),
    });
  }

  getPendingConnection(): PendingConnection | null {
    const sourceKey = this.portInteraction.getPendingConnectionSourceKey();
    if (!sourceKey) return null;
    const [fromNodeId, , fromPortId] = sourceKey.split(":");
    return { fromNodeId, fromPortId };
  }

  isPendingConnectionSource(nodeId: string, portId: string): boolean {
    return this.portInteraction.isPendingConnectionSource(nodeId, portId);
  }

  clearProjectState(): void {
    this.portInteraction.cancel();
    this.flowBridge.resetAll();
    this.store.clear();
    this.portOffsetCache.clear();
    this.closeEdgeContextMenu();
  }

  clearRenderBindings(): void {
    this.disconnectEdgeLayerResizeObserver();
    this.graphCanvasEl = null;
    this.graphEdgesLayerEl = null;
    this.portInteraction.clearRenderBindings();
    this.detachAnimator();
    this.renderer?.clear();
    this.renderer = null;
    this.unbindEdgeLayerListeners();
    if (this.autoCreateHintEl) {
      this.autoCreateHintEl.remove();
      this.autoCreateHintEl = null;
    }
    this.closeEdgeContextMenu();
    this.edgeContextMenu.destroy();
  }

  onNodeRemoved(nodeId: string): void {
    this.store.removeEdgesForNode(nodeId);
    const prefix = `${nodeId}:`;
    for (const key of this.portOffsetCache.keys()) {
      if (key.startsWith(prefix)) {
        this.portOffsetCache.delete(key);
      }
    }
    const pending = this.portInteraction.getPendingConnectionSourceKey();
    if (pending && pending.startsWith(`${nodeId}:out:`)) {
      this.portInteraction.cancel();
    }
  }

  registerCanvasElement(canvas: HTMLElement): void {
    this.graphCanvasEl = canvas;
    this.portInteraction.registerCanvas(canvas);
  }

  registerEdgesLayerElement(layer: SVGSVGElement): void {
    this.graphEdgesLayerEl = layer;
    this.detachAnimator();
    this.renderer = new StudioEdgeRenderer({
      store: this.store,
      layer,
      resolvePortAnchorPoint: (anchor, direction) => this.resolvePortAnchorPoint(anchor, direction),
      getCursorAnchorPoint: () => this.cursorAnchorPoint(),
    });
    this.storeUnsub?.();
    this.storeUnsub = this.store.subscribe(() => this.renderer?.render());
    this.animator = new StudioLinkAnimator({
      store: this.store,
      getEdgeGroupElement: (edgeId) => this.renderer?.getEdgeGroupElement(edgeId) ?? null,
    });
    this.animator.attach();
    this.bindEdgeLayerListeners(layer);
    this.observeCanvasForEdgeReresolve();
  }

  // The edge layer resolves port anchors via getBoundingClientRect at render
  // time. When the Studio leaf renders while hidden/unlaid-out (plugin reload,
  // tab restore), those rects are zero, so resolvePortAnchorPoint bails and no
  // lines are drawn even though the ports (dots) show as connected. Re-render
  // once the canvas gains a real box so anchors resolve against actual geometry.
  private observeCanvasForEdgeReresolve(): void {
    this.disconnectEdgeLayerResizeObserver();
    const canvas = this.graphCanvasEl;
    if (!canvas || typeof ResizeObserver === "undefined") {
      return;
    }
    this.edgeLayerResizeObserver = new ResizeObserver(() => {
      this.renderer?.render();
    });
    this.edgeLayerResizeObserver.observe(canvas);
  }

  private disconnectEdgeLayerResizeObserver(): void {
    if (this.edgeLayerResizeObserver) {
      this.edgeLayerResizeObserver.disconnect();
      this.edgeLayerResizeObserver = null;
    }
  }

  clearPortElements(): void {
    this.portInteraction.clearPortElements();
  }

  registerPortElement(
    nodeId: string,
    direction: PortDirection,
    portId: string,
    element: HTMLElement
  ): void {
    this.portInteraction.registerPortElement(nodeId, direction, portId, element);
  }

  clearPendingConnection(options?: { requestRender?: boolean }): void {
    this.portInteraction.cancel();
    if (options?.requestRender) {
      this.host.requestRender();
    }
  }

  beginConnection(fromNodeId: string, fromPortId: string): void {
    this.portInteraction.arm(fromNodeId, fromPortId);
  }

  completeConnection(targetNodeId: string, targetPortId: string): void {
    this.commitConnectionFromSnap({ nodeId: targetNodeId, portId: targetPortId });
  }

  startConnectionDrag(
    fromNodeId: string,
    fromPortId: string,
    startEvent: PointerEvent,
    sourcePinEl: HTMLElement
  ): void {
    this.portInteraction.startDrag(fromNodeId, fromPortId, startEvent, sourcePinEl);
  }

  consumeSuppressedOutputPortClick(nodeId: string, portId: string): boolean {
    return this.portInteraction.consumeSuppressedOutputClick(nodeId, portId);
  }

  renderEdgeLayer(): void {
    const project = this.host.getCurrentProject();
    if (!project || !this.graphEdgesLayerEl || !this.graphCanvasEl) {
      this.store.clear();
      this.renderer?.render();
      return;
    }
    this.store.setEdges(
      project.graph.edges.map((edge) => ({
        id: edge.id,
        source: { nodeId: edge.fromNodeId, portId: edge.fromPortId },
        target: { nodeId: edge.toNodeId, portId: edge.toPortId },
      }))
    );
    this.applyConnectedPortVisuals(project);
    this.portInteraction.applyActiveOutputClass();
    this.portInteraction.reapplyPendingHighlights();
    this.renderer?.render();
  }

  applyRunEvent(event: StudioRunEvent): void {
    this.flowBridge.applyRunEvent(event);
  }

  private commitConnectionFromSnap(target: PortAnchor): void {
    const project = this.host.getCurrentProject();
    const pending = this.portInteraction.getPendingConnectionSourceKey();
    if (!project || !pending) return;
    const [fromNodeId, , fromPortId] = pending.split(":");

    const sourceType = this.host.getPortType(fromNodeId, "out", fromPortId);
    const targetType = this.host.getPortType(target.nodeId, "in", target.portId);
    if (!sourceType || !targetType) {
      this.portInteraction.cancel();
      this.host.setError("Invalid port selection.");
      return;
    }
    if (!this.host.portTypeCompatible(sourceType, targetType)) {
      this.portInteraction.cancel();
      this.host.setError(
        `Cannot connect ${fromPortId} (${sourceType}) to ${target.portId} (${targetType}).`
      );
      return;
    }

    const duplicate = project.graph.edges.some(
      (edge) =>
        edge.fromNodeId === fromNodeId &&
        edge.fromPortId === fromPortId &&
        edge.toNodeId === target.nodeId &&
        edge.toPortId === target.portId
    );
    if (duplicate) {
      this.portInteraction.cancel();
      new Notice("That connection already exists.");
      this.host.requestRender();
      return;
    }

    const changed = this.host.commitProjectMutation("graph.connection", (currentProject) => {
      currentProject.graph.edges.push({
        id: randomId("edge"),
        fromNodeId,
        fromPortId,
        toNodeId: target.nodeId,
        toPortId: target.portId,
      });
      return true;
    });
    if (!changed) return;

    this.portInteraction.cancel();
    const currentProject = this.host.getCurrentProject();
    if (currentProject) {
      this.host.recomputeEntryNodes(currentProject);
    }
    this.host.requestRender();
  }

  private requestAutoCreateNode(request: ConnectionAutoCreateRequest): boolean {
    if (!this.host.onConnectionAutoCreateRequested) return false;
    try {
      return this.host.onConnectionAutoCreateRequested(request) === true;
    } catch {
      return false;
    }
  }

  private bindEdgeLayerListeners(layer: SVGSVGElement): void {
    if (this.boundEdgeLayer === layer) return;
    this.unbindEdgeLayerListeners();
    const handle = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const path = target?.closest("path[data-edge-id]") as SVGPathElement | null;
      if (!path) return;
      const edgeId = path.dataset.edgeId;
      if (!edgeId) return;
      event.preventDefault();
      event.stopPropagation();
      this.openEdgeContextMenu(edgeId, event.clientX, event.clientY);
    };
    layer.addEventListener("click", handle);
    layer.addEventListener("contextmenu", handle);
    this.boundEdgeLayer = layer;
    this.edgeLayerHandler = handle;
  }

  private unbindEdgeLayerListeners(): void {
    if (this.boundEdgeLayer && this.edgeLayerHandler) {
      this.boundEdgeLayer.removeEventListener("click", this.edgeLayerHandler);
      this.boundEdgeLayer.removeEventListener("contextmenu", this.edgeLayerHandler);
    }
    this.boundEdgeLayer = null;
    this.edgeLayerHandler = null;
  }

  private openEdgeContextMenu(edgeId: string, clientX: number, clientY: number): void {
    const canvas = this.graphCanvasEl;
    if (!canvas) return;
    const viewport = canvas.parentElement as HTMLElement | null;
    if (!viewport) return;
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
          onSelect: () => this.removeEdge(edgeId),
        },
      ],
    });
  }

  private closeEdgeContextMenu(): void {
    this.edgeContextMenu.hide();
  }

  private removeEdge(edgeId: string): void {
    this.closeEdgeContextMenu();
    const changed = this.host.commitProjectMutation("graph.connection", (project) => {
      const next = project.graph.edges.filter((edge) => edge.id !== edgeId);
      if (next.length === project.graph.edges.length) return false;
      project.graph.edges = next;
      return true;
    });
    if (!changed) return;
    const currentProject = this.host.getCurrentProject();
    if (currentProject) {
      this.host.recomputeEntryNodes(currentProject);
    }
    this.host.requestRender();
  }

  private handleAutoCreateHint(
    visible: boolean,
    label: string | null,
    clientX: number,
    clientY: number
  ): void {
    if (!this.graphCanvasEl) return;
    const viewport = this.graphCanvasEl.parentElement as HTMLElement | null;
    if (!viewport) return;
    if (!visible) {
      if (this.autoCreateHintEl) {
        this.autoCreateHintEl.remove();
        this.autoCreateHintEl = null;
      }
      return;
    }
    if (!this.autoCreateHintEl) {
      this.autoCreateHintEl = createDiv();
      this.autoCreateHintEl.className = "ss-studio-connection-autocreate-hint";
      viewport.appendChild(this.autoCreateHintEl);
    }
    this.autoCreateHintEl.textContent = `Release to create ${label ?? "node"}`;
    const viewportRect = viewport.getBoundingClientRect();
    const anchorX = viewport.scrollLeft + (clientX - viewportRect.left) + 14;
    const anchorY = viewport.scrollTop + (clientY - viewportRect.top) + 12;
    this.autoCreateHintEl.style.left = `${Math.round(anchorX)}px`;
    this.autoCreateHintEl.style.top = `${Math.round(anchorY)}px`;
  }

  // Resolve a port anchor in canvas WORLD coordinates, primarily from the data
  // model (node.position + width) — the same coordinates the visible cards are
  // positioned with — so edges never depend on whether a pin can be measured at
  // render time. DOM measurement only refines the per-port vertical offset and
  // is cached, so a render while hidden/unlaid-out still draws precise edges.
  private resolvePortAnchorPoint(
    anchor: PortAnchor,
    direction: PortDirection
  ): { x: number; y: number } | null {
    const node = this.findNodeById(anchor.nodeId);
    if (!node) return null;
    const measuredOffset = this.resolvePortLocalOffset(anchor.nodeId, direction, anchor.portId);
    return resolveStudioPortAnchorWorldPoint({ node, direction, measuredOffset });
  }

  private findNodeById(nodeId: string): StudioNodeInstance | null {
    const project = this.host.getCurrentProject();
    if (!project) return null;
    return project.graph.nodes.find((node) => node.id === nodeId) ?? null;
  }

  private resolvePortLocalOffset(
    nodeId: string,
    direction: PortDirection,
    portId: string
  ): StudioPortLocalOffset | null {
    const key = `${nodeId}:${direction}:${portId}`;
    const measured = this.measurePortLocalOffset(nodeId, direction, portId);
    if (measured) {
      this.portOffsetCache.set(key, measured);
      return measured;
    }
    return this.portOffsetCache.get(key) ?? null;
  }

  // Measure a pin's centre offset relative to its own card, in world px. Returns
  // null when the pin/card isn't found or isn't laid out (rect collapsed), so
  // the caller falls back to the cached or constant offset. Reads the pin from
  // the element registry first (robust), then the selector as a fallback.
  private measurePortLocalOffset(
    nodeId: string,
    direction: PortDirection,
    portId: string
  ): StudioPortLocalOffset | null {
    const pin =
      this.portInteraction.getPortElement(nodeId, direction, portId) ??
      this.findPortElement(nodeId, direction, portId);
    if (!pin) return null;
    const card = pin.closest(".ss-studio-node-card") as HTMLElement | null;
    if (!card) return null;
    const cardRect = card.getBoundingClientRect();
    if (cardRect.width === 0 && cardRect.height === 0) return null;
    const pinRect = pin.getBoundingClientRect();
    const zoom = this.host.getGraphZoom() || 1;
    return {
      dx: (pinRect.left + pinRect.width / 2 - cardRect.left) / zoom,
      dy: (pinRect.top + pinRect.height / 2 - cardRect.top) / zoom,
    };
  }

  private findPortElement(
    nodeId: string,
    direction: PortDirection,
    portId: string
  ): HTMLElement | null {
    if (!this.graphCanvasEl) return null;
    const selector = `.ss-studio-port-pin.is-${direction === "in" ? "input" : "output"}[data-node-id="${CSS.escape(nodeId)}"][data-port-id="${CSS.escape(portId)}"]`;
    return this.graphCanvasEl.querySelector(selector) as HTMLElement | null;
  }

  private cursorAnchorPoint(): { x: number; y: number } | null {
    const drag = this.store.getDragState();
    if (!drag) return null;
    return drag.cursorWorld;
  }

  private applyConnectedPortVisuals(project: StudioProjectV1): void {
    if (!this.graphCanvasEl) return;
    const linked = new Set<string>();
    for (const edge of project.graph.edges) {
      linked.add(`${edge.fromNodeId}:out:${edge.fromPortId}`);
      linked.add(`${edge.toNodeId}:in:${edge.toPortId}`);
    }
    const pins = this.graphCanvasEl.querySelectorAll<HTMLElement>(".ss-studio-port-pin");
    pins.forEach((pin) => {
      const nodeId = pin.dataset.nodeId || "";
      const portId = pin.dataset.portId || "";
      const direction = pin.classList.contains("is-output") ? "out" : "in";
      pin.classList.toggle("is-linked", linked.has(`${nodeId}:${direction}:${portId}`));
    });
  }

  private detachAnimator(): void {
    if (this.animator) {
      this.animator.detach();
      this.animator = null;
    }
    if (this.storeUnsub) {
      this.storeUnsub();
      this.storeUnsub = null;
    }
  }
}
