import { Notice } from "obsidian";
import type {
  ConnectionAutoCreateRequest,
  ConnectionDragState,
  StudioGraphInteractionHost,
} from "../StudioGraphInteractionTypes";
import { resolveSnapTarget, type SnapCandidate } from "./LinkSnap";
import type { PortAnchor, StudioLinkStore } from "./StudioLinkStore";

const SNAP_RADIUS_SCREEN_PX = 36;
const AUTO_CREATE_HINT_DELAY_MS = 500;
const DRAG_ACTIVATION_PX = 3;

export type PortDirection = "in" | "out";

export type PortInteractionHost = StudioGraphInteractionHost & {
  getGraphZoom: () => number;
};

type PortMapEntry = {
  nodeId: string;
  portId: string;
  direction: PortDirection;
  element: HTMLElement;
};

export type PortInteractionCallbacks = {
  onConnectionCommit: (target: PortAnchor) => void;
  onAutoCreateHint: (visible: boolean, label: string | null, clientX: number, clientY: number) => void;
  onAutoCreateRelease: (request: ConnectionAutoCreateRequest) => boolean;
  onDragStateChange: (state: ConnectionDragState | null) => void;
};

type InternalDrag = ConnectionDragState & {
  sourceType: string;
  candidates: SnapCandidate[];
  compatiblePortKeys: Set<string>;
  incompatiblePortKeys: Set<string>;
  sourceKey: string;
};

type InternalArmed = {
  fromNodeId: string;
  fromPortId: string;
  sourceType: string;
  candidates: SnapCandidate[];
  compatiblePortKeys: Set<string>;
  incompatiblePortKeys: Set<string>;
  sourceKey: string;
  lastClientX: number;
  lastClientY: number;
};

function portKey(nodeId: string, direction: PortDirection, portId: string): string {
  return `${nodeId}:${direction}:${portId}`;
}

export class StudioPortInteraction {
  private readonly ports = new Map<string, PortMapEntry>();
  private drag: InternalDrag | null = null;
  private armed: InternalArmed | null = null;
  private armedTeardown: (() => void) | null = null;
  private canvasEl: HTMLElement | null = null;
  private autoCreateHintTimer: number | null = null;
  private autoCreateHintVisible = false;
  private suppressedOutputClickKey: string | null = null;
  private pointerListenerTeardown: (() => void) | null = null;

  constructor(
    private readonly host: PortInteractionHost,
    private readonly store: StudioLinkStore,
    private readonly callbacks: PortInteractionCallbacks
  ) {}

  registerCanvas(canvas: HTMLElement): void {
    this.canvasEl = canvas;
  }

  registerPortElement(
    nodeId: string,
    direction: PortDirection,
    portId: string,
    element: HTMLElement
  ): void {
    this.ports.set(portKey(nodeId, direction, portId), { nodeId, portId, direction, element });
  }

  clearPortElements(): void {
    this.resetPortVisualState();
    this.ports.clear();
  }

  clearRenderBindings(): void {
    this.cancel();
    this.ports.clear();
    this.canvasEl = null;
  }

  getPendingConnectionSourceKey(): string | null {
    return this.drag?.sourceKey ?? this.armed?.sourceKey ?? null;
  }

  isPendingConnectionSource(nodeId: string, portId: string): boolean {
    if (this.drag && this.drag.fromNodeId === nodeId && this.drag.fromPortId === portId) {
      return true;
    }
    if (this.armed && this.armed.fromNodeId === nodeId && this.armed.fromPortId === portId) {
      return true;
    }
    return false;
  }

  cancel(): void {
    this.teardownPointerListeners();
    this.armedTeardown?.();
    this.armedTeardown = null;
    const hadPending = Boolean(this.drag || this.armed);
    this.drag = null;
    this.armed = null;
    if (hadPending) {
      this.store.setDragState(null);
      this.callbacks.onDragStateChange(null);
    }
    this.resetPortVisualState();
    this.clearAutoCreateHintTimer();
    if (this.autoCreateHintVisible) {
      this.autoCreateHintVisible = false;
      this.callbacks.onAutoCreateHint(false, null, 0, 0);
    }
  }

  private clearDragState(): void {
    this.resetPortVisualState();
    if (this.drag) {
      this.drag = null;
      this.store.setDragState(null);
      this.callbacks.onDragStateChange(null);
    }
  }

  consumeSuppressedOutputClick(nodeId: string, portId: string): boolean {
    const key = portKey(nodeId, "out", portId);
    if (this.suppressedOutputClickKey !== key) {
      return false;
    }
    this.suppressedOutputClickKey = null;
    return true;
  }

  startDrag(
    fromNodeId: string,
    fromPortId: string,
    startEvent: PointerEvent,
    sourcePinEl: HTMLElement
  ): void {
    if (this.host.isBusy() || startEvent.button !== 0) return;
    startEvent.preventDefault();

    const { sourceType, candidates, compatible, incompatible } =
      this.collectInputCandidates(fromNodeId, fromPortId);

    this.applyDragClasses(compatible, incompatible);

    const sourceKey = portKey(fromNodeId, "out", fromPortId);
    this.drag = {
      pointerId: startEvent.pointerId,
      fromNodeId,
      fromPortId,
      startClientX: startEvent.clientX,
      startClientY: startEvent.clientY,
      lastClientX: startEvent.clientX,
      lastClientY: startEvent.clientY,
      active: false,
      sourceType,
      candidates,
      compatiblePortKeys: compatible,
      incompatiblePortKeys: incompatible,
      sourceKey,
    };
    this.callbacks.onDragStateChange(this.drag);

    if (typeof sourcePinEl.setPointerCapture === "function") {
      try {
        sourcePinEl.setPointerCapture(startEvent.pointerId);
      } catch {
        // ignore
      }
    }

    const onMove = (event: PointerEvent) => {
      if (!this.drag || event.pointerId !== startEvent.pointerId) return;
      this.drag.lastClientX = event.clientX;
      this.drag.lastClientY = event.clientY;
      const moved = Math.hypot(
        event.clientX - this.drag.startClientX,
        event.clientY - this.drag.startClientY
      );
      if (!this.drag.active && moved > DRAG_ACTIVATION_PX) {
        this.drag.active = true;
        this.cancelArmedOnly();
        this.applyActiveOutputClass();
        this.callbacks.onDragStateChange(this.drag);
        this.scheduleAutoCreateHint();
      }
      if (this.drag.active) {
        this.updateDragStoreSnapshot();
      }
    };

    const onEnd = (event: PointerEvent) => {
      if (event.pointerId !== startEvent.pointerId) return;
      this.teardownPointerListeners();
      if (!this.drag) return;

      const finished = this.drag;
      const snap = this.store.getDragState()?.snapTarget || null;
      const shouldAutoCreate = this.autoCreateHintVisible;
      // Only suppress the synthetic click that follows a REAL drag-release. A
      // plain click (never activated) must fall through to beginConnection so
      // click-to-connect can arm.
      if (finished.active) {
        this.suppressedOutputClickKey = finished.sourceKey;
      }

      this.clearAutoCreateHintTimer();
      this.autoCreateHintVisible = false;
      this.callbacks.onAutoCreateHint(false, null, 0, 0);

      // A plain click (no drag past the activation threshold) commits nothing.
      if (!finished.active) {
        this.clearDragState();
        return;
      }

      // A real drag landed on a snap target: commit BEFORE clearing this.drag,
      // because commitConnectionFromSnap reads the source via
      // getPendingConnectionSourceKey() -> this.drag.sourceKey. The commit path
      // calls cancel() internally, which clears this.drag for us.
      if (snap) {
        this.callbacks.onConnectionCommit(snap);
        if (this.drag === finished) {
          this.clearDragState();
        }
        return;
      }

      // Released over empty space with the auto-create hint showing.
      if (shouldAutoCreate) {
        const handled = this.callbacks.onAutoCreateRelease({
          fromNodeId: finished.fromNodeId,
          fromPortId: finished.fromPortId,
          sourceType: finished.sourceType,
          clientX: event.clientX,
          clientY: event.clientY,
        });
        if (handled) {
          if (this.drag === finished) {
            this.clearDragState();
          }
          return;
        }
      }

      this.clearDragState();
    };

    this.pointerListenerTeardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (typeof sourcePinEl.releasePointerCapture === "function") {
        try {
          sourcePinEl.releasePointerCapture(startEvent.pointerId);
        } catch {
          // ignore
        }
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  private teardownPointerListeners(): void {
    if (this.pointerListenerTeardown) {
      this.pointerListenerTeardown();
      this.pointerListenerTeardown = null;
    }
  }

  private updateDragStoreSnapshot(): void {
    if (!this.drag) return;
    const snap = this.writeSnapshot({
      fromNodeId: this.drag.fromNodeId,
      fromPortId: this.drag.fromPortId,
      candidates: this.drag.candidates,
      lastClientX: this.drag.lastClientX,
      lastClientY: this.drag.lastClientY,
    });
    if (snap) {
      this.hideAutoCreateHint();
    } else if (!this.autoCreateHintTimer && !this.autoCreateHintVisible) {
      this.scheduleAutoCreateHint();
    }
  }

  private scheduleAutoCreateHint(): void {
    this.clearAutoCreateHintTimer();
    if (!this.drag || !this.drag.active) return;
    const descriptor = this.host.describeConnectionAutoCreate?.(this.drag.sourceType) ?? null;
    if (!descriptor) return;
    this.autoCreateHintTimer = window.setTimeout(() => {
      this.autoCreateHintTimer = null;
      if (!this.drag || !this.drag.active) return;
      const snap = this.store.getDragState()?.snapTarget;
      if (snap) {
        this.hideAutoCreateHint();
        return;
      }
      this.autoCreateHintVisible = true;
      this.callbacks.onAutoCreateHint(true, descriptor.label, this.drag.lastClientX, this.drag.lastClientY);
    }, AUTO_CREATE_HINT_DELAY_MS);
  }

  private clearAutoCreateHintTimer(): void {
    if (this.autoCreateHintTimer !== null) {
      window.clearTimeout(this.autoCreateHintTimer);
      this.autoCreateHintTimer = null;
    }
  }

  private hideAutoCreateHint(): void {
    this.clearAutoCreateHintTimer();
    if (this.autoCreateHintVisible) {
      this.autoCreateHintVisible = false;
      this.callbacks.onAutoCreateHint(false, null, 0, 0);
    }
  }

  private applyDragClasses(compatible: Set<string>, incompatible: Set<string>): void {
    for (const [key, port] of this.ports) {
      port.element.classList.toggle("is-drop-target", compatible.has(key));
      port.element.classList.toggle("is-drop-incompatible", incompatible.has(key));
    }
  }

  private resetPortVisualState(): void {
    for (const port of this.ports.values()) {
      port.element.classList.remove("is-drop-target", "is-drop-incompatible", "is-active");
    }
  }

  private collectInputCandidates(
    fromNodeId: string,
    fromPortId: string
  ): {
    sourceType: string;
    candidates: SnapCandidate[];
    compatible: Set<string>;
    incompatible: Set<string>;
  } {
    const sourceType = this.host.getPortType(fromNodeId, "out", fromPortId) || "";
    const candidates: SnapCandidate[] = [];
    const compatible = new Set<string>();
    const incompatible = new Set<string>();
    for (const port of this.ports.values()) {
      if (port.direction !== "in") continue;
      const portType = this.host.getPortType(port.nodeId, "in", port.portId) || "";
      const ok = sourceType && portType && this.host.portTypeCompatible(sourceType, portType);
      const key = portKey(port.nodeId, "in", port.portId);
      const center = this.portCenter(port.element);
      if (center) {
        candidates.push({
          portKey: key,
          nodeId: port.nodeId,
          portId: port.portId,
          center,
          compatible: Boolean(ok),
        });
      }
      if (ok) compatible.add(key);
      else incompatible.add(key);
    }
    return { sourceType, candidates, compatible, incompatible };
  }

  private writeSnapshot(args: {
    fromNodeId: string;
    fromPortId: string;
    candidates: SnapCandidate[];
    lastClientX: number;
    lastClientY: number;
  }): ReturnType<typeof resolveSnapTarget> {
    if (!this.canvasEl) return null;
    const zoom = this.host.getGraphZoom() || 1;
    const canvasRect = this.canvasEl.getBoundingClientRect();
    const cursorWorld = {
      x: (args.lastClientX - canvasRect.left) / zoom,
      y: (args.lastClientY - canvasRect.top) / zoom,
    };
    const worldRadius = SNAP_RADIUS_SCREEN_PX / zoom;
    const snap = resolveSnapTarget({
      cursorWorld,
      candidates: args.candidates,
      radius: worldRadius,
    });
    const validity = snap && snap.confidence >= 0.15 ? "valid" : snap ? "near" : "invalid";
    this.store.setDragState({
      source: { nodeId: args.fromNodeId, portId: args.fromPortId },
      cursorWorld: snap?.magnetisedCursor ?? cursorWorld,
      snapTarget: snap?.snapTarget ?? null,
      snapConfidence: snap?.confidence ?? 0,
      validity,
    });
    return snap;
  }

  private portCenter(element: HTMLElement): { x: number; y: number } | null {
    if (!this.canvasEl) return null;
    const canvasRect = this.canvasEl.getBoundingClientRect();
    const portRect = element.getBoundingClientRect();
    const zoom = this.host.getGraphZoom() || 1;
    const cx = (portRect.left - canvasRect.left + portRect.width / 2) / zoom;
    const cy = (portRect.top - canvasRect.top + portRect.height / 2) / zoom;
    return { x: cx, y: cy };
  }

  applyActiveOutputClass(): void {
    const activeKey = this.drag?.sourceKey ?? this.armed?.sourceKey ?? null;
    for (const [key, port] of this.ports) {
      if (port.direction !== "out") continue;
      port.element.classList.toggle("is-active", key === activeKey);
    }
  }

  arm(fromNodeId: string, fromPortId: string): void {
    if (this.host.isBusy()) return;
    const key = portKey(fromNodeId, "out", fromPortId);
    // Clicking the already-armed output again cancels (toggle off).
    if (this.armed?.sourceKey === key) {
      this.cancel();
      return;
    }
    // Re-arming (or arming over a stale drag) starts clean.
    this.cancel();

    const { sourceType, candidates, compatible, incompatible } =
      this.collectInputCandidates(fromNodeId, fromPortId);
    this.applyDragClasses(compatible, incompatible);

    const start = this.sourcePinClientPoint(fromNodeId, fromPortId);
    this.armed = {
      fromNodeId,
      fromPortId,
      sourceType,
      candidates,
      compatiblePortKeys: compatible,
      incompatiblePortKeys: incompatible,
      sourceKey: key,
      lastClientX: start.x,
      lastClientY: start.y,
    };

    const onArmedMove = (event: PointerEvent) => {
      if (!this.armed) return;
      this.armed.lastClientX = event.clientX;
      this.armed.lastClientY = event.clientY;
      this.writeSnapshot({
        fromNodeId: this.armed.fromNodeId,
        fromPortId: this.armed.fromPortId,
        candidates: this.armed.candidates,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
      });
    };
    const onArmedKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.armed) {
        event.preventDefault();
        this.cancel();
      }
    };
    window.addEventListener("pointermove", onArmedMove);
    window.addEventListener("keydown", onArmedKey);
    this.armedTeardown = () => {
      window.removeEventListener("pointermove", onArmedMove);
      window.removeEventListener("keydown", onArmedKey);
    };

    this.writeSnapshot({
      fromNodeId,
      fromPortId,
      candidates,
      lastClientX: start.x,
      lastClientY: start.y,
    });
    this.applyActiveOutputClass();
    this.callbacks.onDragStateChange(null);
  }

  private cancelArmedOnly(): void {
    if (!this.armed) return;
    this.armedTeardown?.();
    this.armedTeardown = null;
    this.armed = null;
  }

  private sourcePinClientPoint(
    nodeId: string,
    portId: string
  ): { x: number; y: number } {
    const entry = this.ports.get(portKey(nodeId, "out", portId));
    if (entry) {
      const rect = entry.element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return { x: 0, y: 0 };
  }

  reapplyPendingHighlights(): void {
    const active = this.drag ?? this.armed;
    if (!active) return;
    this.applyDragClasses(active.compatiblePortKeys, active.incompatiblePortKeys);
  }

  noticeInvalidConnection(message: string): void {
    new Notice(message);
  }
}
