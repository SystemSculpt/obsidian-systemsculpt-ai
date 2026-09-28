import { isLiveActivityPhase, isSettledActivityPhase, type StudioActivityPhase, type StudioEdgeActivityPhase, type StudioNodeActivity, type StudioPortActivityPhase } from "./StudioActivity";
import { updateStudioActivityBadge } from "./StudioActivityBadge";
import type { StudioActivitySnapshot } from "./StudioActivityProjector";

/** Runtime CSS contract written here and read by views/studio/activity.css. */
export const STUDIO_ACTIVITY_PROGRESS_PROPERTY = "--ss-activity-progress";

export type StudioEdgeActivityUpdate = Readonly<{ phase: StudioEdgeActivityPhase; pulse: boolean }>;

/** The live canvas lookups; StudioGraphInteractionEngine satisfies this directly. */
export type StudioActivityDomTargets = Readonly<{
  getNodeElement: (nodeId: string) => HTMLElement | null;
  getPortElement: (nodeId: string, direction: "in" | "out", portId: string) => HTMLElement | null;
  /** Cables live in the SVG layer the connection engine owns. */
  setEdgeActivity: (edges: ReadonlyMap<string, StudioEdgeActivityUpdate>) => void;
}>;

/** One-shot transition emphasis; cleared when its animation ends. */
export function pulseStudioActivityElement(el: HTMLElement | SVGElement, kind: string): void {
  if (el.dataset.activityPulse) {
    delete el.dataset.activityPulse;
    // Restart the animation when the same pulse fires twice in a row.
    void (el as HTMLElement).offsetWidth;
  }
  el.dataset.activityPulse = kind;
  el.addEventListener(
    "animationend",
    (event) => {
      const name = String((event as AnimationEvent).animationName || "");
      if (event.target === el && name.startsWith("ss-studio-activity-pulse")) {
        delete el.dataset.activityPulse;
      }
    },
    { once: true }
  );
}

/**
 * Writes a node's activity onto its card. Shared by the card renderer (first
 * paint) and the applier (in-place updates) so both paths produce identical
 * DOM: `data-activity`, `aria-busy`, the progress custom property, and the
 * badge row contents.
 */
export function applyStudioNodeActivity(
  nodeEl: HTMLElement,
  activity: StudioNodeActivity,
  options?: { pulse?: boolean }
): void {
  nodeEl.dataset.activity = activity.phase;
  if (activity.progress === null) {
    nodeEl.style.removeProperty(STUDIO_ACTIVITY_PROGRESS_PROPERTY);
    delete nodeEl.dataset.activityProgress;
  } else {
    nodeEl.style.setProperty(STUDIO_ACTIVITY_PROGRESS_PROPERTY, activity.progress.toFixed(3));
    nodeEl.dataset.activityProgress = "determinate";
  }
  if (isLiveActivityPhase(activity.phase)) nodeEl.setAttribute("aria-busy", "true");
  else nodeEl.removeAttribute("aria-busy");
  const badge = nodeEl.querySelector<HTMLElement>(":scope > .ss-studio-node-activity");
  if (badge) updateStudioActivityBadge(badge, activity);
  if (options?.pulse) pulseStudioActivityElement(nodeEl, activity.phase);
}

/**
 * Patches activity into the live graph DOM without rebuilding it. Remembers
 * the last phase per node and cable so transition pulses fire once, on a real
 * change, and never replay after a structural re-render.
 */
export class StudioActivityDomApplier {
  private readonly nodePhases = new Map<string, StudioActivityPhase>();
  private readonly edgePhases = new Map<string, StudioEdgeActivityPhase>();
  private readonly activePorts = new Map<string, StudioPortActivityPhase>();

  constructor(private readonly resolveTargets: () => StudioActivityDomTargets) {}

  apply(snapshot: StudioActivitySnapshot): void {
    const targets = this.resolveTargets();
    for (const [nodeId, activity] of snapshot.nodes) {
      const previous = this.nodePhases.get(nodeId);
      const pulse = previous !== undefined && previous !== activity.phase && isSettledActivityPhase(activity.phase);
      this.nodePhases.set(nodeId, activity.phase);
      const nodeEl = targets.getNodeElement(nodeId);
      if (nodeEl) applyStudioNodeActivity(nodeEl, activity, { pulse });
    }
    for (const nodeId of [...this.nodePhases.keys()]) {
      if (!snapshot.nodes.has(nodeId)) this.nodePhases.delete(nodeId);
    }

    const edges = new Map<string, StudioEdgeActivityUpdate>();
    for (const [edgeId, phase] of snapshot.edges) {
      const previous = this.edgePhases.get(edgeId);
      const pulse = previous !== undefined && previous !== phase && (phase === "delivered" || phase === "failed");
      this.edgePhases.set(edgeId, phase);
      edges.set(edgeId, { phase, pulse });
    }
    for (const edgeId of [...this.edgePhases.keys()]) {
      if (!snapshot.edges.has(edgeId)) this.edgePhases.delete(edgeId);
    }
    targets.setEdgeActivity(edges);

    for (const key of [...this.activePorts.keys()]) {
      if (snapshot.ports.has(key)) continue;
      this.activePorts.delete(key);
      const pin = this.resolvePort(targets, key);
      if (pin) delete pin.dataset.activity;
    }
    for (const [key, phase] of snapshot.ports) {
      this.activePorts.set(key, phase);
      const pin = this.resolvePort(targets, key);
      if (pin) pin.dataset.activity = phase;
    }
  }

  /** Forget transition memory, e.g. when another project opens. */
  reset(): void {
    this.nodePhases.clear();
    this.edgePhases.clear();
    this.activePorts.clear();
  }

  private resolvePort(targets: StudioActivityDomTargets, key: string): HTMLElement | null {
    const separator = key.lastIndexOf(":");
    const head = key.slice(0, separator);
    const portId = key.slice(separator + 1);
    const directionAt = head.lastIndexOf(":");
    const nodeId = head.slice(0, directionAt);
    const direction = head.slice(directionAt + 1) as "in" | "out";
    if (!nodeId || (direction !== "in" && direction !== "out")) return null;
    return targets.getPortElement(nodeId, direction, portId);
  }
}
