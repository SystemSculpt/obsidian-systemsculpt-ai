import { buildCubicLinkCurve, buildChevronPath, curveTangentAtEnd } from "./LinkGeometry";
import type { PortAnchor, StudioLinkStore } from "./StudioLinkStore";
import { createStudioSvgElement } from "../StudioDomContext";
import type { StudioEdgeActivityPhase } from "../activity/StudioActivity";
import { pulseStudioActivityElement } from "../activity/StudioActivityDomApplier";

/**
 * Canonical Studio edge renderer.
 *
 * Rendering invariants:
 *  1. Visibility is inline — the base line's stroke is set INLINE through
 *     `--ss-studio-edge-stroke` with concrete fallbacks, so a line is never
 *     invisible because of a stylesheet regression. Activity colors, the
 *     glow, the energy dots, and every animation live on the
 *     `.ss-studio-edge-*` rules in views/studio/activity.css and
 *     views/studio/connections.css.
 *  2. Edge classes are exclusively `ss-studio-edge*`, keeping their styling
 *     contract local to the connection implementation.
 *  3. Geometry comes from the caller's data-driven anchor resolver, so a line
 *     is drawn whenever both endpoint nodes exist — independent of DOM
 *     measurement, paint timing, or visibility. A render resolves every
 *     anchor before it writes any path, so measuring forces one layout at
 *     most, and it leaves a path whose geometry didn't change untouched.
 *  4. Run activity is not stored here. Each group carries `data-activity`
 *     from the activity snapshot; groups persist across geometry renders,
 *     and a freshly created group asks `resolveEdgeActivity` so a lazily
 *     rendered cable is right on first paint.
 */

export type EdgeGroupElements = {
  group: SVGGElement;
  hitPath: SVGPathElement;
  glowPath: SVGPathElement;
  visiblePath: SVGPathElement;
  energyPath: SVGPathElement;
  arrowPath: SVGPathElement;
};

export type EdgePortAnchorResolver = (
  anchor: PortAnchor,
  direction: "in" | "out"
) => { x: number; y: number } | null;

export type StudioEdgeRendererOptions = {
  store: StudioLinkStore;
  layer: SVGSVGElement;
  /** Called once per render; the resolver it returns serves that render's anchors. */
  createPortAnchorResolver: () => EdgePortAnchorResolver;
  getCursorAnchorPoint: () => { x: number; y: number } | null;
  resolveEdgeActivity?: (edgeId: string) => StudioEdgeActivityPhase;
};

// Every entry has a concrete fallback so a line is NEVER invisible even if
// the theme vars are undefined.
const BASE_STROKE = "var(--ss-studio-edge-stroke, var(--ss-studio-link-stroke, var(--text-muted, #8a8a8a)))";

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
  /** The geometry each group last drew. */
  private readonly drawnByEdgeId = new Map<string, { path: string; arrow: string }>();
  private previewPath: SVGPathElement | null = null;

  constructor(private readonly options: StudioEdgeRendererOptions) {}

  getEdgeGroupElement(edgeId: string): SVGGElement | null {
    return this.groupsByEdgeId.get(edgeId)?.group ?? null;
  }

  render(): void {
    const { layer, store, getCursorAnchorPoint } = this.options;
    const resolvePortAnchorPoint = this.options.createPortAnchorResolver();
    const next: Array<{ edgeId: string; path: string; arrow: string }> = [];
    for (const edge of store.listEdges()) {
      const source = resolvePortAnchorPoint(edge.source, "out");
      const target = resolvePortAnchorPoint(edge.target, "in");
      if (!source || !target) {
        continue;
      }
      const curve = buildCubicLinkCurve(source, target);
      next.push({ edgeId: edge.id, path: curve.path, arrow: buildChevronPath(target, curveTangentAtEnd(curve), 6.5) });
    }
    const preview = this.resolvePreview(resolvePortAnchorPoint, getCursorAnchorPoint);

    const seen = new Set<string>();
    for (const { edgeId, path, arrow } of next) {
      let group = this.groupsByEdgeId.get(edgeId);
      if (!group) {
        group = this.createEdgeGroup(edgeId);
        this.groupsByEdgeId.set(edgeId, group);
        layer.appendChild(group.group);
        this.applyEdgeActivity(edgeId, this.options.resolveEdgeActivity?.(edgeId) ?? "idle");
      }
      const drawn = this.drawnByEdgeId.get(edgeId);
      if (drawn?.path !== path) {
        group.visiblePath.setAttribute("d", path);
        group.hitPath.setAttribute("d", path);
        group.glowPath.setAttribute("d", path);
        group.energyPath.setAttribute("d", path);
      }
      if (drawn?.arrow !== arrow) group.arrowPath.setAttribute("d", arrow);
      this.drawnByEdgeId.set(edgeId, { path, arrow });
      seen.add(edgeId);
    }

    for (const [edgeId, group] of this.groupsByEdgeId) {
      if (seen.has(edgeId)) continue;
      group.group.remove();
      this.groupsByEdgeId.delete(edgeId);
      this.drawnByEdgeId.delete(edgeId);
    }

    this.renderPreview(preview);
  }

  /** Stamp a cable's phase; `pulse` marks a real transition for one-shot emphasis. */
  applyEdgeActivity(edgeId: string, phase: StudioEdgeActivityPhase, options?: { pulse?: boolean }): void {
    const group = this.groupsByEdgeId.get(edgeId);
    if (!group) return;
    group.group.dataset.activity = phase;
    if (options?.pulse) pulseStudioActivityElement(group.group, phase);
  }

  clear(): void {
    for (const group of this.groupsByEdgeId.values()) {
      group.group.remove();
    }
    this.groupsByEdgeId.clear();
    this.drawnByEdgeId.clear();
    if (this.previewPath?.parentNode) {
      this.previewPath.parentNode.removeChild(this.previewPath);
    }
    this.previewPath = null;
  }

  private createEdgeGroup(edgeId: string): EdgeGroupElements {
    const group = createStudioSvgElement(this.options.layer, "g");
    group.setAttribute("class", "ss-studio-edge-group");
    group.dataset.edgeId = edgeId;

    // Wide, transparent hit target for hover/right-click selection.
    // Static presentation for every path lives in views/studio/connections.css
    // and views/studio/activity.css.
    const hitPath = createStudioSvgElement(this.options.layer, "path");
    hitPath.setAttribute("class", "ss-studio-edge-hit");
    hitPath.dataset.edgeId = edgeId;
    group.appendChild(hitPath);

    // Soft halo under the line; only visible while power flows or has landed.
    const glowPath = createStudioSvgElement(this.options.layer, "path");
    glowPath.setAttribute("class", "ss-studio-edge-glow");
    group.appendChild(glowPath);

    const visiblePath = createStudioSvgElement(this.options.layer, "path");
    visiblePath.setAttribute("class", "ss-studio-edge-line");
    visiblePath.dataset.edgeId = edgeId;
    visiblePath.style.stroke = BASE_STROKE;
    group.appendChild(visiblePath);

    // Bright dashes that travel source → target while the source works.
    const energyPath = createStudioSvgElement(this.options.layer, "path");
    energyPath.setAttribute("class", "ss-studio-edge-energy");
    group.appendChild(energyPath);

    const arrowPath = createStudioSvgElement(this.options.layer, "path");
    arrowPath.setAttribute("class", "ss-studio-edge-arrow");
    arrowPath.style.stroke = BASE_STROKE;
    group.appendChild(arrowPath);

    return { group, hitPath, glowPath, visiblePath, energyPath, arrowPath };
  }

  private resolvePreview(
    resolvePortAnchorPoint: EdgePortAnchorResolver,
    getCursorAnchorPoint: () => { x: number; y: number } | null
  ): { path: string; validity: string } | null {
    const drag = this.options.store.getDragState();
    if (!drag) {
      return null;
    }
    const source = resolvePortAnchorPoint(drag.source, "out");
    if (!source) {
      return null;
    }
    let end = drag.snapTarget
      ? resolvePortAnchorPoint(drag.snapTarget, "in")
      : getCursorAnchorPoint();
    if (!end) {
      end = { x: drag.cursorWorld.x, y: drag.cursorWorld.y };
    }
    return { path: buildCubicLinkCurve(source, end).path, validity: drag.validity };
  }

  private renderPreview(preview: { path: string; validity: string } | null): void {
    const { layer, store } = this.options;
    if (!preview) {
      // A drag whose source can't be resolved keeps its last preview, as before.
      if (store.getDragState()) return;
      if (this.previewPath?.parentNode) {
        this.previewPath.parentNode.removeChild(this.previewPath);
      }
      this.previewPath = null;
      return;
    }

    if (!this.previewPath) {
      // Static presentation lives on .ss-studio-edge-preview in
      // views/studio/connections.css.
      this.previewPath = createStudioSvgElement(layer, "path");
      this.previewPath.setAttribute("class", "ss-studio-edge-preview");
    }
    this.previewPath.style.stroke = previewStroke(preview.validity);
    this.previewPath.style.strokeDasharray = preview.validity === "valid" ? "none" : "6 6";
    this.previewPath.setAttribute("d", preview.path);
    this.previewPath.dataset.validity = preview.validity;
    if (this.previewPath.parentNode !== layer) {
      layer.appendChild(this.previewPath);
    }
  }
}
