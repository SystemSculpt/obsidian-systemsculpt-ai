import { arrangeManagedOutputContainers, type StudioOutputNodeMeasure } from "../../studio/StudioManagedOutputNodes";
import type { StudioProjectV1 } from "../../studio/types";
import { getStudioOwnerWindow } from "./StudioDomContext";

/** Measures output cards and their producers. It cannot arrange the rest of the canvas. */
export class StudioOutputContainerController {
  private observer: ResizeObserver | null = null;
  private owner: Window | null = null;
  private timer: number | null = null;
  private observed = new Map<string, Element>();

  constructor(private readonly host: {
    getProject: () => StudioProjectV1 | null;
    getNodeElement: (id: string) => HTMLElement | null;
    isDragging: () => boolean;
    commit: (mutate: (project: StudioProjectV1) => boolean) => boolean;
    positionsChanged: () => void;
  }) {}

  readonly measure: StudioOutputNodeMeasure = (node) => {
    const element = this.host.getNodeElement(node.id);
    return element && element.offsetWidth > 0 && element.offsetHeight > 0
      ? { width: element.offsetWidth, height: element.offsetHeight } : null;
  };

  mount(viewport: HTMLElement): void {
    this.dispose();
    this.owner = getStudioOwnerWindow(viewport);
    const Observer = (this.owner as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    // Arranged inside the observer callback, before the browser paints: a card
    // that grew never shows a frame where its Outputs frame lags behind.
    if (Observer) this.observer = new Observer(() => this.arrange());
    this.sync();
  }

  /**
   * Watches the output cards and producers on the canvas now, e.g. after an
   * in-place refresh added, replaced or removed one. Returns whether any is new.
   */
  sync(): boolean {
    if (!this.owner) return false;
    const groups = this.host.getProject()?.graph.groups?.filter(group => group.outputForNodeId) || [];
    const current = new Map<string, Element>();
    for (const id of new Set(groups.flatMap(group => [...group.nodeIds, group.outputForNodeId!]))) {
      const element = this.host.getNodeElement(id);
      if (element) current.set(id, element);
    }
    let added = false;
    for (const [id, element] of this.observed) {
      if (current.get(id) !== element) { this.observer?.unobserve(element); this.observed.delete(id); }
    }
    for (const [id, element] of current) {
      if (this.observed.has(id)) continue;
      this.observed.set(id, element);
      this.observer?.observe(element);
      added = true;
    }
    if (added) this.schedule();
    return added;
  }

  schedule(): void {
    if (!this.owner || this.timer !== null) return;
    this.timer = this.owner.setTimeout(() => {
      this.timer = null;
      this.arrange();
    }, 40);
  }

  private arrange(): void {
    if (!this.owner) return;
    // The view schedules again when the drag ends; nothing polls meanwhile.
    if (this.host.isDragging()) return;
    let moved: string[] = [];
    this.host.commit(project => {
      moved = arrangeManagedOutputContainers(project, this.measure);
      return moved.length > 0;
    });
    const project = this.host.getProject();
    if (!project) return;
    // A card that grew without moving (an image finished loading) still needs its frame and edges redrawn.
    const nodes = new Map(project.graph.nodes.map(node => [node.id, node]));
    for (const id of moved) {
      const element = this.host.getNodeElement(id), node = nodes.get(id);
      if (element && node) element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
    }
    this.host.positionsChanged();
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.observed.clear();
    if (this.timer !== null) this.owner?.clearTimeout(this.timer);
    this.timer = null;
    this.owner = null;
  }
}
