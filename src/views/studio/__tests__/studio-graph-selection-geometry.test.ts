/** @jest-environment jsdom */

import type { StudioNodeInstance, StudioProjectV1 } from "../../../studio/types";
import { StudioGraphSelectionController } from "../StudioGraphSelectionController";
import { createElementStub, installWindowPointerListenerHarness } from "./studio-graph-pointer-test-helpers";

function node(id: string, x: number, y: number): StudioNodeInstance {
  return { id, title: id, version: "1.0.0", kind: "studio.input", position: { x, y }, config: {} };
}

function harness(nodes: StudioNodeInstance[], selectedShapeIds: string[] = []) {
  const project = { graph: { nodes }, diagram: { shapes: [], arrows: [] } } as unknown as StudioProjectV1;
  const renderEdgeLayer = jest.fn(), onNodePositionsChanged = jest.fn(), selectDiagramInBounds = jest.fn();
  const controller = new StudioGraphSelectionController({
    isBusy: () => false,
    getCurrentProject: () => project,
    renderEdgeLayer,
    onNodePositionsChanged,
    selectDiagramInBounds,
    getSelectedShapeIds: () => selectedShapeIds,
    commitProjectMutation: (_reason, mutator) => mutator(project) !== false,
  });
  const cards = nodes.map(current => {
    const element = createElementStub();
    const size = { width: 240, height: 180 };
    const width = jest.fn(() => size.width), height = jest.fn(() => size.height);
    Object.defineProperties(element, { offsetWidth: { get: width }, offsetHeight: { get: height } });
    controller.registerNodeElement(current.id, element);
    return { element, size, width, height };
  });
  const viewport = document.createElement("div");
  Object.defineProperties(viewport, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
  const mount = () => {
    controller.registerViewportElement(viewport);
    controller.registerSurfaceElement(createElementStub());
    controller.registerCanvasElement(createElementStub(), createElementStub());
    controller.registerMarqueeElement(createElementStub());
  };
  mount();
  controller.setViewportWorldTopLeft(0, 0);
  const clearMeasurements = () => {
    for (const card of cards) { card.width.mockClear(); card.height.mockClear(); }
  };
  const expectNoMeasurements = () => {
    for (const card of cards) { expect(card.width).not.toHaveBeenCalled(); expect(card.height).not.toHaveBeenCalled(); }
  };
  return { controller, project, cards, viewport, mount, renderEdgeLayer, onNodePositionsChanged,
    selectDiagramInBounds, clearMeasurements, expectNoMeasurements };
}

function pointer(clientX: number, clientY: number, extra: Partial<PointerEvent> = {}): PointerEvent {
  return { button: 0, pointerId: 9, clientX, clientY, preventDefault: jest.fn(), ...extra } as PointerEvent;
}

describe("StudioGraphSelectionController shared geometry", () => {
  it("refreshes moved shapes and groups even when no nodes participate in their drag", () => {
    const current = harness([node("node", 0, 0)], ["shape"]);
    current.project.diagram!.shapes.push({ id: "shape", shape: "rectangle", position: { x: 500, y: 3 }, size: { width: 100, height: 100 } } as any);
    current.controller.notifyNodePositionsChanged();
    current.controller.beginSelectionTranslation();
    current.clearMeasurements();
    current.project.diagram!.shapes[0].position.y = 500;
    current.controller.previewSelectionTranslation();
    expect(current.controller.geometry.getShapeRects().get("shape")?.top).toBe(500);
    expect(current.onNodePositionsChanged).toHaveBeenLastCalledWith({ recomputeCanvasBounds: false, translating: true, nodeIds: [], shapeIds: ["shape"] });
    expect(current.controller.createMovementSnap(["node"], [])({ x: 100, y: 0 })).toEqual({ x: 100, y: 0 });
    current.expectNoMeasurements();
    current.controller.finishSelectionTranslation();
    current.controller.clearRenderBindings();
  });

  it("pans, scrolls, and zooms without remeasuring cards or reading whole-graph positions", () => {
    const current = harness(Array.from({ length: 30 }, (_, index) => node(`node-${index}`, index * 400, index * 200)));
    const positionReads = current.project.graph.nodes.map(value => {
      const x = value.position.x;
      const read = jest.fn(() => x);
      Object.defineProperty(value.position, "x", { get: read, configurable: true });
      return read;
    });
    const frames: FrameRequestCallback[] = [];
    const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const events = installWindowPointerListenerHarness();
    current.clearMeasurements();
    try {
      current.controller.startCanvasPan(pointer(100, 100));
      for (let frame = 1; frame <= 10; frame++) {
        events.emit("pointermove", pointer(100 + frame * 10, 100 + frame * 5));
        frames.shift()!(frame);
        current.controller.ensureWorldCoverage();
        current.controller.zoomGraphAtViewportCenter(1 + frame * 0.02, { settled: false });
        current.controller.handleGraphViewportWheel(new WheelEvent("wheel", { deltaX: 8, deltaY: 12, cancelable: true }));
      }
      events.emit("pointerup", pointer(200, 150));
      current.expectNoMeasurements();
      for (const read of positionReads) expect(read).not.toHaveBeenCalled();
    } finally {
      current.controller.clearRenderBindings(); events.restore(); request.mockRestore(); cancel.mockRestore();
    }
  });

  it("reuses stationary movement and resize targets, then refreshes external edits for snapping", () => {
    const current = harness([node("moving", 0, 0), node("target", 1000, 3)]);
    let targetX = 1000;
    const targetRead = jest.fn(() => targetX);
    Object.defineProperty(current.project.graph.nodes[1].position, "x", { get: targetRead, configurable: true });
    current.controller.notifyNodePositionsChanged();
    const snap = current.controller.createMovementSnap(["moving"], []);
    expect(snap({ x: 100, y: 0 })).toEqual({ x: 100, y: 3 });
    current.controller.showNodeResizeGuides("moving", { left: 0, top: 0, right: 240, bottom: 180 }, { x: 1, y: 1 });
    targetRead.mockClear(); current.clearMeasurements();
    try {
      for (let frame = 1; frame <= 15; frame++) {
        current.project.graph.nodes[0].position.x = frame * 10;
        current.controller.showMovementGuides(["moving"], []);
        current.controller.showNodeResizeGuides("moving", { left: frame * 10, top: 0, right: 240, bottom: 180 }, { x: 1, y: 1 });
      }
      current.expectNoMeasurements();
      expect(targetRead).not.toHaveBeenCalled();
      targetX = 2000;
      current.project.graph.nodes[1].position.y = 500;
      current.controller.notifyNodePositionsChanged();
      expect(current.controller.createMovementSnap(["moving"], [])({ x: 100, y: 0 })).toEqual({ x: 100, y: 0 });
      expect(targetRead).toHaveBeenCalled();
    } finally { current.controller.clearRenderBindings(); }
  });

  it("keeps additive marquee selection and zoomed world coordinates without layout reads", () => {
    const current = harness([node("a", 10, 20), node("b", 400, 300)]);
    current.controller.setSelectedNodeIds(["b"]);
    current.controller.setGraphZoom(2);
    current.controller.setViewportWorldTopLeft(0, 0);
    current.clearMeasurements();
    const events = installWindowPointerListenerHarness();
    try {
      current.controller.startMarqueeSelection(pointer(0, 0, { shiftKey: true }));
      events.emit("pointermove", pointer(600, 500));
      events.emit("pointerup", pointer(600, 500));
      expect(new Set(current.controller.getSelectedNodeIds())).toEqual(new Set(["a", "b"]));
      expect(current.selectDiagramInBounds).toHaveBeenLastCalledWith({ left: 0, top: 0, right: 300, bottom: 250 }, true);
      current.expectNoMeasurements();
    } finally { current.controller.clearRenderBindings(); events.restore(); }
  });

  it("refreshes only resized cards and forwards touched ids during continuous geometry changes", () => {
    const current = harness([node("a", 0, 0), node("b", 500, 300)]);
    current.clearMeasurements();
    current.cards[0].size.width = 600;
    current.controller.notifyNodePositionsChanged({ nodeIds: ["a"], recomputeCanvasBounds: false });
    expect(current.controller.geometry.getNodeSize("a")).toEqual({ width: 600, height: 180 });
    expect(current.cards[0].width).toHaveBeenCalledTimes(1);
    expect(current.cards[1].width).not.toHaveBeenCalled();
    expect(current.cards[1].height).not.toHaveBeenCalled();
    expect(current.onNodePositionsChanged).toHaveBeenLastCalledWith({ nodeIds: ["a"], recomputeCanvasBounds: false });
    current.clearMeasurements();
    current.project.graph.nodes[0].position.x = 150;
    current.controller.notifyNodePositionsChanged({ nodeIds: ["a"], shapeIds: [], recomputeCanvasBounds: false, translating: true });
    expect(current.controller.geometry.getNodeRect("a")!.left).toBe(150);
    current.expectNoMeasurements();
    current.controller.clearRenderBindings();
  });

  it("propagates card ResizeObserver geometry changes to groups, frames, and arrows", () => {
    const original = window.ResizeObserver;
    const callbacks = new Map<Element, () => void>();
    window.ResizeObserver = class {
      private readonly callback: () => void;
      constructor(callback: () => void) { this.callback = callback; }
      observe(target: Element) { callbacks.set(target, this.callback); }
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const current = harness([node("a", 0, 0), node("b", 500, 300)]);
    current.renderEdgeLayer.mockClear(); current.onNodePositionsChanged.mockClear();
    try {
      current.cards[0].size.height = 450;
      callbacks.get(current.cards[0].element)!();
      expect(current.controller.geometry.getNodeSize("a")!.height).toBe(450);
      expect(current.renderEdgeLayer).toHaveBeenCalledTimes(1);
      expect(current.onNodePositionsChanged).toHaveBeenCalledWith({ nodeIds: ["a"] });
      current.controller.clearRenderBindings();
      callbacks.get(current.cards[0].element)!();
      expect(current.onNodePositionsChanged).toHaveBeenCalledTimes(1);
    } finally { current.controller.clearRenderBindings(); window.ResizeObserver = original; }
  });

  it("preserves overview zoom through render teardown and resets the mode only for a new project", () => {
    const current = harness([node("a", 0, 0)]);
    current.controller.setGraphZoom(0.01, { mode: "overview" });
    current.controller.clearRenderBindings();
    current.mount();
    current.controller.applyGraphZoom();
    expect(current.controller.getGraphZoomMode()).toBe("overview");
    expect(current.controller.getGraphZoom()).toBe(0.01);
    current.controller.clearProjectState();
    expect(current.controller.getGraphZoomMode()).toBe("interactive");
    current.controller.clearRenderBindings();
  });
});
