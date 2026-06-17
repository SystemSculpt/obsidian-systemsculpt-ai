import { buildCubicLinkCurve, buildChevronPath, curveTangentAtEnd } from "./LinkGeometry";
import type { PortAnchor, StudioLinkStore, EdgeState } from "./StudioLinkStore";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Brand-new Studio edge renderer (replaces the legacy StudioLinkRenderer).
 *
 * Design goals after the legacy line system failed to render at all:
 *  1. CSS-immune visibility — every visual property (stroke, width, opacity,
 *     fill) is set INLINE on the element. No dependency on `.ss-studio-link-*`
 *     stylesheet rules, several of which could hide lines (e.g. a stuck
 *     `is-zoomed-micro` viewport class sets `display:none` on link paths).
 *  2. Fresh class names (`ss-studio-edge*`) so no legacy rule can match.
 *  3. Geometry comes from the caller's data-driven anchor resolver, so a line
 *     is drawn whenever both endpoint nodes exist — independent of DOM
 *     measurement, paint timing, or visibility.
 *
 * The element shape (group → hit/visible/arrow paths) matches what the flow
 * animator expects via getEdgeGroupElement().
 */

export type EdgeGroupElements = {
  group: SVGGElement;
  hitPath: SVGPathElement;
  visiblePath: SVGPathElement;
  arrowPath: SVGPathElement;
};

export type EdgePortAnchorResolver = (
  anchor: PortAnchor,
  direction: "in" | "out"
) => { x: number; y: number } | null;

export type StudioEdgeRendererOptions = {
  store: StudioLinkStore;
  layer: SVGSVGElement;
  resolvePortAnchorPoint: EdgePortAnchorResolver;
  getCursorAnchorPoint: () => { x: number; y: number } | null;
};

const EDGE_STROKE_WIDTH = 1.6;
const HIT_STROKE_WIDTH = 14;

// Status → stroke colour. CSS vars keep theme adaptivity, but every entry has a
// concrete fallback so a line is NEVER invisible even if the var is undefined.
function strokeForStatus(status: EdgeState["status"]): string {
  switch (status) {
    case "flowing":
      return "var(--ss-studio-link-flow-a, var(--interactive-accent, #5b8def))";
    case "completed":
      return "var(--ss-studio-link-flow-b, var(--interactive-accent, #5b8def))";
    case "failed":
      return "var(--ss-studio-link-failed, var(--text-error, #e0566a))";
    case "idle":
    default:
      return "var(--ss-studio-link-stroke, var(--text-muted, #8a8a8a))";
  }
}

function previewStroke(validity: string): string {
  switch (validity) {
    case "valid":
      return "var(--interactive-accent, #5b8def)";
    case "near":
      return "var(--interactive-accent, #5b8def)";
    case "invalid":
    default:
      return "var(--ss-studio-link-stroke, var(--text-muted, #8a8a8a))";
  }
}

export class StudioEdgeRenderer {
  private readonly groupsByEdgeId = new Map<string, EdgeGroupElements>();
  private previewPath: SVGPathElement | null = null;

  constructor(private readonly options: StudioEdgeRendererOptions) {}

  getEdgeGroupElement(edgeId: string): SVGGElement | null {
    return this.groupsByEdgeId.get(edgeId)?.group ?? null;
  }

  render(): void {
    const { layer, store, resolvePortAnchorPoint, getCursorAnchorPoint } = this.options;
    const seen = new Set<string>();

    for (const edge of store.listEdges()) {
      const source = resolvePortAnchorPoint(edge.source, "out");
      const target = resolvePortAnchorPoint(edge.target, "in");
      if (!source || !target) {
        continue;
      }
      const curve = buildCubicLinkCurve(source, target);
      const arrow = buildChevronPath(target, curveTangentAtEnd(curve), 6.5);

      let group = this.groupsByEdgeId.get(edge.id);
      if (!group) {
        group = this.createEdgeGroup(edge.id);
        this.groupsByEdgeId.set(edge.id, group);
        layer.appendChild(group.group);
      }

      this.applyEdgeStatus(group, edge);
      group.visiblePath.setAttribute("d", curve.path);
      group.hitPath.setAttribute("d", curve.path);
      group.arrowPath.setAttribute("d", arrow);
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
    if (this.previewPath?.parentNode) {
      this.previewPath.parentNode.removeChild(this.previewPath);
    }
    this.previewPath = null;
  }

  private createEdgeGroup(edgeId: string): EdgeGroupElements {
    const group = document.createElementNS(SVG_NS, "g") as SVGGElement;
    group.setAttribute("class", "ss-studio-edge-group");
    group.dataset.edgeId = edgeId;

    // Wide, transparent hit target for hover/right-click selection.
    const hitPath = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    hitPath.setAttribute("class", "ss-studio-edge-hit");
    hitPath.dataset.edgeId = edgeId;
    hitPath.style.fill = "none";
    hitPath.style.stroke = "transparent";
    hitPath.style.strokeWidth = String(HIT_STROKE_WIDTH);
    hitPath.style.strokeLinecap = "round";
    hitPath.style.pointerEvents = "stroke";
    hitPath.style.cursor = "pointer";
    group.appendChild(hitPath);

    const visiblePath = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    visiblePath.setAttribute("class", "ss-studio-edge-line");
    visiblePath.dataset.edgeId = edgeId;
    visiblePath.style.fill = "none";
    visiblePath.style.strokeWidth = String(EDGE_STROKE_WIDTH);
    visiblePath.style.strokeLinecap = "round";
    visiblePath.style.strokeLinejoin = "round";
    visiblePath.style.pointerEvents = "none";
    group.appendChild(visiblePath);

    const arrowPath = document.createElementNS(SVG_NS, "path") as SVGPathElement;
    arrowPath.setAttribute("class", "ss-studio-edge-arrow");
    arrowPath.style.fill = "none";
    arrowPath.style.strokeWidth = String(EDGE_STROKE_WIDTH);
    arrowPath.style.strokeLinecap = "round";
    arrowPath.style.strokeLinejoin = "round";
    arrowPath.style.pointerEvents = "none";
    group.appendChild(arrowPath);

    return { group, hitPath, visiblePath, arrowPath };
  }

  private applyEdgeStatus(group: EdgeGroupElements, edge: EdgeState): void {
    group.group.dataset.status = edge.status;
    const stroke = strokeForStatus(edge.status);
    const opacity = edge.status === "idle" ? "0.85" : "1";
    group.visiblePath.style.stroke = stroke;
    group.visiblePath.style.opacity = opacity;
    group.arrowPath.style.stroke = stroke;
    group.arrowPath.style.opacity = opacity;
  }

  private renderPreview(getCursorAnchorPoint: () => { x: number; y: number } | null): void {
    const { layer, store, resolvePortAnchorPoint } = this.options;
    const drag = store.getDragState();
    if (!drag) {
      if (this.previewPath?.parentNode) {
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
      this.previewPath.setAttribute("class", "ss-studio-edge-preview");
      this.previewPath.style.fill = "none";
      this.previewPath.style.strokeWidth = "2.2";
      this.previewPath.style.strokeLinecap = "round";
      this.previewPath.style.strokeLinejoin = "round";
      this.previewPath.style.opacity = "0.95";
      this.previewPath.style.pointerEvents = "none";
    }
    this.previewPath.style.stroke = previewStroke(drag.validity);
    this.previewPath.style.strokeDasharray = drag.validity === "valid" ? "none" : "6 6";
    this.previewPath.setAttribute("d", curve.path);
    this.previewPath.dataset.validity = drag.validity;
    if (this.previewPath.parentNode !== layer) {
      layer.appendChild(this.previewPath);
    }
  }
}
