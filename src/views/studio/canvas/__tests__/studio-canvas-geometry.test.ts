/** @jest-environment jsdom */

import type { StudioNodeInstance, StudioProjectV1, StudioShapeInstance } from "../../../../studio/types";
import { StudioCanvasGeometry } from "../StudioCanvasGeometry";

function node(id: string, x: number, y: number): StudioNodeInstance {
  return { id, title: id, version: "1.0.0", kind: "studio.input", position: { x, y }, config: {} };
}

function shape(id: string, x: number, y: number): StudioShapeInstance {
  return { id, shape: "rectangle", position: { x, y }, size: { width: 90, height: 70 } } as StudioShapeInstance;
}

function project(nodes: StudioNodeInstance[]): StudioProjectV1 {
  return { graph: { nodes }, diagram: { shapes: [shape("shape", 500, 600)], arrows: [] } } as unknown as StudioProjectV1;
}

function card(ownerDocument = document) {
  const element = ownerDocument.createElement("div");
  const size = { width: 240, height: 180 };
  const width = jest.fn(() => size.width), height = jest.fn(() => size.height);
  Object.defineProperties(element, { offsetWidth: { get: width }, offsetHeight: { get: height } });
  return { element, size, width, height };
}

describe("StudioCanvasGeometry", () => {
  it("reuses measured sizes and whole-graph bounds while targeted translations update only their rects", () => {
    const current = project([node("a", 10, 20), node("b", 400, 300)]);
    const geometry = new StudioCanvasGeometry(() => current);
    const a = card(), b = card();
    geometry.registerNodeElement("a", a.element);
    geometry.registerNodeElement("b", b.element);
    const bounds = geometry.getNodeBounds();
    const revision = geometry.revision;
    a.width.mockClear(); a.height.mockClear(); b.width.mockClear(); b.height.mockClear();

    for (let frame = 0; frame < 20; frame++) {
      expect(geometry.getNodeBounds()).toBe(bounds);
      expect(geometry.getNodeSize("a")).toEqual({ width: 240, height: 180 });
      expect(geometry.getNode("b")).toBe(current.graph.nodes[1]);
    }
    current.graph.nodes[0].position.x = -100;
    expect(geometry.getNodeRect("a")).toEqual({ left: -100, top: 20, right: 140, bottom: 200 });
    expect(geometry.getNodeBounds()).toEqual({ left: -100, top: 20, right: 640, bottom: 480 });
    expect(geometry.getNodeBounds(["a", "missing"])).toEqual({ left: -100, top: 20, right: 140, bottom: 200 });
    expect(geometry.revision).toBe(revision);
    for (const read of [a.width, a.height, b.width, b.height]) expect(read).not.toHaveBeenCalled();
    geometry.clearNodeElements();
  });

  it("refreshes shape-only external moves and same-count replacements without measuring cards", () => {
    const current = project([node("a", 0, 0)]);
    const geometry = new StudioCanvasGeometry(() => current);
    const a = card();
    geometry.registerNodeElement("a", a.element);
    const revision = geometry.revision;
    a.width.mockClear(); a.height.mockClear();
    current.diagram!.shapes[0].position.y = 900;
    expect(geometry.refreshShapes()).toEqual(["shape"]);
    expect(geometry.getShapeRects().get("shape")?.top).toBe(900);
    expect(geometry.revision).toBeGreaterThan(revision);
    expect(geometry.refreshShapes()).toEqual([]);
    current.diagram!.shapes[0] = shape("replacement", 100, 200);
    expect(geometry.refreshShapes()).toEqual(["shape", "replacement"]);
    expect(geometry.getShape("shape")).toBeNull();
    expect(geometry.getShapeRect("replacement")?.top).toBe(200);
    expect(a.width).not.toHaveBeenCalled();
    expect(a.height).not.toHaveBeenCalled();
    geometry.clearNodeElements();
  });

  it("resolves cloned mutation drafts without writing to live nodes, including reordered drafts", () => {
    const current = project([node("a", 10, 20), node("b", 400, 300)]);
    const geometry = new StudioCanvasGeometry(() => current);
    const draft = JSON.parse(JSON.stringify(current)) as StudioProjectV1;
    geometry.getNode("b", draft)!.position.x = 700;
    expect(draft.graph.nodes[1].position.x).toBe(700);
    expect(current.graph.nodes[1].position.x).toBe(400);
    draft.graph.nodes.reverse();
    expect(geometry.getNode("b", draft)).toBe(draft.graph.nodes[0]);
    draft.graph.nodes.length = 0;
    expect(geometry.getNode("b", draft)).toBeNull();
  });

  it("refreshes in-place external node replacements, positions, DOM sizes, and diagram edits", () => {
    const current = project([node("a", 10, 20), node("b", 400, 300)]);
    const geometry = new StudioCanvasGeometry(() => current);
    const a = card();
    geometry.registerNodeElement("a", a.element);
    const revision = geometry.revision;
    current.graph.nodes[0].position = { x: -400, y: -200 };
    current.graph.nodes[1] = node("replacement", 1000, 2000);
    current.diagram!.shapes[0].position = { x: -50, y: -60 };
    a.size.width = 600; a.size.height = 320;

    geometry.refresh();

    expect(geometry.revision).toBeGreaterThan(revision);
    expect(geometry.getNode("b")).toBeNull();
    expect(geometry.getNode("replacement")).toBe(current.graph.nodes[1]);
    expect(geometry.getNodeSize("a")).toEqual({ width: 600, height: 320 });
    expect(geometry.getNodeRect("a")).toEqual({ left: -400, top: -200, right: 200, bottom: 120 });
    expect(geometry.getNodeBounds()).toEqual({ left: -400, top: -200, right: 1280, bottom: 2164 });
    expect(geometry.getShape("shape")).toBe(current.diagram!.shapes[0]);
    expect(geometry.getShapeRects().get("shape")).toEqual({ left: -50, top: -60, right: 40, bottom: 10 });
    current.diagram!.shapes[0].position.x = 45;
    expect(geometry.getShapeRect("shape")).toEqual({ left: 45, top: -60, right: 135, bottom: 10 });
    geometry.clearNodeElements();
  });

  it("recognizes project replacement, replaced arrays, and in-place additions and removals", () => {
    let current = project([node("a", 10, 20)]);
    const geometry = new StudioCanvasGeometry(() => current);
    expect(geometry.getNode("a")).toBe(current.graph.nodes[0]);
    current.graph.nodes.push(node("b", 40, 50));
    expect(geometry.getNode("b")).toBe(current.graph.nodes[1]);
    current.graph.nodes.pop();
    expect(geometry.getNode("b")).toBeNull();
    current.graph.nodes = [node("c", 90, 80)];
    expect(geometry.getNode("a")).toBeNull();
    expect(geometry.getNodeRects().has("c")).toBe(true);
    current = project([node("d", 200, 300)]);
    expect(geometry.getNodeRects().has("c")).toBe(false);
    expect(geometry.getNode("d")).toBe(current.graph.nodes[0]);
  });

  it("uses the card owner window for resize updates and ignores callbacks from replaced or cleared cards", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const ownerWindow = frame.contentWindow!;
    const callbacks: Array<() => void> = [];
    const disconnects: jest.Mock[] = [];
    const observer = jest.fn();
    (ownerWindow as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      constructor(callback: () => void) { callbacks.push(callback); disconnects.push(this.disconnect); }
      observe = observer;
      disconnect = jest.fn();
    } as unknown as typeof ResizeObserver;
    const changed = jest.fn();
    const current = project([node("a", 10, 20)]);
    const geometry = new StudioCanvasGeometry(() => current, changed);
    const first = card(ownerWindow.document), replacement = card(ownerWindow.document);
    try {
      geometry.registerNodeElement("a", first.element);
      expect(observer).toHaveBeenLastCalledWith(first.element);
      const revision = geometry.revision;
      first.size.width = 480;
      callbacks[0]();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(geometry.revision).toBeGreaterThan(revision);
      expect(geometry.getNodeBounds()).toEqual({ left: 10, top: 20, right: 490, bottom: 200 });
      callbacks[0]();
      expect(changed).toHaveBeenCalledTimes(1);

      geometry.registerNodeElement("a", replacement.element);
      expect(disconnects[0]).toHaveBeenCalledTimes(1);
      first.size.width = 900;
      callbacks[0]();
      expect(geometry.getNodeSize("a")).toEqual({ width: 240, height: 180 });
      expect(changed).toHaveBeenCalledTimes(1);
      geometry.clearNodeElements();
      expect(disconnects[1]).toHaveBeenCalledTimes(1);
      replacement.size.width = 700;
      callbacks[1]();
      expect(geometry.getNodeElement("a")).toBeNull();
      expect(geometry.getNodeSize("a")).toEqual({ width: 280, height: 164 });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      geometry.clearNodeElements();
      frame.remove();
    }
  });

  it("excludes invalid positions from bounds and falls back safely when a card is not measurable", () => {
    const current = project([node("bad", Number.NaN, 10), node("good", -100, -50)]);
    current.graph.nodes[1].size = { width: 350 };
    const geometry = new StudioCanvasGeometry(() => current);
    const good = card();
    good.size.width = 0; good.size.height = 0;
    geometry.registerNodeElement("good", good.element);
    expect(geometry.getNodeRect("bad")).toBeNull();
    expect(geometry.getNodeBounds()).toEqual({ left: -100, top: -50, right: 250, bottom: 114 });
    geometry.clearNodeElements();
  });
});
