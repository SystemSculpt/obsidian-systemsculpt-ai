import type { StudioLinkStore, EdgeState } from "./StudioLinkStore";

const FLOW_PERIOD_MS = 1200;
const FLARE_MS = 600;

type EdgeElementLookup = (edgeId: string) => SVGGElement | null;

type ReducedMotionProvider = () => boolean;

type AnimatorOptions = {
  store: StudioLinkStore;
  getEdgeGroupElement: EdgeElementLookup;
  isReducedMotion?: ReducedMotionProvider;
  now?: () => number;
  requestFrame?: (cb: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
};

export class StudioLinkAnimator {
  private readonly store: StudioLinkStore;
  private readonly getEdgeGroupElement: EdgeElementLookup;
  private readonly isReducedMotion: ReducedMotionProvider;
  private readonly now: () => number;
  private readonly requestFrame: (cb: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;

  private rafHandle: number | null = null;
  private lastTick: number | null = null;
  private unsub: (() => void) | null = null;

  constructor(options: AnimatorOptions) {
    this.store = options.store;
    this.getEdgeGroupElement = options.getEdgeGroupElement;
    this.isReducedMotion =
      options.isReducedMotion ||
      (() =>
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.now =
      options.now ||
      (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.requestFrame =
      options.requestFrame ||
      ((cb) =>
        typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
          ? window.requestAnimationFrame(cb)
          : (setTimeout(() => cb(this.now()), 16) as unknown as number));
    this.cancelFrame =
      options.cancelFrame ||
      ((handle) => {
        if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(handle);
        } else {
          clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
        }
      });
  }

  attach(): void {
    if (this.unsub) {
      return;
    }
    this.unsub = this.store.subscribe(() => this.ensureRunning());
    this.ensureRunning();
  }

  detach(): void {
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    this.stop();
  }

  private ensureRunning(): void {
    if (this.rafHandle !== null) {
      return;
    }
    if (!this.hasActiveEdges()) {
      return;
    }
    if (this.isReducedMotion()) {
      this.writeStaticStates();
      return;
    }
    this.lastTick = this.now();
    this.rafHandle = this.requestFrame((t) => this.tick(t));
  }

  private stop(): void {
    if (this.rafHandle !== null) {
      this.cancelFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.lastTick = null;
  }

  private tick(timestamp: number): void {
    this.rafHandle = null;
    const previous = this.lastTick ?? timestamp;
    const dt = Math.max(0, timestamp - previous);
    this.lastTick = timestamp;

    let stillActive = false;
    for (const edge of this.store.listEdges()) {
      const group = this.getEdgeGroupElement(edge.id);
      if (!group) continue;
      if (edge.status === "flowing") {
        const nextPhase = ((edge.flowPhase * FLOW_PERIOD_MS + dt) % FLOW_PERIOD_MS) / FLOW_PERIOD_MS;
        this.store.setEdgeFlowPhase(edge.id, nextPhase);
        group.style.setProperty("--ss-link-flow-phase", nextPhase.toFixed(3));
        stillActive = true;
      }
      if (edge.flareT > 0 && edge.flareT < 1) {
        const nextFlare = Math.min(1, edge.flareT + dt / FLARE_MS);
        this.store.setEdgeFlareT(edge.id, nextFlare);
        group.style.setProperty("--ss-link-flare-t", nextFlare.toFixed(3));
        stillActive = nextFlare < 1 || stillActive;
      }
    }

    if (stillActive) {
      this.rafHandle = this.requestFrame((t) => this.tick(t));
    } else {
      this.lastTick = null;
    }
  }

  triggerFlare(edgeId: string): void {
    const group = this.getEdgeGroupElement(edgeId);
    if (!group) return;
    this.store.setEdgeFlareT(edgeId, 0.0001);
    group.style.setProperty("--ss-link-flare-t", "0");
    this.ensureRunning();
  }

  private hasActiveEdges(): boolean {
    for (const edge of this.store.listEdges()) {
      if (edge.status === "flowing") return true;
      if (edge.flareT > 0 && edge.flareT < 1) return true;
    }
    return false;
  }

  private writeStaticStates(): void {
    for (const edge of this.store.listEdges()) {
      const group = this.getEdgeGroupElement(edge.id);
      if (!group) continue;
      group.style.setProperty("--ss-link-flow-phase", "0");
      group.style.setProperty("--ss-link-flare-t", edge.flareT > 0 ? "1" : "0");
    }
  }
}
