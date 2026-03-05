import type { StudioNodeInstance } from "../../../../studio/types";
import {
  resolveStudioGraphNodeMinHeight,
  resolveStudioGraphNodeResizeBounds,
  resolveStudioGraphNodeWidth,
  STUDIO_GRAPH_NODE_MIN_HEIGHT,
  STUDIO_GRAPH_NODE_MIN_WIDTH,
  STUDIO_GRAPH_TERMINAL_MIN_HEIGHT,
  STUDIO_GRAPH_TERMINAL_MIN_WIDTH,
} from "../StudioGraphNodeGeometry";

function createNode(
  kind: string,
  config: Record<string, unknown> = {}
): Pick<StudioNodeInstance, "kind" | "config"> {
  return {
    kind,
    config,
  };
}

describe("StudioGraphNodeGeometry", () => {
  it("uses configured width and height for regular nodes", () => {
    const node = createNode("studio.http_request", {
      width: 540,
      height: 360,
    });

    expect(resolveStudioGraphNodeWidth(node)).toBe(540);
    expect(resolveStudioGraphNodeMinHeight(node)).toBe(360);
  });

  it("clamps configured regular-node size to shared bounds", () => {
    const node = createNode("studio.http_request", {
      width: 90,
      height: 30,
    });

    expect(resolveStudioGraphNodeWidth(node)).toBe(STUDIO_GRAPH_NODE_MIN_WIDTH);
    expect(resolveStudioGraphNodeMinHeight(node)).toBe(STUDIO_GRAPH_NODE_MIN_HEIGHT);
  });

  it("keeps terminal node sizing constrained to terminal bounds", () => {
    const node = createNode("studio.terminal", {
      width: 120,
      height: 70,
    });

    expect(resolveStudioGraphNodeWidth(node)).toBe(STUDIO_GRAPH_TERMINAL_MIN_WIDTH);
    expect(resolveStudioGraphNodeMinHeight(node)).toBe(STUDIO_GRAPH_TERMINAL_MIN_HEIGHT);
  });

  it("exposes large-layout resize bounds for expanded text nodes", () => {
    const bounds = resolveStudioGraphNodeResizeBounds(createNode("studio.text_generation"));
    expect(bounds.minWidth).toBeGreaterThanOrEqual(STUDIO_GRAPH_NODE_MIN_WIDTH);
    expect(bounds.minHeight).toBeGreaterThan(STUDIO_GRAPH_NODE_MIN_HEIGHT);
  });
});
