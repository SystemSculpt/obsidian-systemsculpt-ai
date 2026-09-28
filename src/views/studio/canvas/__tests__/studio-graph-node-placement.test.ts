import { computeStudioNewNodePosition, STUDIO_NEW_NODE_GAP } from "../StudioGraphNodePlacement";
import { resolveStudioGraphNodeWidth } from "../../../../studio/StudioNodeGeometry";
import type { StudioNodeInstance, StudioProjectV1 } from "../../../../studio/types";

function node(id: string, x: number, y: number, size?: { width: number; height: number }): StudioNodeInstance {
  return { id, kind: "studio.text_generation", version: "1.0.0", title: id, position: { x, y }, ...(size ? { size } : {}), config: {}, continueOnError: false, disabled: false };
}

function project(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return { graph: { nodes, edges: [], entryNodeIds: [] } } as unknown as StudioProjectV1;
}

const definition = { kind: "studio.image_generation" };

describe("computeStudioNewNodePosition", () => {
  it("places the new node to the right of the single selected node on the same row", () => {
    const anchor = node("a", 4000, -900, { width: 300, height: 200 });
    const position = computeStudioNewNodePosition({ project: project([anchor]), definition, selectedNodeIds: ["a"], viewportCenter: { x: 0, y: 0 } });
    expect(position).toEqual({ x: 4000 + 300 + STUDIO_NEW_NODE_GAP, y: -900 });
  });

  it("slides below anything already occupying the slot beside the selection", () => {
    const anchor = node("a", 100, 100, { width: 300, height: 200 });
    const neighbour = node("b", 100 + 300 + STUDIO_NEW_NODE_GAP, 100, { width: 280, height: 164 });
    const position = computeStudioNewNodePosition({ project: project([anchor, neighbour]), definition, selectedNodeIds: ["a"], viewportCenter: null });
    expect(position.x).toBe(100 + 300 + STUDIO_NEW_NODE_GAP);
    expect(position.y).toBe(100 + 164 + STUDIO_NEW_NODE_GAP);
  });

  it("prefers measured card sizes over stored geometry when sliding past neighbours", () => {
    const anchor = node("a", 100, 100, { width: 300, height: 200 });
    const neighbour = node("b", 100 + 300 + STUDIO_NEW_NODE_GAP, 100);
    const measure = (candidate: StudioNodeInstance) => candidate.id === "b" ? { width: 538, height: 400 } : null;
    const position = computeStudioNewNodePosition({ project: project([anchor, neighbour]), definition, selectedNodeIds: ["a"], viewportCenter: null, measure });
    expect(position.y).toBe(100 + 400 + STUDIO_NEW_NODE_GAP);
  });

  it("centres on the viewport when nothing or several nodes are selected", () => {
    const nodes = [node("a", 0, 0), node("b", 900, 0)];
    const centred = computeStudioNewNodePosition({ project: project(nodes), definition, selectedNodeIds: ["a", "b"], viewportCenter: { x: 5000, y: 3000 } });
    expect(centred.x).toBe(5000 - resolveStudioGraphNodeWidth({ kind: definition.kind, config: {} }) / 2);
    expect(centred.y).toBeLessThan(3000);
    const none = computeStudioNewNodePosition({ project: project(nodes), definition, selectedNodeIds: [], viewportCenter: { x: 5000, y: 3000 } });
    expect(none).toEqual(centred);
  });

  it("falls back to a deterministic grid from the origin without a bound viewport", () => {
    expect(computeStudioNewNodePosition({ project: project([]), definition, selectedNodeIds: [], viewportCenter: null })).toEqual({ x: 120, y: 120 });
  });
});
