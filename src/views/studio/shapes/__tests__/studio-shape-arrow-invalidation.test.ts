/** @jest-environment jsdom */

import type { StudioDiagram, StudioProjectV1, StudioShapeInstance } from "../../../../studio/types";
import { StudioCanvasSelection } from "../../StudioCanvasSelection";
import { StudioGraphInteractionEngine } from "../../StudioGraphInteractionEngine";
import { StudioShapeController } from "../StudioShapeController";
import { renderStudioShapeLayer, type StudioShapeLayerHandle, type StudioShapeLayerOptions } from "../StudioShapeLayer";
import * as geometry from "../StudioShapeGeometry";

jest.mock("../StudioShapeGeometry", () => {
  const actual = jest.requireActual<typeof import("../StudioShapeGeometry")>("../StudioShapeGeometry");
  return { ...actual, buildStudioShapeArrowPath: jest.fn(actual.buildStudioShapeArrowPath) };
});

function shape(id: string, x: number, y = 100): StudioShapeInstance {
  return { id, shape: "rectangle", position: { x, y }, size: { width: 100, height: 100 }, label: id };
}

function diagramFixture(count = 100): StudioDiagram {
  return {
    shapes: Array.from({ length: count }, (_, i) => [shape(`from${i}`, i * 800), shape(`to${i}`, i * 800 + 400)]).flat(),
    arrows: Array.from({ length: count }, (_, i) => ({ id: `a${i}`, fromShapeId: `from${i}`, toShapeId: `to${i}`, label: `Arrow ${i}` })),
  };
}

function pointer(type: string, x: number, y: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event as PointerEvent;
}

function mount(overrides: Partial<StudioShapeLayerOptions> = {}) {
  document.body.empty();
  const canvas = document.body.createDiv();
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  const options: StudioShapeLayerOptions = {
    canvasEl: canvas, diagram: diagramFixture(), busy: false, activeCanvasTool: "select",
    selection: { shapeIds: [], arrowIds: [] }, getGraphZoom: () => 1,
    onSelect: jest.fn(), onMoveSelection: jest.fn(), onResizeShape: jest.fn(),
    onLabelChange: jest.fn(), onArrowLabelChange: jest.fn(), onConnectShapes: jest.fn(),
    ...overrides,
  };
  const handle = renderStudioShapeLayer(options);
  const item = (id: string) => canvas.querySelector<HTMLElement>(`[data-shape-id="${id}"]`)!;
  const line = (id: string) => canvas.querySelector<SVGPathElement>(`[data-arrow-id="${id}"] .ss-studio-shape-arrow-line`)!;
  const label = (id: string) => canvas.querySelector<HTMLElement>(`.ss-studio-shape-arrow-label[data-arrow-id="${id}"]`)!;
  return { canvas, options, handle, item, line, label };
}

describe("Studio diagram arrow invalidation", () => {
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  const handles: StudioShapeLayerHandle[] = [];
  const flushFrame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback(0));
  };

  beforeEach(() => {
    frames = new Map();
    frameId = 0;
    jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.set(++frameId, callback);
      return frameId;
    });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  });

  afterEach(() => {
    handles.splice(0).forEach(handle => handle.dispose?.());
    jest.restoreAllMocks();
  });

  it("updates only incident arrows once per frame during a shape drag", () => {
    const current = mount();
    handles.push(current.handle);
    const build = jest.mocked(geometry.buildStudioShapeArrowPath).mockClear();
    const moved = jest.spyOn(current.line("a0"), "setAttribute");
    const untouched = jest.spyOn(current.line("a99"), "setAttribute");
    const untouchedLeft = jest.spyOn(current.label("a99").style, "left", "set");
    const untouchedTop = jest.spyOn(current.label("a99").style, "top", "set");
    const oldPath = current.line("a0").getAttribute("d");

    current.item("from0").dispatchEvent(pointer("pointerdown", 20, 120));
    for (const y of [150, 180, 200]) window.dispatchEvent(pointer("pointermove", 20, y));
    expect(build).not.toHaveBeenCalled();
    flushFrame();
    expect(build).toHaveBeenCalledTimes(1);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(current.line("a0").getAttribute("d")).not.toBe(oldPath);
    expect(untouched).not.toHaveBeenCalled();
    expect(untouchedLeft).not.toHaveBeenCalled();
    expect(untouchedTop).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointerup", 20, 200));
  });

  it("coalesces raw movement, snapped positions and node notifications into the final geometry", () => {
    let handle: StudioShapeLayerHandle;
    const current = mount({
      onMoveSelection: (_delta, phase) => {
        if (!phase.final) {
          handle.applyShapePositions([{ shapeId: "from0", position: { x: 50, y: 150 } }]);
          handle.refreshArrows(["from0", "to0"]);
        }
      },
    });
    handle = current.handle;
    handles.push(handle);
    const build = jest.mocked(geometry.buildStudioShapeArrowPath).mockClear();
    current.item("from0").dispatchEvent(pointer("pointerdown", 20, 120));
    window.dispatchEvent(pointer("pointermove", 61, 161));
    flushFrame();
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0].position).toEqual({ x: 50, y: 150 });
    expect(current.line("a0").getAttribute("d")).toBe(geometry.buildStudioShapeArrowPath(
      shape("from0", 50, 150), shape("to0", 400)
    ).line);
    window.dispatchEvent(pointer("pointerup", 61, 161));
  });

  it("deduplicates incident node arrows, preserves fans and never resolves unrelated anchors", () => {
    const diagram = diagramFixture(2);
    const nodes = new Map(diagram.shapes.map(item => [item.id, item]));
    diagram.shapes = [];
    diagram.arrows.push({ id: "back", fromShapeId: "to0", toShapeId: "from0" });
    const anchor = jest.fn((id: string) => nodes.get(id) ?? null);
    const current = mount({ diagram, getNodeAnchor: anchor });
    handles.push(current.handle);
    const build = jest.mocked(geometry.buildStudioShapeArrowPath).mockClear();
    anchor.mockClear();
    const oldPath = current.line("a0").getAttribute("d");
    nodes.get("from0")!.position.y += 80;
    current.handle.refreshArrows(["from0"]);
    current.handle.refreshArrows(["to0", "from0"]);
    flushFrame();
    expect(build).toHaveBeenCalledTimes(2);
    expect(anchor.mock.calls.map(([id]) => id).sort()).toEqual(["from0", "to0"]);
    expect(current.line("a0").getAttribute("d")).not.toBe(oldPath);
    expect(current.line("a0").getAttribute("d")).not.toBe(current.line("back").getAttribute("d"));
  });

  it("fully reconciles peer edits and same-count endpoint and arrow replacements before queued work", () => {
    const current = mount({ diagram: diagramFixture(2) });
    handles.push(current.handle);
    current.handle.refreshArrows(["from0"]);
    const diagram = diagramFixture(2);
    diagram.arrows[0] = { id: "a0", fromShapeId: "from1", toShapeId: "to1", label: "Peer label" };
    diagram.arrows[1] = { id: "replacement", fromShapeId: "to1", toShapeId: "from1" };
    diagram.shapes[3].position.y += 200;
    const unrelatedBefore = current.line("a1").getAttribute("d");
    current.handle.update({ ...current.options, diagram });
    expect(current.line("a1")).toBeNull();
    expect(current.line("replacement").getAttribute("d")).not.toBe(unrelatedBefore);
    expect(current.label("a0").textContent).toBe("Peer label");
    const build = jest.mocked(geometry.buildStudioShapeArrowPath).mockClear();
    flushFrame();
    expect(build).not.toHaveBeenCalled();
    current.handle.applyShapePositions([{ shapeId: "from0", position: { x: 0, y: 300 } }]);
    flushFrame();
    expect(build).not.toHaveBeenCalled();
    current.handle.applyShapePositions([{ shapeId: "from1", position: { x: 800, y: 300 } }]);
    flushFrame();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("reindexes in-place document changes on an explicit full refresh and removes dangling arrows", () => {
    const diagram = diagramFixture(2);
    const anchors = new Map(diagram.shapes.map(item => [item.id, item]));
    diagram.shapes = [];
    const current = mount({ diagram, getNodeAnchor: id => anchors.get(id) ?? null });
    handles.push(current.handle);
    diagram.arrows[0] = { id: "new", fromShapeId: "from1", toShapeId: "to1" };
    anchors.delete("from0");
    current.handle.refreshArrows();
    expect(current.line("a0")).toBeNull();
    expect(current.line("new")).not.toBeNull();
    anchors.delete("from1");
    current.handle.refreshArrows(["from1"]);
    flushFrame();
    expect(current.line("new")).toBeNull();
    expect(current.line("a1")).toBeNull();
    anchors.set("from1", shape("from1", 800));
    current.handle.refreshArrows();
    expect(current.line("new")).not.toBeNull();
    expect(current.line("a1")).not.toBeNull();
  });

  it("restores cancelled movement and drops queued writes on disposal", () => {
    const current = mount({ diagram: diagramFixture(2) });
    handles.push(current.handle);
    const initial = current.line("a0").getAttribute("d");
    current.item("from0").dispatchEvent(pointer("pointerdown", 20, 120));
    window.dispatchEvent(pointer("pointermove", 20, 200));
    flushFrame();
    expect(current.line("a0").getAttribute("d")).not.toBe(initial);
    window.dispatchEvent(pointer("pointercancel", 20, 200));
    flushFrame();
    expect(current.line("a0").getAttribute("d")).toBe(initial);
    current.handle.applyShapePositions([{ shapeId: "from0", position: { x: 50, y: 300 } }]);
    const build = jest.mocked(geometry.buildStudioShapeArrowPath).mockClear();
    current.handle.dispose?.();
    flushFrame();
    expect(build).not.toHaveBeenCalled();
  });

  it.each(["shape", "node", "group"])("keeps mixed %s drags incident-only through the interaction engine at a panned, zoomed viewport", (source) => {
    document.body.empty();
    const viewport = document.body.createDiv();
    const canvas = viewport.createDiv();
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    Object.defineProperties(viewport, { clientWidth: { value: 1000 }, clientHeight: { value: 800 } });
    const diagram = diagramFixture(3);
    diagram.arrows.push({ id: "mixed", fromShapeId: "n0", toShapeId: "from0" });
    diagram.arrows.push({ id: "nodes", fromShapeId: "n0", toShapeId: "n1" });
    const project = { diagram, graph: {
      nodes: ["n0", "n1"].map((id, i) => ({ id, kind: "studio.input", version: "1.0.0", title: id,
        position: { x: 100 + i * 800, y: 500 }, config: {} })),
      edges: [], groups: [{ id: "group", name: "Mixed group", nodeIds: ["n0"], shapeIds: ["from0"] }],
    } } as unknown as StudioProjectV1;
    const selection = new StudioCanvasSelection();
    const commit = (_reason: unknown, mutator: (value: StudioProjectV1) => boolean | void) => mutator(project) !== false;
    const notifications = jest.fn();
    const engine: StudioGraphInteractionEngine = new StudioGraphInteractionEngine({
      getCurrentProject: () => project, isBusy: () => false, setError: jest.fn(), requestRender: jest.fn(),
      commitProjectMutation: commit, getPortType: () => null, portTypeCompatible: () => true,
      onNodePositionsChanged: options => {
        notifications(options);
        controller.refreshArrows(options?.nodeIds || options?.shapeIds
          ? [...options.nodeIds ?? [], ...options.shapeIds ?? []] : undefined);
      },
      beginDiagramTranslation: () => controller.beginTranslation(),
      beginGroupShapeTranslation: ids => controller.beginTranslation(ids),
      translateDiagramSelection: (value, delta) => controller.applyTranslation(value, delta),
      previewDiagramTranslation: () => controller.previewTranslation(),
      finishDiagramTranslation: () => controller.finishTranslation(),
    }, selection);
    const controller: StudioShapeController = new StudioShapeController({
      getCurrentProject: () => project, getCanvasEl: () => canvas, getGraphZoom: () => engine.getGraphZoom(),
      isBusy: () => false, commitMutation: commit, requestRender: jest.fn(),
      createMovementSnap: () => engine.createMovementSnap(engine.getSelectedNodeIds(), controller.getSelectedShapeIds()),
      beginNodeTranslation: () => engine.beginSelectionTranslation(),
      translateNodes: (value, delta) => engine.applySelectionTranslation(value, delta),
      previewNodeTranslation: () => engine.previewSelectionTranslation(),
      finishNodeTranslation: () => engine.finishSelectionTranslation(),
    }, selection);
    engine.registerViewportElement(viewport);
    engine.registerCanvasElement(canvas);
    for (const node of project.graph.nodes) {
      const card = canvas.createDiv({ cls: "ss-studio-node-card" });
      card.dataset.nodeId = node.id;
      Object.defineProperties(card, { offsetWidth: { value: 100 }, offsetHeight: { value: 100 } });
      engine.registerNodeElement(node.id, card);
    }
    engine.setGraphZoom(2);
    engine.setViewportWorldTopLeft(-100, -200);
    const { registerLayerHandle, ...callbacks } = controller.layerOptions();
    const handle = renderStudioShapeLayer({
      canvasEl: canvas, diagram, busy: false, activeCanvasTool: "select", getGraphZoom: () => engine.getGraphZoom(),
      getNodeAnchor: id => {
        const rect = engine.geometry.getNodeRect(id);
        return rect ? { id, shape: "rectangle", position: { x: rect.left, y: rect.top },
          size: { width: rect.right - rect.left, height: rect.bottom - rect.top } } : null;
      }, ...callbacks,
    });
    registerLayerHandle(handle);
    handles.push(handle);
    try {
      selection.replace("shape", source === "group" ? ["from2"] : ["from0"]);
      engine.setSelectedNodeIds(["n0"]);
      engine.renderGroupLayer();
      const line = canvas.querySelector<SVGPathElement>('[data-arrow-id="a2"] .ss-studio-shape-arrow-line')!;
      const unrelated = jest.spyOn(line, "setAttribute");
      const build = jest.mocked(geometry.buildStudioShapeArrowPath).mockClear();
      notifications.mockClear();
      if (source === "group") {
        canvas.querySelector<HTMLElement>(".ss-studio-group-frame")!.dispatchEvent(pointer("pointerdown", 100, 100));
      } else if (source === "node") {
        engine.startNodeDrag("n0", pointer("pointerdown", 100, 100), engine.getNodeElement("n0")!);
      } else {
        canvas.querySelector<HTMLElement>('[data-shape-id="from0"]')!.dispatchEvent(pointer("pointerdown", 100, 100));
      }
      window.dispatchEvent(pointer("pointermove", 240, 180));
      flushFrame();
      flushFrame();
      expect(diagram.shapes[0].position).toEqual({ x: 70, y: 140 });
      expect(project.graph.nodes[0].position).toEqual({ x: 170, y: 540 });
      expect(diagram.shapes[4].position).toEqual({ x: 1600, y: 100 });
      expect(build).toHaveBeenCalledTimes(3);
      expect(unrelated).not.toHaveBeenCalled();
      expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ nodeIds: ["n0"], shapeIds: ["from0"] }));
      const mixed = canvas.querySelector<SVGPathElement>('[data-arrow-id="mixed"] .ss-studio-shape-arrow-line')!;
      const nodeRect = engine.geometry.getNodeRect("n0")!;
      expect(mixed.getAttribute("d")).toBe(geometry.buildStudioShapeArrowPath(
        { id: "n0", shape: "rectangle", position: { x: nodeRect.left, y: nodeRect.top },
          size: { width: nodeRect.right - nodeRect.left, height: nodeRect.bottom - nodeRect.top } }, diagram.shapes[0]
      ).line);
      window.dispatchEvent(pointer("pointerup", 240, 180));
    } finally {
      engine.clearRenderBindings();
      controller.registerLayerHandle(null);
    }
  });

  it("updates incident resize geometry without overwriting an arrow label being edited", () => {
    const current = mount({ diagram: diagramFixture(2), selection: { shapeIds: ["from0"], arrowIds: [] } });
    handles.push(current.handle);
    current.label("a0").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    current.label("a0").textContent = "Uncommitted text";
    const untouched = jest.spyOn(current.line("a1"), "setAttribute");
    const oldPath = current.line("a0").getAttribute("d");
    current.item("from0").querySelector<HTMLElement>('[data-corner="se"]')!
      .dispatchEvent(pointer("pointerdown", 100, 200));
    window.dispatchEvent(pointer("pointermove", 150, 250));
    flushFrame();
    expect(current.line("a0").getAttribute("d")).not.toBe(oldPath);
    expect(current.label("a0").textContent).toBe("Uncommitted text");
    expect(untouched).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointercancel", 150, 250));
  });
});
