import { arrangeManagedOutputContainers, type StudioOutputNodeMeasure } from "../../studio/StudioManagedOutputNodes";
import type { StudioProjectV1 } from "../../studio/types";
import { getStudioOwnerWindow } from "./StudioDomContext";

/** Measures output cards and their producers. It cannot arrange the rest of the canvas. */
export class StudioOutputContainerController {
  private observer: ResizeObserver | null = null;
  private owner: Window | null = null;
  private timer: number | null = null;

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
    const project = this.host.getProject();
    const groups = project?.graph.groups?.filter(group => group.outputForNodeId) || [];
    if (!groups.length) return;
    this.owner = getStudioOwnerWindow(viewport);
    const Observer = (this.owner as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) {
      this.observer = new Observer(() => this.schedule());
      for (const id of new Set(groups.flatMap(group => [...group.nodeIds, group.outputForNodeId!]))) {
        const element = this.host.getNodeElement(id);
        if (element) this.observer.observe(element);
      }
    }
    this.schedule();
  }

  schedule(): void {
    if (!this.owner || this.timer !== null) return;
    this.timer = this.owner.setTimeout(() => {
      this.timer = null;
      if (this.host.isDragging()) { this.schedule(); return; }
      let moved: string[] = [];
      this.host.commit(project => {
        moved = arrangeManagedOutputContainers(project, this.measure);
        return moved.length > 0;
      });
      const project = this.host.getProject();
      if (!project || !moved.length) return;
      const nodes = new Map(project.graph.nodes.map(node => [node.id, node]));
      for (const id of moved) {
        const element = this.host.getNodeElement(id), node = nodes.get(id);
        if (element && node) element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
      }
      this.host.positionsChanged();
    }, 40);
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) this.owner?.clearTimeout(this.timer);
    this.timer = null;
    this.owner = null;
  }
}
