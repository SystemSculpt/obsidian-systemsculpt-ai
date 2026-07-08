import type { StudioSnapGapBadge, StudioSnapGuideLine } from "./StudioGraphSnapGuides";

/**
 * Renders smart-guide lines and gap-distance badges into the snap-guides
 * layer. The layer lives inside the scrollable viewport content layer (same
 * as the marquee), so all coordinates are content-space: graph units
 * multiplied by the current zoom. Line thickness and badge size stay in
 * screen pixels by design — only positions scale.
 */
export function renderStudioGraphSnapGuidesLayer(
  layer: HTMLElement,
  result: { guides: StudioSnapGuideLine[]; gaps: StudioSnapGapBadge[] } | null,
  zoom: number
): void {
  while (layer.firstChild) {
    layer.removeChild(layer.firstChild);
  }
  if (!result || (result.guides.length === 0 && result.gaps.length === 0)) {
    return;
  }

  const doc = layer.ownerDocument;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;

  for (const guide of result.guides) {
    const line = doc.createElement("div");
    line.className = `ss-studio-snap-guide ${guide.axis === "x" ? "is-vertical" : "is-horizontal"}`;
    const length = Math.max(0, (guide.end - guide.start) * scale);
    if (guide.axis === "x") {
      line.style.left = `${guide.position * scale}px`;
      line.style.top = `${guide.start * scale}px`;
      line.style.height = `${length}px`;
    } else {
      line.style.left = `${guide.start * scale}px`;
      line.style.top = `${guide.position * scale}px`;
      line.style.width = `${length}px`;
    }
    layer.appendChild(line);
  }

  for (const gap of result.gaps) {
    const span = doc.createElement("div");
    span.className = `ss-studio-snap-gap-span ${gap.axis === "x" ? "is-horizontal" : "is-vertical"}`;
    const length = Math.max(0, (gap.end - gap.start) * scale);
    if (gap.axis === "x") {
      span.style.left = `${gap.start * scale}px`;
      span.style.top = `${gap.cross * scale}px`;
      span.style.width = `${length}px`;
    } else {
      span.style.left = `${gap.cross * scale}px`;
      span.style.top = `${gap.start * scale}px`;
      span.style.height = `${length}px`;
    }
    layer.appendChild(span);

    const badge = doc.createElement("div");
    badge.className = "ss-studio-snap-gap-badge";
    badge.textContent = gap.label;
    const mid = ((gap.start + gap.end) / 2) * scale;
    if (gap.axis === "x") {
      badge.style.left = `${mid}px`;
      badge.style.top = `${gap.cross * scale}px`;
    } else {
      badge.style.left = `${gap.cross * scale}px`;
      badge.style.top = `${mid}px`;
    }
    layer.appendChild(badge);
  }
}
