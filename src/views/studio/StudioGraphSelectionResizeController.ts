import { isManagedOutputPlaceholderNode } from "../../studio/StudioManagedOutputNodes";
import {
  resolveMeasuredStudioNodeHeight,
  resolveMeasuredStudioNodeWidth,
  resolveStudioCanvasDelta,
  resolveStudioTextNodeFontSize,
} from "../../studio/StudioNodeGeometry";
import type { StudioNodeInstance, StudioProjectV1 } from "../../studio/types";
import type {
  StudioGraphNodeMutationOptions,
  StudioGraphNodeResizePatch,
} from "./graph-v3/StudioGraphNodeCardTypes";
import {
  resolveStudioGraphResizeZoneLayout,
  STUDIO_GRAPH_RESIZE_ZONES,
  type StudioGraphResizeZone,
} from "./graph-v3/StudioGraphNodeResizeFrame";
import {
  computeStudioSelectionBounds,
  resolveStudioSelectionResizePatches,
  type StudioSelectionRect,
  type StudioSelectionResizeNodeSnapshot,
  type StudioSelectionResizePatchEntry,
} from "./graph-v3/StudioGraphSelectionTransform";

export type StudioGraphSelectionResizePatchEntry = StudioSelectionResizePatchEntry;

/**
 * Multi-select resize frame (tldraw parity): when two or more nodes are
 * selected, one selection bounds box renders around them with the same
 * 8-zone affordances as the per-node frame, and dragging any zone scales
 * the whole selection as a group.
 *
 * Seam: this is a canvas-level overlay controller owned by the interaction
 * engine, exactly like the group-frame layer — the frame element lives
 * inside the zoomed canvas (so canvas-space coordinates need no zoom
 * compensation to draw) and re-derives on the same notifications existing
 * overlays use: selection changes, node-position notifications, and full
 * workspace re-renders. While the frame is visible the canvas carries
 * `is-multi-select-active`, which hides the per-node resize zones via CSS.
 *
 * Gesture protocol (mirrors the single-node frame's #284 hardening):
 * pointer capture with window-listener fallback, rAF-batched application
 * with synchronous-rAF (jsdom) tolerance, one atomic multi-patch commit
 * per flushed frame in continuous mode with history captured on the FIRST
 * mutating frame only, and a discrete commit on release — so exactly one
 * undo step restores the whole pre-gesture layout. Escape aborts: the DOM
 * and project geometry revert to the gesture-start snapshot.
 */

type StudioGraphSelectionResizeControllerHost = {
  isBusy: () => boolean;
  getCurrentProject: () => StudioProjectV1 | null;
  getGraphZoom: () => number;
  getSelectedNodeIds: () => string[];
  getNodeElement: (nodeId: string) => HTMLElement | null;
  /** Atomic multi-node geometry commit: ONE project mutation per call. */
  onSelectionResize?: (
    patches: StudioGraphSelectionResizePatchEntry[],
    options?: StudioGraphNodeMutationOptions
  ) => void;
};

type GestureState = {
  pointerId: number;
  zone: StudioGraphResizeZone;
  zoneEl: HTMLElement;
  startClientX: number;
  startClientY: number;
  startBounds: StudioSelectionRect;
  snapshots: StudioSelectionResizeNodeSnapshot[];
  nodesById: Map<string, StudioNodeInstance>;
  pendingDeltaX: number;
  pendingDeltaY: number;
  frameId: number | null;
  lastSignature: string;
  lastPatches: StudioSelectionResizePatchEntry[];
  didMutate: boolean;
  capturedHistory: boolean;
};

export class StudioGraphSelectionResizeController {
  private canvasEl: HTMLElement | null = null;
  private frameEl: HTMLElement | null = null;
  private gesture: GestureState | null = null;

  constructor(private readonly host: StudioGraphSelectionResizeControllerHost) {}

  registerCanvasElement(canvas: HTMLElement): void {
    this.canvasEl = canvas;
    if (this.frameEl && this.frameEl.parentElement === canvas) {
      return;
    }
    this.frameEl?.remove();
    const frameEl = canvas.createDiv({ cls: "ss-studio-selection-resize-frame" });
    for (const zone of STUDIO_GRAPH_RESIZE_ZONES) {
      const isCorner = zone.length === 2;
      const zoneEl = frameEl.createDiv({
        cls: [
          "ss-studio-selection-resize-zone",
          `is-zone-${zone}`,
          isCorner ? "is-corner" : "is-edge",
        ].join(" "),
        attr: {
          title: "Resize selection",
          "aria-label": "Resize selection",
          "data-resize-zone": zone,
        },
      });
      for (const [property, value] of Object.entries(resolveStudioGraphResizeZoneLayout(zone))) {
        zoneEl.style.setProperty(property, value);
      }
      zoneEl.addEventListener("pointerdown", (event) => {
        this.startGesture(zone, zoneEl, event as PointerEvent);
      });
    }
    this.frameEl = frameEl;
  }

  clearRenderBindings(): void {
    // A re-render mid-gesture finalizes at the last applied state, exactly
    // like unmounting the single-node frame does.
    this.finishGesture("finalize");
    this.frameEl?.remove();
    this.frameEl = null;
    this.canvasEl = null;
  }

  /**
   * Re-derives the frame from the current selection and live node DOM.
   * No-op while a gesture is in flight — the gesture drives the frame from
   * its own transform math.
   */
  refreshSelectionFrame(): void {
    if (this.gesture) {
      return;
    }
    const selection = this.snapshotSelection();
    if (!selection || this.host.isBusy()) {
      this.hideFrame();
      return;
    }
    this.applyFrameBounds(selection.bounds);
    this.frameEl?.classList.add("is-visible");
    this.canvasEl?.classList.add("is-multi-select-active");
  }

  private hideFrame(): void {
    this.frameEl?.classList.remove("is-visible");
    this.canvasEl?.classList.remove("is-multi-select-active");
  }

  private applyFrameBounds(bounds: StudioSelectionRect): void {
    if (!this.frameEl) {
      return;
    }
    this.frameEl.style.left = `${bounds.left}px`;
    this.frameEl.style.top = `${bounds.top}px`;
    this.frameEl.style.width = `${bounds.width}px`;
    this.frameEl.style.height = `${bounds.height}px`;
  }

  /**
   * Snapshots the current multi-selection: canvas-space rects (width from
   * the geometry resolvers, height from live DOM measurement — the same
   * sources the group-bounds overlays use) plus per-node transform context.
   * Returns null unless at least two selected nodes exist in the project.
   */
  private snapshotSelection(): {
    bounds: StudioSelectionRect;
    snapshots: StudioSelectionResizeNodeSnapshot[];
    nodesById: Map<string, StudioNodeInstance>;
  } | null {
    const project = this.host.getCurrentProject();
    if (!project) {
      return null;
    }
    const nodeById = new Map(project.graph.nodes.map((node) => [node.id, node] as const));
    const snapshots: StudioSelectionResizeNodeSnapshot[] = [];
    const nodesById = new Map<string, StudioNodeInstance>();
    for (const rawNodeId of this.host.getSelectedNodeIds()) {
      const node = nodeById.get(rawNodeId);
      if (!node || nodesById.has(node.id)) {
        continue;
      }
      const nodeEl = this.host.getNodeElement(node.id);
      snapshots.push({
        nodeId: node.id,
        kind: node.kind,
        rect: {
          left: node.position.x,
          top: node.position.y,
          width: resolveMeasuredStudioNodeWidth(nodeEl?.offsetWidth, node),
          height: resolveMeasuredStudioNodeHeight(nodeEl?.offsetHeight),
        },
        fontSize: resolveStudioTextNodeFontSize(node),
        hasAspectMediaContent: Boolean(
          nodeEl?.querySelector(".ss-studio-node-media-preview")
        ),
        interactionLocked: isManagedOutputPlaceholderNode(node),
      });
      nodesById.set(node.id, node);
    }
    if (snapshots.length < 2) {
      return null;
    }
    const bounds = computeStudioSelectionBounds(snapshots.map((snapshot) => snapshot.rect));
    if (!bounds) {
      return null;
    }
    return { bounds, snapshots, nodesById };
  }

  private startGesture(
    zone: StudioGraphResizeZone,
    zoneEl: HTMLElement,
    event: PointerEvent
  ): void {
    if (event.button !== 0 || this.gesture || this.host.isBusy()) {
      return;
    }
    const selection = this.snapshotSelection();
    if (!selection) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    this.gesture = {
      pointerId: event.pointerId,
      zone,
      zoneEl,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startBounds: selection.bounds,
      snapshots: selection.snapshots,
      nodesById: selection.nodesById,
      pendingDeltaX: 0,
      pendingDeltaY: 0,
      frameId: null,
      // Seed with the zero-delta transform so no-op flushes never commit.
      lastSignature: this.computeSignature(
        resolveStudioSelectionResizePatches({
          zone,
          deltaX: 0,
          deltaY: 0,
          startBounds: selection.bounds,
          nodes: selection.snapshots,
        }).patches
      ),
      lastPatches: [],
      didMutate: false,
      capturedHistory: false,
    };

    zoneEl.classList.add("is-active");
    if (typeof zoneEl.setPointerCapture === "function") {
      try {
        zoneEl.setPointerCapture(event.pointerId);
      } catch {
        // Ignore capture errors; window listeners are fallback.
      }
    }
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerFinish);
    window.addEventListener("pointercancel", this.onPointerFinish);
    window.addEventListener("keydown", this.onKeyDown);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    const delta = resolveStudioCanvasDelta({
      startClientX: gesture.startClientX,
      startClientY: gesture.startClientY,
      clientX: event.clientX,
      clientY: event.clientY,
      zoom: this.host.getGraphZoom(),
    });
    gesture.pendingDeltaX = delta.deltaX;
    gesture.pendingDeltaY = delta.deltaY;
    this.scheduleApply();
  };

  private readonly onPointerFinish = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    this.finishGesture("finalize");
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.gesture || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.finishGesture("abort");
  };

  private scheduleApply(): void {
    const gesture = this.gesture;
    if (!gesture || gesture.frameId !== null) {
      return;
    }
    let firedSynchronously = false;
    gesture.frameId = window.requestAnimationFrame(() => {
      firedSynchronously = true;
      this.applyPendingFrame();
    });
    if (firedSynchronously && this.gesture === gesture) {
      gesture.frameId = null;
    }
  }

  private applyPendingFrame(): void {
    const gesture = this.gesture;
    if (!gesture) {
      return;
    }
    gesture.frameId = null;
    const result = resolveStudioSelectionResizePatches({
      zone: gesture.zone,
      deltaX: gesture.pendingDeltaX,
      deltaY: gesture.pendingDeltaY,
      startBounds: gesture.startBounds,
      nodes: gesture.snapshots,
    });
    const signature = this.computeSignature(result.patches);
    if (signature === gesture.lastSignature) {
      return;
    }
    gesture.lastSignature = signature;
    gesture.lastPatches = result.patches;
    this.applyFrameBounds(result.bounds);
    this.applyPatchesToDom(gesture, result.patches);
    this.commitPatches(result.patches, {
      mode: "continuous",
      captureHistory: !gesture.capturedHistory,
    });
    gesture.capturedHistory = true;
    gesture.didMutate = true;
  }

  private computeSignature(patches: StudioSelectionResizePatchEntry[]): string {
    return patches
      .map(
        ({ nodeId, patch }) =>
          `${nodeId}:${patch.size?.width ?? ""}x${patch.size?.height ?? ""}` +
          `@${patch.position?.x ?? ""},${patch.position?.y ?? ""}/${patch.fontSize ?? ""}`
      )
      .join("|");
  }

  private applyPatchesToDom(
    gesture: GestureState,
    patches: StudioSelectionResizePatchEntry[]
  ): void {
    for (const { nodeId, patch } of patches) {
      const node = gesture.nodesById.get(nodeId);
      const nodeEl = this.host.getNodeElement(nodeId);
      if (!node || !nodeEl) {
        continue;
      }
      if (patch.size?.width !== undefined) {
        nodeEl.style.width = `${patch.size.width}px`;
      }
      if (patch.size?.height !== undefined) {
        // Same DOM interpretation as the card renderer's applySize:
        // explicit height for terminals, a min-height floor everywhere else.
        if (node.kind === "studio.terminal") {
          nodeEl.style.height = `${patch.size.height}px`;
        } else {
          nodeEl.style.minHeight = `${patch.size.height}px`;
        }
      }
      if (patch.fontSize !== undefined) {
        const textSurfaceEl = nodeEl.querySelector<HTMLElement>(
          ".ss-studio-text-node-display, .ss-studio-text-node-editor"
        );
        textSurfaceEl?.style.setProperty(
          "--ss-studio-text-node-font-size",
          `${patch.fontSize}px`
        );
      }
      if (patch.position) {
        nodeEl.style.transform = `translate(${patch.position.x}px, ${patch.position.y}px)`;
      }
    }
  }

  private commitPatches(
    patches: StudioSelectionResizePatchEntry[],
    options: StudioGraphNodeMutationOptions
  ): void {
    if (patches.length === 0) {
      return;
    }
    this.host.onSelectionResize?.(patches, options);
  }

  /**
   * Revert patches restore exactly the fields the gesture touched, filled
   * with gesture-start values — so an abort never introduces geometry
   * writes the gesture itself would not have made.
   */
  private buildRevertPatches(gesture: GestureState): StudioSelectionResizePatchEntry[] {
    const snapshotById = new Map(
      gesture.snapshots.map((snapshot) => [snapshot.nodeId, snapshot] as const)
    );
    const reverts: StudioSelectionResizePatchEntry[] = [];
    for (const { nodeId, patch } of gesture.lastPatches) {
      const snapshot = snapshotById.get(nodeId);
      if (!snapshot) {
        continue;
      }
      const revert: StudioGraphNodeResizePatch = {};
      if (patch.size) {
        revert.size = {
          ...(patch.size.width !== undefined
            ? { width: Math.round(snapshot.rect.width) }
            : {}),
          ...(patch.size.height !== undefined
            ? { height: Math.round(snapshot.rect.height) }
            : {}),
        };
      }
      if (patch.fontSize !== undefined) {
        revert.fontSize = snapshot.fontSize;
      }
      if (patch.position) {
        revert.position = {
          x: Math.round(snapshot.rect.left),
          y: Math.round(snapshot.rect.top),
        };
      }
      reverts.push({ nodeId, patch: revert });
    }
    return reverts;
  }

  private finishGesture(outcome: "finalize" | "abort"): void {
    const gesture = this.gesture;
    if (!gesture) {
      return;
    }
    if (gesture.frameId !== null) {
      window.cancelAnimationFrame(gesture.frameId);
      gesture.frameId = null;
      if (outcome === "finalize") {
        // Fold the pending pointer travel into the final state.
        this.applyPendingFrame();
      }
    }
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerFinish);
    window.removeEventListener("pointercancel", this.onPointerFinish);
    window.removeEventListener("keydown", this.onKeyDown);
    gesture.zoneEl.classList.remove("is-active");
    if (typeof gesture.zoneEl.releasePointerCapture === "function") {
      try {
        gesture.zoneEl.releasePointerCapture(gesture.pointerId);
      } catch {
        // Ignore release errors from detached pointers.
      }
    }

    if (gesture.didMutate) {
      if (outcome === "finalize") {
        this.commitPatches(gesture.lastPatches, {
          mode: "discrete",
          captureHistory: false,
        });
      } else {
        const reverts = this.buildRevertPatches(gesture);
        this.applyPatchesToDom(gesture, reverts);
        this.commitPatches(reverts, { mode: "discrete", captureHistory: false });
      }
    }

    this.gesture = null;
    this.refreshSelectionFrame();
  }
}
