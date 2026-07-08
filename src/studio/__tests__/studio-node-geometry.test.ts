import type { StudioNodeInstance } from "../types";
import {
  clampStudioNodeDimension,
  estimateStudioTextNodeHeight,
  resolveStudioCanvasDelta,
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeResizeBounds,
  resolveStudioGraphNodeWidth,
  resolveStudioGraphSafeZoom,
  resolveStudioNodeDefaultSize,
  resolveStudioNodeResizeSemantics,
  resolveStudioTextNodeFontSize,
  resolveStudioTextNodeHeight,
  resolveStudioTextNodeWidth,
  STUDIO_GRAPH_DEFAULT_NODE_HEIGHT,
  STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
  STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT,
  STUDIO_GRAPH_LARGE_TEXT_NODE_WIDTH,
  STUDIO_GRAPH_NODE_MIN_HEIGHT,
  STUDIO_GRAPH_NODE_MIN_WIDTH,
  STUDIO_GRAPH_TERMINAL_DEFAULT_HEIGHT,
  STUDIO_GRAPH_TERMINAL_DEFAULT_WIDTH,
  STUDIO_GRAPH_TERMINAL_MIN_HEIGHT,
  STUDIO_GRAPH_TERMINAL_MIN_WIDTH,
  STUDIO_GRAPH_TEXT_NODE_DEFAULT_HEIGHT,
  STUDIO_GRAPH_TEXT_NODE_MAX_HEIGHT,
  STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT,
  STUDIO_GRAPH_TEXT_NODE_MIN_WIDTH,
} from "../StudioNodeGeometry";

function createNode(
  kind: string,
  options: {
    config?: Record<string, unknown>;
    size?: { width: number; height: number };
  } = {}
): Pick<StudioNodeInstance, "kind" | "config" | "size"> {
  return {
    kind,
    config: (options.config ?? {}) as StudioNodeInstance["config"],
    ...(options.size ? { size: options.size } : {}),
  };
}

describe("clampStudioNodeDimension", () => {
  it("rounds and clamps into the given bounds", () => {
    expect(clampStudioNodeDimension(150.6, 100, 200)).toBe(151);
    expect(clampStudioNodeDimension(20, 100, 200)).toBe(100);
    expect(clampStudioNodeDimension(999, 100, 200)).toBe(200);
  });

  it("returns the minimum for non-finite input", () => {
    expect(clampStudioNodeDimension(Number.NaN, 100, 200)).toBe(100);
    expect(clampStudioNodeDimension(Number.POSITIVE_INFINITY, 100, 200)).toBe(100);
  });
});

describe("estimateStudioTextNodeHeight", () => {
  it("uses the canonical chrome + per-line formula", () => {
    // 46px chrome + 22px per line.
    expect(estimateStudioTextNodeHeight(12)).toBe(46 + 12 * 22);
  });

  it("clamps single lines up to the text-node minimum height", () => {
    expect(estimateStudioTextNodeHeight(1)).toBe(STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT);
  });

  it("clamps enormous line counts to the text-node maximum height", () => {
    expect(estimateStudioTextNodeHeight(500)).toBe(STUDIO_GRAPH_TEXT_NODE_MAX_HEIGHT);
  });

  it("treats invalid line counts as a single line", () => {
    expect(estimateStudioTextNodeHeight(Number.NaN)).toBe(STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT);
    expect(estimateStudioTextNodeHeight(0)).toBe(STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT);
  });
});

describe("resolveStudioNodeDefaultSize", () => {
  it("returns the regular default size for generic kinds", () => {
    expect(resolveStudioNodeDefaultSize("studio.http_request")).toEqual({
      width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
      height: STUDIO_GRAPH_DEFAULT_NODE_HEIGHT,
    });
  });

  it("returns the text default size for studio.text", () => {
    expect(resolveStudioNodeDefaultSize("studio.text")).toEqual({
      width: STUDIO_GRAPH_DEFAULT_NODE_WIDTH,
      height: STUDIO_GRAPH_TEXT_NODE_DEFAULT_HEIGHT,
    });
  });

  it("returns the terminal default size for studio.terminal", () => {
    expect(resolveStudioNodeDefaultSize("studio.terminal")).toEqual({
      width: STUDIO_GRAPH_TERMINAL_DEFAULT_WIDTH,
      height: STUDIO_GRAPH_TERMINAL_DEFAULT_HEIGHT,
    });
  });

  it("returns the large-layout default size for dataset and expanded kinds", () => {
    for (const kind of ["studio.dataset", "studio.text_generation", "studio.text_output"]) {
      expect(resolveStudioNodeDefaultSize(kind)).toEqual({
        width: STUDIO_GRAPH_LARGE_TEXT_NODE_WIDTH,
        height: STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT,
      });
    }
  });
});

describe("node width / min-height resolution", () => {
  it("prefers the first-class size field over everything else", () => {
    const node = createNode("studio.http_request", {
      size: { width: 500, height: 300 },
      config: { width: 900, height: 900 },
    });

    expect(resolveStudioGraphNodeWidth(node)).toBe(500);
    expect(resolveStudioGraphNodeMinHeight(node)).toBe(300);
  });

  it("falls back to legacy config geometry for not-yet-migrated in-memory graphs", () => {
    const node = createNode("studio.http_request", {
      config: { width: 540, height: 360 },
    });

    expect(resolveStudioGraphNodeWidth(node)).toBe(540);
    expect(resolveStudioGraphNodeMinHeight(node)).toBe(360);
  });

  it("clamps sized regular nodes to the shared bounds", () => {
    const node = createNode("studio.http_request", {
      size: { width: 90, height: 30 },
    });

    expect(resolveStudioGraphNodeWidth(node)).toBe(STUDIO_GRAPH_NODE_MIN_WIDTH);
    expect(resolveStudioGraphNodeMinHeight(node)).toBe(STUDIO_GRAPH_NODE_MIN_HEIGHT);
  });

  it("keeps terminal node sizing constrained to terminal bounds", () => {
    const node = createNode("studio.terminal", {
      size: { width: 120, height: 70 },
    });

    expect(resolveStudioGraphNodeWidth(node)).toBe(STUDIO_GRAPH_TERMINAL_MIN_WIDTH);
    expect(resolveStudioGraphNodeMinHeight(node)).toBe(STUDIO_GRAPH_TERMINAL_MIN_HEIGHT);
  });

  it("uses per-kind defaults when no size exists anywhere", () => {
    expect(resolveStudioGraphNodeWidth(createNode("studio.http_request"))).toBe(
      STUDIO_GRAPH_DEFAULT_NODE_WIDTH
    );
    // Unsized regular nodes keep auto content height (no forced minimum).
    expect(resolveStudioGraphNodeMinHeight(createNode("studio.http_request"))).toBe(0);
    expect(resolveStudioGraphNodeWidth(createNode("studio.terminal"))).toBe(
      STUDIO_GRAPH_TERMINAL_DEFAULT_WIDTH
    );
    expect(resolveStudioGraphNodeMinHeight(createNode("studio.terminal"))).toBe(
      STUDIO_GRAPH_TERMINAL_DEFAULT_HEIGHT
    );
    expect(resolveStudioGraphNodeWidth(createNode("studio.text_generation"))).toBe(
      STUDIO_GRAPH_LARGE_TEXT_NODE_WIDTH
    );
    expect(resolveStudioGraphNodeMinHeight(createNode("studio.text_generation"))).toBe(
      STUDIO_GRAPH_LARGE_TEXT_NODE_MIN_HEIGHT
    );
  });

  it("exposes large-layout resize bounds for expanded text nodes", () => {
    const bounds = resolveStudioGraphNodeResizeBounds(createNode("studio.text_generation"));
    expect(bounds.minWidth).toBeGreaterThanOrEqual(STUDIO_GRAPH_NODE_MIN_WIDTH);
    expect(bounds.minHeight).toBeGreaterThan(STUDIO_GRAPH_NODE_MIN_HEIGHT);
  });
});

describe("text node resolution", () => {
  it("resolves explicit width within the text bounds", () => {
    const node = createNode("studio.text", {
      size: { width: 5000, height: 10 },
    });

    expect(resolveStudioTextNodeWidth(node)).toBe(4000);
  });

  it("resolves height intrinsically: stored size.height is ignored residue", () => {
    // Text height became intrinsic in the resize rework: the card no longer
    // renders a fixed height, so a persisted size.height from an older
    // project must not leak into layout math.
    const oneLine = createNode("studio.text", {
      size: { width: 300, height: 500 },
      config: { value: "one line" },
    });

    expect(resolveStudioTextNodeHeight(oneLine)).toBe(estimateStudioTextNodeHeight(1));
  });

  it("ignores legacy config height while honoring legacy config width", () => {
    const node = createNode("studio.text", {
      config: { width: 300, height: 120, value: "one line" },
    });

    expect(resolveStudioTextNodeWidth(node)).toBe(300);
    expect(resolveStudioTextNodeHeight(node)).toBe(estimateStudioTextNodeHeight(1));
  });

  it("grows the content estimate with line count inside the text clamps", () => {
    const twentyLines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const node = createNode("studio.text", { config: { value: twentyLines } });

    expect(resolveStudioTextNodeHeight(node)).toBe(estimateStudioTextNodeHeight(20));
    expect(resolveStudioTextNodeHeight(node)).toBeGreaterThan(
      STUDIO_GRAPH_TEXT_NODE_MIN_HEIGHT
    );
  });

  it("prefers a live DOM measurement over the content estimate", () => {
    const node = createNode("studio.text", { config: { value: "one line" } });

    expect(resolveStudioTextNodeHeight(node, { offsetHeight: 333 })).toBe(333);
  });

  it("clamps live measurements into the text height bounds", () => {
    const node = createNode("studio.text", { config: { value: "one line" } });

    expect(resolveStudioTextNodeHeight(node, { offsetHeight: 5000 })).toBe(
      STUDIO_GRAPH_TEXT_NODE_MAX_HEIGHT
    );
  });

  it("falls back to the content estimate for unusable measurements", () => {
    const node = createNode("studio.text", { config: { value: "one line" } });

    expect(resolveStudioTextNodeHeight(node, { offsetHeight: 0 })).toBe(
      estimateStudioTextNodeHeight(1)
    );
    expect(resolveStudioTextNodeHeight(node, null)).toBe(estimateStudioTextNodeHeight(1));
  });

  it("reports no forced min-height for text nodes — height is intrinsic", () => {
    const node = createNode("studio.text", {
      size: { width: 300, height: 500 },
      config: { value: "one line" },
    });

    expect(resolveStudioGraphNodeMinHeight(node)).toBe(0);
  });

  it("keeps min width for tiny explicit widths", () => {
    const node = createNode("studio.text", { size: { width: 10, height: 200 } });

    expect(resolveStudioTextNodeWidth(node)).toBe(STUDIO_GRAPH_TEXT_NODE_MIN_WIDTH);
  });

  it("resolves fontSize from config with clamping and default", () => {
    expect(resolveStudioTextNodeFontSize(createNode("studio.text"))).toBe(14);
    // Poster-scale text is allowed: only truly absurd values clamp.
    expect(
      resolveStudioTextNodeFontSize(createNode("studio.text", { config: { fontSize: 200 } }))
    ).toBe(200);
    expect(
      resolveStudioTextNodeFontSize(createNode("studio.text", { config: { fontSize: 9999 } }))
    ).toBe(512);
    expect(
      resolveStudioTextNodeFontSize(createNode("studio.text", { config: { fontSize: 2 } }))
    ).toBe(10);
  });
});

describe("resolveStudioNodeResizeSemantics", () => {
  it("declares per-kind resize modes as data", () => {
    expect(resolveStudioNodeResizeSemantics("studio.text")).toBe("text");
    expect(resolveStudioNodeResizeSemantics("studio.terminal")).toBe("box");
    expect(resolveStudioNodeResizeSemantics("studio.http_request")).toBe("min-height");
  });

  it("switches media-preview cards to aspect-driven width", () => {
    expect(
      resolveStudioNodeResizeSemantics("studio.media_ingest", { hasAspectMediaContent: true })
    ).toBe("aspect-width");
    expect(resolveStudioNodeResizeSemantics("studio.media_ingest")).toBe("min-height");
  });

  it("keeps declared kinds authoritative over the media flag", () => {
    expect(
      resolveStudioNodeResizeSemantics("studio.text", { hasAspectMediaContent: true })
    ).toBe("text");
    expect(
      resolveStudioNodeResizeSemantics("studio.terminal", { hasAspectMediaContent: true })
    ).toBe("box");
  });
});

describe("shared screen→canvas drag math", () => {
  it("divides client deltas by the graph zoom", () => {
    expect(
      resolveStudioCanvasDelta({
        startClientX: 100,
        startClientY: 100,
        clientX: 140,
        clientY: 180,
        zoom: 2,
      })
    ).toEqual({ deltaX: 20, deltaY: 40 });
  });

  it("treats degenerate zoom values as identity", () => {
    expect(resolveStudioGraphSafeZoom(Number.NaN)).toBe(1);
    expect(resolveStudioGraphSafeZoom(0)).toBe(1);
    expect(resolveStudioGraphSafeZoom(-2)).toBe(1);
    expect(resolveStudioGraphSafeZoom(0.05)).toBe(0.1);
    expect(resolveStudioGraphSafeZoom(0.75)).toBe(0.75);

    expect(
      resolveStudioCanvasDelta({
        startClientX: 0,
        startClientY: 0,
        clientX: 30,
        clientY: -30,
        zoom: Number.NaN,
      })
    ).toEqual({ deltaX: 30, deltaY: -30 });
  });
});
