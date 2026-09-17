import { arrangeStudioGraph, inspectStudioGraphLayout, type StudioLayoutMeasurements } from "../../studio/StudioGraphLayout";
import type { StudioProjectV1 } from "../../studio/types";

type Host = {
  getProject: () => StudioProjectV1 | null;
  getNodeElement: (id: string) => HTMLElement | null;
  isDragging: () => boolean;
  commit: (mutator: (project: StudioProjectV1) => boolean) => boolean;
  positionsChanged: () => void;
  reportError: (message: string) => void;
};

/** Owns measured, derived geometry. Reflow never rebuilds editors or writes coordinate caches. */
export class StudioAutomaticLayoutController {
  private root: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private timer: number | null = null;
  private ownerWindow: (Window & Pick<typeof window, "ResizeObserver">) | null = null;
  private dragStart = new Map<string, { x: number; y: number }>();
  private lastMeasurements = '';
  private readonly onFocusOut = () => this.schedule();
  constructor(private readonly host: Host) {}

  mount(root: HTMLElement): void {
    this.dispose();
    this.root = root;
    this.ownerWindow = root.ownerDocument.defaultView;
    const Observer = this.ownerWindow?.ResizeObserver;
    if (Observer) {
      const observer = new Observer(() => this.schedule());
      this.observer = observer;
      for (const node of this.host.getProject()?.graph.nodes || []) {
        const el = this.host.getNodeElement(node.id);
        if (el) observer.observe(el);
      }
    }
    root.addEventListener("focusout", this.onFocusOut);
    this.arrange(false);
    this.schedule();
  }

  private measurements(): StudioLayoutMeasurements {
    const sizes = new Map<string, { width: number; height: number }>();
    for (const node of this.host.getProject()?.graph.nodes || []) {
      const el = this.host.getNodeElement(node.id);
      if (el && el.offsetWidth > 0 && el.offsetHeight > 0) sizes.set(node.id, { width: el.offsetWidth, height: el.offsetHeight });
    }
    return sizes;
  }

  schedule(): void {
    if (!this.ownerWindow || this.timer !== null) return;
    this.timer = this.ownerWindow.setTimeout(() => {
      this.timer = null;
      this.arrange(false);
    }, 120);
  }

  arrange(explicit = true) {
    const project = this.host.getProject();
    if (!project || !this.root || this.host.isDragging()) return null;
    if (!explicit && project.graph.layout?.mode !== "managed") return null;
    const active = this.root.ownerDocument.activeElement;
    if (!explicit && active && this.root.contains(active) && active.matches("input, textarea, select, [contenteditable='true'], .cm-content")) return null;
    try {
      const sizes = this.measurements();
      // Hidden tabs report zero geometry. They must not replace the active view's measured placement with estimates.
      if (sizes.size !== project.graph.nodes.length) return null;
      let moved: string[] = [];
      if (project.graph.layout?.mode === "managed") {
        moved = arrangeStudioGraph(project, sizes);
      } else {
        this.host.commit((current) => { moved = arrangeStudioGraph(current, sizes); return moved.length > 0; });
      }
      const current = this.host.getProject();
      if (!current) return null;
      const measurementSignature = JSON.stringify([...sizes]);
      const resized = measurementSignature !== this.lastMeasurements;
      this.lastMeasurements = measurementSignature;
      if (moved.length) {
        for (const node of current.graph.nodes) {
          const el = this.host.getNodeElement(node.id);
          if (el) el.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
        }
      }
      // A peer can grow without moving any node. Frames, ports and canvas bounds still need refreshing.
      if (moved.length || resized) this.host.positionsChanged();
      const report = inspectStudioGraphLayout(current, sizes);
      this.root.dataset.layoutOverlaps = String(report.overlaps.length);
      this.root.dataset.layoutMeasured = String(report.unmeasuredNodeIds.length === 0);
      if (explicit && report.overlaps.length) this.host.reportError("Some fixed items overlap. Unpin their group or move the drawings to allow automatic placement.");
      return report;
    } catch (error) {
      this.host.reportError(error instanceof Error ? error.message : "Studio could not arrange this graph.");
      return null;
    }
  }

  inspect() {
    const project = this.host.getProject();
    return project ? inspectStudioGraphLayout(project, this.measurements()) : null;
  }

  toggleMode(): void {
    this.host.commit((project) => {
      project.graph.layout = { ...project.graph.layout, mode: project.graph.layout?.mode === "managed" ? "manual" : "managed" };
      return true;
    });
    this.arrange(false);
  }

  togglePins(ids: string[]): void {
    if (!ids.length) return;
    this.host.commit((project) => {
      const existing = new Set(project.graph.layout?.pinnedNodeIds || []);
      const unpin = ids.every((id) => existing.has(id));
      for (const id of ids) { if (unpin) existing.delete(id); else existing.add(id); }
      project.graph.layout = { mode: "manual", ...project.graph.layout, pinnedNodeIds: [...existing] };
      return true;
    });
    this.arrange(false);
  }

  onDrag(dragging: boolean): void {
    const project = this.host.getProject();
    if (!project || project.graph.layout?.mode !== "managed") return;
    if (dragging) {
      this.dragStart = new Map(project.graph.nodes.map((node) => [node.id, { ...node.position }]));
      return;
    }
    const moved = project.graph.nodes.filter((node) => {
      const before = this.dragStart.get(node.id);
      return before && (before.x !== node.position.x || before.y !== node.position.y);
    }).map((node) => node.id);
    this.dragStart.clear();
    if (moved.length) this.host.commit((current) => {
      current.graph.layout = { mode: "managed", ...current.graph.layout, pinnedNodeIds: [...new Set([...(current.graph.layout?.pinnedNodeIds || []), ...moved])] };
      return true;
    });
    this.schedule();
  }

  dispose(): void {
    this.observer?.disconnect(); this.observer = null;
    if (this.timer !== null) this.ownerWindow?.clearTimeout(this.timer);
    this.timer = null;
    this.root?.removeEventListener("focusout", this.onFocusOut);
    this.root = null; this.ownerWindow = null;
    this.dragStart.clear();
    this.lastMeasurements = '';
  }
}
