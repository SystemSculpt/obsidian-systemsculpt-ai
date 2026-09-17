import type { StudioDistanceBadge, StudioAlignmentGuideLine } from "./StudioGraphAlignmentGuides";

/**
 * Renders smart-guide lines and gap-distance badges into the alignment-guides
 * layer. The layer lives inside the scrollable viewport content layer (same
 * as the marquee), so all coordinates are scroll-box px: world units plus
 * the world origin, multiplied by the current zoom. Line thickness and badge
 * size stay in screen pixels by design — only positions scale.
 */
export function renderStudioGraphAlignmentGuidesLayer(
  layer: HTMLElement,
  result: { guides: StudioAlignmentGuideLine[]; gaps: StudioDistanceBadge[] } | null,
  zoom: number,
  origin: { x: number; y: number } = { x: 0, y: 0 }
): void {
  while (layer.firstChild) {
    layer.removeChild(layer.firstChild);
  }
  if (!result || (result.guides.length === 0 && result.gaps.length === 0)) {
    return;
  }

  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  for (const guide of result.guides) {
    const line = layer.createDiv();
    line.className = `ss-studio-alignment-guide ${guide.axis === "x" ? "is-vertical" : "is-horizontal"}`;
    const length = Math.max(0, (guide.end - guide.start) * scale);
    if (guide.axis === "x") {
      line.style.left = `${(guide.position + origin.x) * scale}px`;
      line.style.top = `${(guide.start + origin.y) * scale}px`;
      line.style.height = `${length}px`;
    } else {
      line.style.left = `${(guide.start + origin.x) * scale}px`;
      line.style.top = `${(guide.position + origin.y) * scale}px`;
      line.style.width = `${length}px`;
    }
    if (guide.offset !== undefined) {
      line.classList.add("is-near");
      const badge = layer.createDiv();
      badge.className = "ss-studio-distance-badge ss-studio-alignment-offset-badge";
      const distance = Math.round(Math.abs(guide.offset) * 10) / 10;
      badge.textContent = `${distance} px to align`;
      const cross = guide.labelCross ?? guide.end;
      badge.style.left = `${((guide.axis === "x" ? guide.position : cross) + origin.x) * scale}px`;
      badge.style.top = `${((guide.axis === "x" ? cross : guide.position) + origin.y) * scale}px`;
      layer.appendChild(badge);
    }
    layer.appendChild(line);
  }

  for (const gap of result.gaps) {
    const span = layer.createDiv();
    span.className = `ss-studio-distance-span ${gap.axis === "x" ? "is-horizontal" : "is-vertical"}`;
    const length = Math.max(0, (gap.end - gap.start) * scale);
    if (gap.axis === "x") {
      span.style.left = `${(gap.start + origin.x) * scale}px`;
      span.style.top = `${(gap.cross + origin.y) * scale}px`;
      span.style.width = `${length}px`;
    } else {
      span.style.left = `${(gap.cross + origin.x) * scale}px`;
      span.style.top = `${(gap.start + origin.y) * scale}px`;
      span.style.height = `${length}px`;
    }
    layer.appendChild(span);

    const badge = layer.createDiv();
    badge.className = "ss-studio-distance-badge";
    badge.textContent = gap.label;
    const midWorld = (gap.start + gap.end) / 2;
    if (gap.axis === "x") {
      badge.style.left = `${(midWorld + origin.x) * scale}px`;
      badge.style.top = `${(gap.cross + origin.y) * scale}px`;
    } else {
      badge.style.left = `${(gap.cross + origin.x) * scale}px`;
      badge.style.top = `${(midWorld + origin.y) * scale}px`;
    }
    layer.appendChild(badge);
  }
}
