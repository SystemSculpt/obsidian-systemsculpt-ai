import type { StudioNodeInstance } from "../../../studio/types";
import type {
  StudioGraphNodeMutationOptions,
  StudioGraphNodeResizePatch,
} from "./StudioGraphNodeCardTypes";
import {
  clampStudioNodeDimension,
  resolveStudioCanvasDelta,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeResizeBounds,
  resolveStudioGraphNodeWidth,
  resolveStudioNodeResizeSemantics,
  resolveStudioTextNodeFontSize,
  STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
  STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
  type StudioNodeResizeMode,
} from "../../../studio/StudioNodeGeometry";

/**
 * tldraw-style 8-zone resize frame: four edge strips plus four corner zones
 * on every resizable node card. One shared implementation for every card
 * type — per-kind behavior comes from the geometry module's declarative
 * resize semantics (resolveStudioNodeResizeSemantics), never from per-card
 * branching here.
 *
 * Interaction hardening carried over from the single-handle era (#284):
 * pointer capture with window-listener fallback, rAF-batched application
 * with synchronous-rAF (jsdom) tolerance, local last-applied tracking
 * instead of stale model reads, start-clamp to bounds, continuous commits
 * with history captured on the first mutating frame only, and a discrete
 * commit on release.
 */

export type StudioGraphResizeZone = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

/** Edges first, corners last: corners stack above edges. */
export const STUDIO_GRAPH_RESIZE_ZONES: readonly StudioGraphResizeZone[] = [
  "n",
  "s",
  "e",
  "w",
  "nw",
  "ne",
  "sw",
  "se",
];

/** Thickness of the edge hit strips (straddles the card border). */
export const STUDIO_GRAPH_RESIZE_EDGE_HIT_PX = 6;
/** Side length of the square corner hit zones. */
export const STUDIO_GRAPH_RESIZE_CORNER_HIT_PX = 12;

/**
 * Mirror of the canvas position floor applied by the node-drag path in
 * StudioGraphSelectionController.
 */
const STUDIO_GRAPH_MIN_NODE_CANVAS_POSITION = 24;

/** Guard against inverted/degenerate scale factors on text drags. */
const STUDIO_GRAPH_MIN_TEXT_SCALE = 0.05;

export type StudioGraphResizeZoneDirection = {
  /** -1 = west edge participates, 1 = east edge, 0 = neither. */
  x: -1 | 0 | 1;
  /** -1 = north edge participates, 1 = south edge, 0 = neither. */
  y: -1 | 0 | 1;
};

type ZoneDirection = StudioGraphResizeZoneDirection;

const ZONE_DIRECTIONS: Readonly<Record<StudioGraphResizeZone, ZoneDirection>> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
  nw: { x: -1, y: -1 },
  ne: { x: 1, y: -1 },
  sw: { x: -1, y: 1 },
  se: { x: 1, y: 1 },
};

/**
 * The one zone→axis mapping. The single-node frame and the multi-select
 * selection frame both derive their edge/corner anchoring from this map so
 * the two affordances can never disagree about what a zone means.
 */
export function resolveStudioGraphResizeZoneDirection(
  zone: StudioGraphResizeZone
): StudioGraphResizeZoneDirection {
  return ZONE_DIRECTIONS[zone];
}

/**
 * Zone hit geometry, declared as data so tests can prove the carving:
 * edge strips are inset by the corner hit size on both ends, so corners take
 * precedence over edges by construction — the zones never overlap and no
 * z-index tie-breaking is needed for correctness.
 */
export function resolveStudioGraphResizeZoneLayout(
  zone: StudioGraphResizeZone
): Record<string, string> {
  const edge = `${STUDIO_GRAPH_RESIZE_EDGE_HIT_PX}px`;
  const edgeOffset = `${-STUDIO_GRAPH_RESIZE_EDGE_HIT_PX / 2}px`;
  const corner = `${STUDIO_GRAPH_RESIZE_CORNER_HIT_PX}px`;
  switch (zone) {
    case "n":
      return { left: corner, right: corner, top: edgeOffset, height: edge };
    case "s":
      return { left: corner, right: corner, bottom: edgeOffset, height: edge };
    case "e":
      return { top: corner, bottom: corner, right: edgeOffset, width: edge };
    case "w":
      return { top: corner, bottom: corner, left: edgeOffset, width: edge };
    case "nw":
      return { top: edgeOffset, left: edgeOffset, width: corner, height: corner };
    case "ne":
      return { top: edgeOffset, right: edgeOffset, width: corner, height: corner };
    case "sw":
      return { bottom: edgeOffset, left: edgeOffset, width: corner, height: corner };
    case "se":
      return { bottom: edgeOffset, right: edgeOffset, width: corner, height: corner };
  }
}

type StudioGraphResizeFrameSize = {
  width: number;
  /**
   * Explicit height to apply, or null when the card's height is not an
   * explicit lever for this drag (text reflow / aspect-driven media).
   */
  height: number | null;
};

type MountStudioGraphNodeResizeFrameOptions = {
  node: StudioNodeInstance;
  nodeEl: HTMLElement;
  title: string;
  ariaLabel: string;
  interactionLocked: boolean;
  getGraphZoom: () => number;
  /**
   * True when the card body is an image/video media preview whose rendered
   * height follows the intrinsic aspect ratio (`height: auto` CSS).
   */
  hasAspectMediaContent?: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  /** Pure fontSize commits (text bottom-edge drags) ride the config path. */
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: string | number,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  /** Atomic geometry commits: size and/or position and/or fontSize. */
  onNodeResize?: (
    nodeId: string,
    patch: StudioGraphNodeResizePatch,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  onNodeGeometryMutated: (node: StudioNodeInstance) => void;
  applySize: (size: StudioGraphResizeFrameSize) => void;
  /** Live fontSize preview while a text drag is in flight. */
  applyFontSize?: (fontSizePx: number) => void;
  readInitialSize?: () => { width: number; height: number };
  readFontSize?: () => number;
};

type ResizeTargetState = {
  width: number;
  height: number;
  fontSize: number;
  x: number;
  y: number;
  writesWidth: boolean;
  writesHeight: boolean;
  writesFontSize: boolean;
  writesPosition: boolean;
};

function readInitialSizeFromNode(
  node: StudioNodeInstance,
  nodeEl: HTMLElement
): { width: number; height: number } {
  const measuredWidth = nodeEl.offsetWidth;
  const measuredHeight = nodeEl.offsetHeight;
  return {
    width: measuredWidth > 0 ? measuredWidth : resolveStudioGraphNodeWidth(node),
    height:
      measuredHeight > 0 ? measuredHeight : Math.max(resolveStudioGraphNodeMinHeight(node), 1),
  };
}

function floorCanvasPosition(value: number): number {
  return Math.max(STUDIO_GRAPH_MIN_NODE_CANVAS_POSITION, Math.round(value));
}

export function mountStudioGraphNodeResizeFrame(
  options: MountStudioGraphNodeResizeFrameOptions
): () => void {
  const { node, nodeEl } = options;
  nodeEl.addClass("has-resize-frame");

  const zoneEls = new Map<StudioGraphResizeZone, HTMLElement>();
  for (const zone of STUDIO_GRAPH_RESIZE_ZONES) {
    const isCorner = zone.length === 2;
    const zoneEl = nodeEl.createDiv({
      cls: [
        "ss-studio-node-resize-zone",
        `is-zone-${zone}`,
        isCorner ? "is-corner" : "is-edge",
      ].join(" "),
      attr: {
        title: options.title,
        "aria-label": options.ariaLabel,
        "data-resize-zone": zone,
      },
    });
    for (const [property, value] of Object.entries(resolveStudioGraphResizeZoneLayout(zone))) {
      zoneEl.style.setProperty(property, value);
    }
    zoneEl.classList.toggle("is-disabled", options.interactionLocked);
    zoneEls.set(zone, zoneEl);
  }

  const removeFrame = (): void => {
    nodeEl.removeClass("has-resize-frame");
    for (const zoneEl of zoneEls.values()) {
      zoneEl.remove();
    }
  };

  if (options.interactionLocked) {
    return removeFrame;
  }

  const semanticsMode: StudioNodeResizeMode = resolveStudioNodeResizeSemantics(node.kind, {
    hasAspectMediaContent: options.hasAspectMediaContent,
  });

  let activePointerId: number | null = null;
  let activeZoneEl: HTMLElement | null = null;
  let activeDirection: ZoneDirection = { x: 0, y: 0 };
  let dragMode: StudioNodeResizeMode = semanticsMode;
  let dragAspect = 1;
  let frameId: number | null = null;
  let startClientX = 0;
  let startClientY = 0;
  let startWidth = 0;
  let startHeight = 0;
  let startFontSize = STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE;
  let startX = 0;
  let startY = 0;
  let pendingDeltaX = 0;
  let pendingDeltaY = 0;
  let lastApplied: ResizeTargetState | null = null;
  let didMutateDuringDrag = false;
  let capturedHistoryForDrag = false;

  const computeTarget = (): ResizeTargetState => {
    const direction = activeDirection;
    const bounds = resolveStudioGraphNodeResizeBounds(node);
    const dw = direction.x === 0 ? 0 : direction.x * pendingDeltaX;
    const dh = direction.y === 0 ? 0 : direction.y * pendingDeltaY;

    if (dragMode === "box" || dragMode === "min-height") {
      const width =
        direction.x !== 0
          ? clampStudioNodeDimension(startWidth + dw, bounds.minWidth, bounds.maxWidth)
          : startWidth;
      const height =
        direction.y !== 0
          ? clampStudioNodeDimension(startHeight + dh, bounds.minHeight, bounds.maxHeight)
          : startHeight;
      return {
        width,
        height,
        fontSize: startFontSize,
        x: direction.x === -1 ? floorCanvasPosition(startX + (startWidth - width)) : startX,
        y: direction.y === -1 ? floorCanvasPosition(startY + (startHeight - height)) : startY,
        writesWidth: direction.x !== 0,
        writesHeight: direction.y !== 0,
        writesFontSize: false,
        writesPosition: direction.x === -1 || direction.y === -1,
      };
    }

    if (dragMode === "aspect-width") {
      // Width is the single lever; vertical travel converts through the
      // rendered aspect measured at drag start.
      const widthDeltaFromX = dw;
      const widthDeltaFromY = dh * dragAspect;
      const widthDelta =
        direction.x !== 0 && direction.y !== 0
          ? Math.abs(widthDeltaFromX) >= Math.abs(widthDeltaFromY)
            ? widthDeltaFromX
            : widthDeltaFromY
          : direction.x !== 0
            ? widthDeltaFromX
            : widthDeltaFromY;
      const width = clampStudioNodeDimension(
        startWidth + widthDelta,
        bounds.minWidth,
        bounds.maxWidth
      );
      const impliedHeight = Math.round(width / dragAspect);
      return {
        width,
        height: startHeight,
        fontSize: startFontSize,
        x: direction.x === -1 ? floorCanvasPosition(startX + (startWidth - width)) : startX,
        y:
          direction.y === -1
            ? floorCanvasPosition(startY + (startHeight - impliedHeight))
            : startY,
        writesWidth: true,
        writesHeight: false,
        writesFontSize: false,
        writesPosition: direction.x === -1 || direction.y === -1,
      };
    }

    // dragMode === "text"
    const safeStartWidth = startWidth > 0 ? startWidth : 1;
    const safeStartHeight = startHeight > 0 ? startHeight : 1;
    if (direction.x !== 0 && direction.y === 0) {
      // Side drag: wrap width only — height reflows intrinsically.
      const width = clampStudioNodeDimension(startWidth + dw, bounds.minWidth, bounds.maxWidth);
      return {
        width,
        height: startHeight,
        fontSize: startFontSize,
        x: direction.x === -1 ? floorCanvasPosition(startX + (startWidth - width)) : startX,
        y: startY,
        writesWidth: true,
        writesHeight: false,
        writesFontSize: false,
        writesPosition: direction.x === -1,
      };
    }

    const scaleY = Math.max((safeStartHeight + dh) / safeStartHeight, STUDIO_GRAPH_MIN_TEXT_SCALE);
    if (direction.x === 0) {
      // Vertical drag: scale the type by the rendered-height ratio.
      const fontSize = clampStudioNodeDimension(
        startFontSize * scaleY,
        STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
        STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE
      );
      const predictedHeight = Math.round(safeStartHeight * (fontSize / startFontSize));
      return {
        width: startWidth,
        height: startHeight,
        fontSize,
        x: startX,
        y:
          direction.y === -1
            ? floorCanvasPosition(startY + (safeStartHeight - predictedHeight))
            : startY,
        writesWidth: false,
        writesHeight: false,
        writesFontSize: true,
        writesPosition: direction.y === -1,
      };
    }

    // Corner drag: proportional visual zoom — fontSize and wrap width scale
    // by the same factor so the wrap layout is preserved.
    const scaleX = Math.max((safeStartWidth + dw) / safeStartWidth, STUDIO_GRAPH_MIN_TEXT_SCALE);
    const rawScale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
    const fontSize = clampStudioNodeDimension(
      startFontSize * rawScale,
      STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
      STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE
    );
    const fontScale = fontSize / startFontSize;
    const width = clampStudioNodeDimension(
      startWidth * fontScale,
      bounds.minWidth,
      bounds.maxWidth
    );
    const predictedHeight = Math.round(safeStartHeight * fontScale);
    return {
      width,
      height: startHeight,
      fontSize,
      x: direction.x === -1 ? floorCanvasPosition(startX + (startWidth - width)) : startX,
      y:
        direction.y === -1
          ? floorCanvasPosition(startY + (safeStartHeight - predictedHeight))
          : startY,
      writesWidth: true,
      writesHeight: false,
      writesFontSize: true,
      writesPosition: direction.x === -1 || direction.y === -1,
    };
  };

  const buildPatch = (target: ResizeTargetState): StudioGraphNodeResizePatch => {
    const patch: StudioGraphNodeResizePatch = {};
    if (target.writesWidth || target.writesHeight) {
      patch.size = {
        ...(target.writesWidth ? { width: target.width } : {}),
        ...(target.writesHeight ? { height: target.height } : {}),
      };
    }
    if (target.writesPosition) {
      patch.position = { x: target.x, y: target.y };
    }
    if (target.writesFontSize) {
      patch.fontSize = target.fontSize;
    }
    return patch;
  };

  const targetsEqual = (a: ResizeTargetState, b: ResizeTargetState): boolean =>
    a.width === b.width &&
    a.height === b.height &&
    a.fontSize === b.fontSize &&
    a.x === b.x &&
    a.y === b.y;

  const applyTargetToDom = (target: ResizeTargetState): void => {
    if (target.writesWidth || target.writesHeight) {
      options.applySize({
        width: target.width,
        height: target.writesHeight ? target.height : null,
      });
    }
    if (target.writesFontSize && options.applyFontSize) {
      options.applyFontSize(target.fontSize);
    }
    if (target.writesPosition) {
      nodeEl.style.transform = `translate(${target.x}px, ${target.y}px)`;
    }
  };

  const commitTarget = (target: ResizeTargetState, mode: "continuous" | "discrete"): void => {
    const patch = buildPatch(target);
    const mutationOptions: StudioGraphNodeMutationOptions = {
      mode,
      captureHistory: mode === "continuous" && !capturedHistoryForDrag,
    };
    const pureFontSize =
      target.writesFontSize &&
      !target.writesWidth &&
      !target.writesHeight &&
      !target.writesPosition;

    if (pureFontSize && options.onNodeConfigValueChange) {
      options.onNodeConfigValueChange(node.id, "fontSize", target.fontSize, mutationOptions);
    } else if (options.onNodeResize) {
      options.onNodeResize(node.id, patch, mutationOptions);
    } else {
      // Direct-fallback path (no resize host wired): write the first-class
      // geometry fields, never legacy config geometry.
      if (patch.size) {
        node.size = {
          ...node.size,
          ...(patch.size.width !== undefined ? { width: patch.size.width } : {}),
          ...(patch.size.height !== undefined ? { height: patch.size.height } : {}),
        } as NonNullable<StudioNodeInstance["size"]>;
      }
      if (patch.position) {
        node.position.x = patch.position.x;
        node.position.y = patch.position.y;
      }
      if (patch.fontSize !== undefined) {
        node.config.fontSize = patch.fontSize;
      }
      if (mode === "continuous") {
        options.onNodeGeometryMutated(node);
      } else {
        options.onNodeConfigMutated(node);
      }
    }
    if (mode === "continuous") {
      capturedHistoryForDrag = true;
      didMutateDuringDrag = true;
    }
  };

  const applyPendingFrame = (): void => {
    frameId = null;
    if (activePointerId === null) {
      return;
    }
    const target = computeTarget();
    if (lastApplied && targetsEqual(lastApplied, target)) {
      return;
    }
    applyTargetToDom(target);
    lastApplied = target;
    commitTarget(target, "continuous");
  };

  const scheduleApply = (): void => {
    if (frameId !== null) {
      return;
    }
    let frameFiredSynchronously = false;
    frameId = window.requestAnimationFrame(() => {
      frameFiredSynchronously = true;
      applyPendingFrame();
    });
    if (frameFiredSynchronously) {
      frameId = null;
    }
  };

  const stopTracking = (): void => {
    if (activePointerId === null) {
      return;
    }
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
      applyPendingFrame();
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerFinish);
    window.removeEventListener("pointercancel", onPointerFinish);
    const zoneEl = activeZoneEl;
    const pointerId = activePointerId;
    activePointerId = null;
    activeZoneEl = null;
    if (zoneEl) {
      zoneEl.classList.remove("is-active");
      if (typeof zoneEl.releasePointerCapture === "function") {
        try {
          zoneEl.releasePointerCapture(pointerId);
        } catch {
          // Ignore release errors from detached pointers.
        }
      }
    }
    if (didMutateDuringDrag && lastApplied) {
      commitTarget(lastApplied, "discrete");
    }
    lastApplied = null;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointerId === null || event.pointerId !== activePointerId) {
      return;
    }
    const delta = resolveStudioCanvasDelta({
      startClientX,
      startClientY,
      clientX: event.clientX,
      clientY: event.clientY,
      zoom: options.getGraphZoom(),
    });
    pendingDeltaX = delta.deltaX;
    pendingDeltaY = delta.deltaY;
    scheduleApply();
  };

  const onPointerFinish = (event: PointerEvent): void => {
    if (activePointerId === null || event.pointerId !== activePointerId) {
      return;
    }
    stopTracking();
  };

  const startDrag = (zone: StudioGraphResizeZone, zoneEl: HTMLElement, event: PointerEvent): void => {
    if (event.button !== 0 || activePointerId !== null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    activePointerId = event.pointerId;
    activeZoneEl = zoneEl;
    activeDirection = ZONE_DIRECTIONS[zone];
    didMutateDuringDrag = false;
    capturedHistoryForDrag = false;
    startClientX = event.clientX;
    startClientY = event.clientY;
    pendingDeltaX = 0;
    pendingDeltaY = 0;

    const initialSize = options.readInitialSize
      ? options.readInitialSize()
      : readInitialSizeFromNode(node, nodeEl);
    const bounds = resolveStudioGraphNodeResizeBounds(node);
    startWidth = clampStudioNodeDimension(initialSize.width, bounds.minWidth, bounds.maxWidth);
    startHeight = clampStudioNodeDimension(initialSize.height, bounds.minHeight, bounds.maxHeight);
    startX = node.position.x;
    startY = node.position.y;
    startFontSize = options.readFontSize
      ? clampStudioNodeDimension(
          options.readFontSize(),
          STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
          STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE
        )
      : resolveStudioTextNodeFontSize(node);

    dragMode = semanticsMode;
    if (dragMode === "aspect-width") {
      // Measure the rendered card at drag start; without a usable
      // measurement (jsdom, detached layout) degrade to generic semantics.
      const measuredWidth = nodeEl.offsetWidth;
      const measuredHeight = nodeEl.offsetHeight;
      if (measuredWidth > 0 && measuredHeight > 0) {
        dragAspect = measuredWidth / measuredHeight;
      } else {
        dragMode = "min-height";
      }
    }

    lastApplied = {
      width: startWidth,
      height: startHeight,
      fontSize: startFontSize,
      x: startX,
      y: startY,
      writesWidth: false,
      writesHeight: false,
      writesFontSize: false,
      writesPosition: false,
    };
    zoneEl.classList.add("is-active");
    if (typeof zoneEl.setPointerCapture === "function") {
      try {
        zoneEl.setPointerCapture(activePointerId);
      } catch {
        // Ignore capture errors; window listeners are fallback.
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerFinish);
    window.addEventListener("pointercancel", onPointerFinish);
  };

  const zoneListeners = new Map<HTMLElement, (event: PointerEvent) => void>();
  for (const [zone, zoneEl] of zoneEls) {
    const listener = (event: PointerEvent): void => startDrag(zone, zoneEl, event);
    zoneEl.addEventListener("pointerdown", listener);
    zoneListeners.set(zoneEl, listener);
  }

  return () => {
    for (const [zoneEl, listener] of zoneListeners) {
      zoneEl.removeEventListener("pointerdown", listener);
    }
    stopTracking();
    removeFrame();
  };
}
