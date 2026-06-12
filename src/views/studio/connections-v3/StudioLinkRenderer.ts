import { buildCubicLinkCurve, buildChevronPath, curveTangentAtEnd } from "./LinkGeometry";
import type { PortAnchor, StudioLinkStore, EdgeState } from "./StudioLinkStore";

const SVG_NS = "http://www.w3.org/2000/svg";

export type EdgeGroupElements = {
  group: SVGGElement;
  hitPath: SVGPathElement;
  visiblePath: SVGPathElement;
  chevron: SVGPathElement;
};

export type RendererPortAnchorResolver = (
  anchor: PortAnchor,
  direction: "in" | "out"
) => { x: number; y: number } | null;

export type RendererOptions = {
  store: StudioLinkStore;
  layer: SVGSVGElement;
  resolvePortAnchorPoint: RendererPortAnchorResolver;
  getCursorAnchorPoint: () => { x: number; y: number } | null;
};

export class StudioLinkRenderer {
  private readonly groupsByEdgeId = new Map<string, EdgeGroupElements>();
  private previewPath: SVGPathElement | null = null;

  constructor(private readonly options: RendererOptions) {}

  getEdgeGroupElement(edgeId: string): SVGGElement | null {
    return this.groupsByEdgeId.get(edgeId)?.group || null;
  }

  render(): void {
    const { layer, store, resolvePortAnchorPoint, getCursorAnchorPoint } = this.options;
    const edges = store.listEdges();
    const seen = new Set<string>();

    for (const edge of edges) {
      const source = resolvePortAnchorPoint(edge.source, "out");
      const target = resolvePortAnchorPoint(edge.target, "in");
      if (!source || !target) {
        continue;
      }
      const curve = buildCubicLinkCurve(source, target);
      const chevron = buildChevronPath(target, curveTangentAtEnd(curve), 6);

      let group = this.groupsByEdgeId.get(edge.id);
      if (!group) {
        group = this.createEdgeGroup(edge.id);
        this.groupsByEdgeId.set(edge.id, group);
        layer.appendChild(group.group);
      }

      this.applyEdgeStatus(group, edge);
      if (group.visiblePath.getAttribute("d") !== curve.path) {
        group.visiblePath.setAttribute("d", curve.path);
      }
      if (group.hitPath.getAttribute("d") !== curve.path) {
        group.hitPath.setAttribute("d", curve.path);
      }
      if (group.chevron.getAttribute("d") !== chevron) {
        group.chevron.setAttribute("d", chevron);
      }
      seen.add(edge.id);
    }

    for (const [edgeId, group] of this.groupsByEdgeId) {
      if (seen.has(edgeId)) continue;
      group.group.remove();
      this.groupsByEdgeId.delete(edgeId);
    }

    this.renderPreview(getCursorAnchorPoint);
  }

  clear(): void {
    for (const group of this.groupsByEdgeId.values()) {
      group.group.remove();
    }
    this.groupsByEdgeId.clear();
    if (this.previewPath && this.previewPath.parentNode) {
      this.previewPath.parentNode.removeChild(this.previewPath);
    }
    this.previewPath = null;
  }

  private createEdgeGroup(edgeId: string): EdgeGroupElements {
    const group = document.createElementNS(SVG_NS, "g") as SVGGElement;
    group.setAttribute("class", "ss-studio-link-group");
    group.dataset.edgeId = edgeId;

    const hitPath = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    hitPath.setAttribute("class", "ss-studio-link-hit");
    hitPath.dataset.edgeId = edgeId;
    group.appendChild(hitPath);

    const visiblePath = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    visiblePath.setAttribute("class", "ss-studio-link-path");
    visiblePath.dataset.edgeId = edgeId;
    group.appendChild(visiblePath);

    const chevron = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    chevron.setAttribute("class", "ss-studio-link-chevron");
    group.appendChild(chevron);

    return { group, hitPath, visiblePath, chevron };
  }

  private applyEdgeStatus(group: EdgeGroupElements, edge: EdgeState): void {
    group.group.dataset.status = edge.status;
  }

  private renderPreview(getCursorAnchorPoint: () => { x: number; y: number } | null): void {
    const { layer, store, resolvePortAnchorPoint } = this.options;
    const drag = store.getDragState();
    if (!drag) {
      if (this.previewPath && this.previewPath.parentNode) {
        this.previewPath.parentNode.removeChild(this.previewPath);
      }
      this.previewPath = null;
      return;
    }

    const source = resolvePortAnchorPoint(drag.source, "out");
    if (!source) {
      return;
    }

    let end = drag.snapTarget
      ? resolvePortAnchorPoint(drag.snapTarget, "in")
      : getCursorAnchorPoint();
    if (!end) {
      end = { x: drag.cursorWorld.x, y: drag.cursorWorld.y };
    }

    const curve = buildCubicLinkCurve(source, end);
    if (!this.previewPath) {
      this.previewPath = document.createElementNS(SVG_NS, "path") as SVGPathElement;
      this.previewPath.setAttribute("class", "ss-studio-link-preview");
    }
    this.previewPath.setAttribute("d", curve.path);
    this.previewPath.dataset.validity = drag.validity;
    if (this.previewPath.parentNode !== layer) {
      layer.appendChild(this.previewPath);
    }
  }
}
