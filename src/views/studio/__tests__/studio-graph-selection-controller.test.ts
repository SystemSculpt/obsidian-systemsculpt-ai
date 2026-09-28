/** @jest-environment jsdom */

import { StudioGraphSelectionController } from "../StudioGraphSelectionController";
import {
  createElementStub,
  installWindowPointerListenerHarness,
} from "./studio-graph-pointer-test-helpers";

type TestHost = ConstructorParameters<typeof StudioGraphSelectionController>[0];

function createHost(): TestHost {
  const host: TestHost = {
    isBusy: () => false,
    getCurrentProject: () => null,
    renderEdgeLayer: () => undefined,
    scheduleProjectSave: () => undefined,
    commitProjectMutation: (_reason, mutator) => {
      const project = host.getCurrentProject();
      if (!project) {
        return false;
      }
      return mutator(project) !== false;
    },
  };
  return host;
}

function createViewport(): HTMLElement {
  return {
    ownerDocument: document,
    scrollLeft: 120,
    scrollTop: 240,
    clientWidth: 1400,
    clientHeight: 900,
    getBoundingClientRect: () =>
      ({
        left: 0,
        top: 0,
      }) as DOMRect,
  } as unknown as HTMLElement;
}

describe("StudioGraphSelectionController hidden viewport restoration", () => {
  let resize: () => void;
  let disconnect: jest.Mock;
  const originalObserver = window.ResizeObserver;

  beforeEach(() => {
    disconnect = jest.fn();
    window.ResizeObserver = class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => { window.ResizeObserver = originalObserver; });

  function mount(controller: StudioGraphSelectionController, initiallyVisible: boolean) {
    let visible = initiallyVisible;
    let left = 0;
    let top = 0;
    // Hidden Chromium elements expose zero scroll offsets and ignore writes.
    const viewport = document.createElement("div");
    Object.defineProperties(viewport, {
      clientWidth: { get: () => visible ? 1000 : 0 },
      clientHeight: { get: () => visible ? 600 : 0 },
      scrollLeft: { get: () => visible ? left : 0, set: (value: number) => { if (visible) left = value; } },
      scrollTop: { get: () => visible ? top : 0, set: (value: number) => { if (visible) top = value; } },
    });
    controller.registerViewportElement(viewport);
    controller.registerSurfaceElement(createElementStub());
    controller.registerCanvasElement(createElementStub(), createElementStub());
    return {
      viewport,
      setVisible(value: boolean) { visible = value; resize?.(); },
    };
  }

  it.each([1, 0.74455, 0.0308])("preserves a hidden saved viewport through repeated remounts at zoom %s", (zoom) => {
    const controller = new StudioGraphSelectionController(createHost());
    const saved = { x: -206.25, y: 4.125 };
    let mounted: ReturnType<typeof mount>;
    for (let reload = 0; reload < 4; reload++) {
      mounted = mount(controller, false);
      controller.setGraphZoom(zoom);
      controller.setViewportWorldTopLeft(saved.x, saved.y);
      expect(controller.getViewportWorldTopLeft()).toEqual(saved);
      controller.ensureWorldCoverage();
      expect(controller.getViewportWorldTopLeft()).toEqual(saved);
      if (reload < 3) controller.clearRenderBindings();
    }
    mounted!.setVisible(true);
    expect(controller.getGraphZoom()).toBe(zoom);
    expect(controller.getViewportWorldTopLeft()!.x).toBeCloseTo(saved.x);
    expect(controller.getViewportWorldTopLeft()!.y).toBeCloseTo(saved.y);
    const position = [mounted!.viewport.scrollLeft, mounted!.viewport.scrollTop];
    resize();
    expect([mounted!.viewport.scrollLeft, mounted!.viewport.scrollTop]).toEqual(position);
    controller.clearRenderBindings();
    expect(disconnect).toHaveBeenCalledTimes(4);
  });

  it("retains the last visible pan while hidden and restores it when shown", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const mounted = mount(controller, true);
    controller.setViewportWorldTopLeft(-320, 280);
    mounted.viewport.scrollLeft += 125;
    mounted.viewport.scrollTop += 75;
    const position = controller.getViewportWorldTopLeft();
    mounted.setVisible(false);
    expect(controller.getViewportWorldTopLeft()).toEqual(position);
    controller.ensureWorldCoverage();
    mounted.setVisible(true);
    expect(controller.getViewportWorldTopLeft()).toEqual(position);
    controller.clearRenderBindings();
  });

  it("retains a wheel pan when hidden before the deferred scroll capture", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const mounted = mount(controller, true);
    controller.setViewportWorldTopLeft(250, -75);
    controller.handleGraphViewportWheel(new WheelEvent("wheel", {
      deltaX: 32,
      deltaY: 64,
      cancelable: true,
    }));
    mounted.setVisible(false);
    expect(controller.getViewportWorldTopLeft()).toEqual({ x: 282, y: -11 });
    mounted.setVisible(true);
    expect(controller.getViewportWorldTopLeft()).toEqual({ x: 282, y: -11 });
    controller.clearRenderBindings();
  });
});

describe("StudioGraphSelectionController wheel behavior", () => {
  it("filters unknown node IDs when setting explicit selection", () => {
    const host = createHost();
    host.getCurrentProject = () =>
      ({
        graph: {
          nodes: [{ id: "node-a" }, { id: "node-b" }],
        },
      } as any);
    const controller = new StudioGraphSelectionController(host);

    controller.setSelectedNodeIds(["node-a", "missing", "node-b", "node-a", ""]);

    expect(controller.getSelectedNodeIds()).toEqual(["node-a", "node-b"]);
  });

  it("keeps native scrolling for wheel events inside context menus", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes(".ss-studio-simple-context-menu") ? ({} as Element) : null,
      },
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 64,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(240);
  });

  it("keeps native scrolling for wheel events inside searchable dropdown lists", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes(".ss-studio-searchable-select-list") ? ({} as Element) : null,
      },
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 64,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(240);
  });

  it("pans the canvas for wheel events on the graph surface", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: () => null,
      },
      ctrlKey: false,
      metaKey: false,
      deltaX: 18,
      deltaY: 42,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(viewport.scrollLeft).toBe(138);
    expect(viewport.scrollTop).toBe(282);
  });

  it.each([
    { deltaX: 0, deltaY: 64, deltaMode: 0, expectedX: 184 },
    { deltaX: 0, deltaY: -64, deltaMode: 0, expectedX: 56 },
    { deltaX: 48, deltaY: 0, deltaMode: 0, expectedX: 168 },
    { deltaX: 48, deltaY: 64, deltaMode: 0, expectedX: 168 },
    { deltaX: 0, deltaY: 3, deltaMode: 1, expectedX: 168 },
    { deltaX: 0, deltaY: 1, deltaMode: 2, expectedX: 1520 },
  ])("pans only horizontally with Shift+wheel: %j", ({ expectedX, ...deltas }) => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);
    const event = new WheelEvent("wheel", { ...deltas, shiftKey: true, cancelable: true });

    controller.handleGraphViewportWheel(event);

    expect(event.defaultPrevented).toBe(true);
    expect(viewport.scrollLeft).toBe(expectedX);
    expect(viewport.scrollTop).toBe(240);
    expect(controller.getGraphZoom()).toBe(1);
  });

  it("leaves a wheel event consumed by a child control alone", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);
    const event = new WheelEvent("wheel", { deltaY: 64, shiftKey: true, cancelable: true });
    event.preventDefault();

    controller.handleGraphViewportWheel(event);

    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(240);
  });

  it("pans the canvas for wheel events over unfocused editable form controls", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const unfocusedTextarea = {
      ownerDocument: { activeElement: null },
    } as unknown as Element;
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes("textarea") ? unfocusedTextarea : null,
      },
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 72,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(312);
  });

  it("pans the canvas for wheel events over unfocused prompt editors", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const unfocusedPrompt = {
      ownerDocument: { activeElement: null },
    } as unknown as Element;
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes("textarea") ? unfocusedPrompt : null,
      },
      ctrlKey: false,
      metaKey: false,
      deltaX: 0,
      deltaY: 96,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(336);
  });

  it.each([false, true])("keeps native scrolling in focused fields (Shift: %s)", (shiftKey) => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const focusedTextarea = {} as Element & { ownerDocument: { activeElement: Element | null } };
    focusedTextarea.ownerDocument = { activeElement: focusedTextarea };
    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes("textarea") ? focusedTextarea : null,
      },
      ctrlKey: false,
      metaKey: false,
      shiftKey,
      deltaX: 0,
      deltaY: 84,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(240);
  });

  it.each([false, true])("preserves ctrl+wheel zoom inside editable fields (Shift: %s)", (shiftKey) => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes("textarea") ? ({} as Element) : null,
      },
      ctrlKey: true,
      metaKey: false,
      shiftKey,
      deltaX: 0,
      deltaY: -80,
      deltaMode: 0,
      clientX: 320,
      clientY: 220,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(controller.getGraphZoom()).toBeGreaterThan(1);
  });

  it("still zooms graph for ctrl+wheel events inside context menus", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);
    const initialZoom = controller.getGraphZoom();

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes(".ss-studio-simple-context-menu") ? ({} as Element) : null,
      },
      ctrlKey: true,
      metaKey: false,
      deltaX: 0,
      deltaY: -64,
      deltaMode: 0,
      clientX: 0,
      clientY: 0,
      preventDefault,
    } as unknown as WheelEvent;

    controller.handleGraphViewportWheel(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(controller.getGraphZoom()).toBeGreaterThan(initialZoom);
  });

  it("coalesces rapid ctrl+wheel zoom bursts into one settled edge render", () => {
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    let nextTimerId = 1;
    const scheduledTimers = new Map<number, () => void>();

    window.setTimeout = ((callback: TimerHandler) => {
      const timerId = nextTimerId++;
      scheduledTimers.set(timerId, callback as () => void);
      return timerId;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timerId: number) => {
      scheduledTimers.delete(timerId);
    }) as typeof window.clearTimeout;

    try {
      const host = createHost();
      const renderEdgeLayer = jest.fn();
      host.renderEdgeLayer = renderEdgeLayer;
      const controller = new StudioGraphSelectionController(host);
      const viewport = createViewport();
      controller.registerViewportElement(viewport);
      controller.registerSurfaceElement(createElementStub());
      controller.registerCanvasElement(createElementStub());

      const firstEvent = {
        target: {
          closest: () => null,
        },
        ctrlKey: true,
        metaKey: false,
        deltaX: 0,
        deltaY: -64,
        deltaMode: 0,
        clientX: 320,
        clientY: 220,
        preventDefault: jest.fn(),
      } as unknown as WheelEvent;
      const secondEvent = {
        ...firstEvent,
        preventDefault: jest.fn(),
        deltaY: -48,
      } as unknown as WheelEvent;

      controller.handleGraphViewportWheel(firstEvent);
      controller.handleGraphViewportWheel(secondEvent);

      expect(renderEdgeLayer).not.toHaveBeenCalled();
      expect(scheduledTimers.size).toBe(1);

      const settleZoom = Array.from(scheduledTimers.values())[0];
      settleZoom?.();

      expect(renderEdgeLayer).toHaveBeenCalledTimes(1);
    } finally {
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  });
});

describe("StudioGraphSelectionController fit selection", () => {
  it("zooms and centers the viewport around selected nodes with padding", () => {
    const host = createHost();
    host.getCurrentProject = () =>
      ({
        graph: {
          nodes: [
            {
              id: "node_a",
              position: { x: 100, y: 200 },
              kind: "studio.value",
              config: {},
            },
            {
              id: "node_b",
              position: { x: 500, y: 400 },
              kind: "studio.value",
              config: {},
            },
          ],
        },
      } as any);

    const controller = new StudioGraphSelectionController(host);
    const viewport = {
      ownerDocument: document,
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 1000,
      clientHeight: 600,
      getBoundingClientRect: () =>
        ({
          left: 0,
          top: 0,
        }) as DOMRect,
    } as unknown as HTMLElement;
    controller.registerViewportElement(viewport);

    const nodeAEl = createElementStub() as unknown as HTMLElement & {
      offsetWidth: number;
      offsetHeight: number;
    };
    (nodeAEl as any).offsetWidth = 200;
    (nodeAEl as any).offsetHeight = 120;
    const nodeBEl = createElementStub() as unknown as HTMLElement & {
      offsetWidth: number;
      offsetHeight: number;
    };
    (nodeBEl as any).offsetWidth = 300;
    (nodeBEl as any).offsetHeight = 200;
    controller.registerNodeElement("node_a", nodeAEl);
    controller.registerNodeElement("node_b", nodeBEl);
    controller.setSelectedNodeIds(["node_a", "node_b"]);

    const fitted = controller.fitSelectionInViewport({ paddingPx: 25 });

    expect(fitted).toBe(true);
    const zoom = controller.getGraphZoom();
    expect(zoom).toBeCloseTo(950 / 700, 5);
    // The canvas has no corner, so assert the world coordinate under the
    // viewport's top-left: the selection centre (450, 400) minus half a viewport.
    const topLeft = controller.getViewportWorldTopLeft()!;
    expect(topLeft.x).toBeCloseTo(450 - 500 / zoom, 5);
    expect(topLeft.y).toBeCloseTo(400 - 300 / zoom, 5);
  });

  it("returns false and keeps viewport state when nothing is selected", () => {
    const host = createHost();
    host.getCurrentProject = () =>
      ({
        graph: {
          nodes: [
            {
              id: "node_a",
              position: { x: 100, y: 200 },
              kind: "studio.value",
              config: {},
            },
          ],
        },
      } as any);
    const controller = new StudioGraphSelectionController(host);
    const viewport = {
      ownerDocument: document,
      scrollLeft: 88,
      scrollTop: 132,
      clientWidth: 900,
      clientHeight: 700,
      getBoundingClientRect: () =>
        ({
          left: 0,
          top: 0,
        }) as DOMRect,
    } as unknown as HTMLElement;
    controller.registerViewportElement(viewport);
    const initialZoom = controller.getGraphZoom();

    const fitted = controller.fitSelectionInViewport({ paddingPx: 25 });

    expect(fitted).toBe(false);
    expect(controller.getGraphZoom()).toBe(initialZoom);
    expect(viewport.scrollLeft).toBe(88);
    expect(viewport.scrollTop).toBe(132);
  });

  it("enters overview mode when fitting a large graph below the interactive zoom floor", () => {
    const host = createHost();
    host.getCurrentProject = () =>
      ({
        graph: {
          nodes: [
            {
              id: "node_a",
              position: { x: 100, y: 120 },
              kind: "studio.value",
              config: {},
            },
            {
              id: "node_b",
              position: { x: 80000, y: 60000 },
              kind: "studio.value",
              config: {},
            },
          ],
        },
      } as any);

    const controller = new StudioGraphSelectionController(host);
    const viewport = {
      ownerDocument: document,
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 1000,
      clientHeight: 600,
      getBoundingClientRect: () =>
        ({
          left: 0,
          top: 0,
        }) as DOMRect,
    } as unknown as HTMLElement;
    controller.registerViewportElement(viewport);

    const nodeAEl = createElementStub() as unknown as HTMLElement & {
      offsetWidth: number;
      offsetHeight: number;
    };
    (nodeAEl as any).offsetWidth = 240;
    (nodeAEl as any).offsetHeight = 160;
    const nodeBEl = createElementStub() as unknown as HTMLElement & {
      offsetWidth: number;
      offsetHeight: number;
    };
    (nodeBEl as any).offsetWidth = 320;
    (nodeBEl as any).offsetHeight = 220;
    controller.registerNodeElement("node_a", nodeAEl);
    controller.registerNodeElement("node_b", nodeBEl);

    const fitted = controller.fitGraphInViewport({ paddingPx: 25 });

    expect(fitted).toBe(true);
    expect(controller.getGraphZoomMode()).toBe("overview");
    expect(controller.getGraphZoom()).toBeLessThan(0.02);
  });

  it("centers a small graph without enlarging it above natural scale", () => {
    const host = createHost();
    host.getCurrentProject = () =>
      ({
        graph: {
          nodes: [
            {
              id: "node_a",
              position: { x: 100, y: 120 },
              kind: "studio.value",
              config: {},
            },
          ],
        },
      } as any);

    const controller = new StudioGraphSelectionController(host);
    const viewport = {
      ownerDocument: document,
      scrollLeft: 0,
      scrollTop: 0,
      clientWidth: 1000,
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0 }) as DOMRect,
    } as unknown as HTMLElement;
    controller.registerViewportElement(viewport);

    const nodeEl = createElementStub() as unknown as HTMLElement & {
      offsetWidth: number;
      offsetHeight: number;
    };
    (nodeEl as any).offsetWidth = 240;
    (nodeEl as any).offsetHeight = 160;
    controller.registerNodeElement("node_a", nodeEl);

    expect(controller.fitGraphInViewport({ paddingPx: 25 })).toBe(true);
    expect(controller.getGraphZoom()).toBe(1);
    // Centred at natural scale: the node's centre sits at the viewport centre.
    const node = host.getCurrentProject()!.graph.nodes[0];
    const topLeft = controller.getViewportWorldTopLeft()!;
    expect(topLeft.x).toBeCloseTo(node.position.x + 120 - 500, 5);
    expect(topLeft.y).toBeCloseTo(node.position.y + 80 - 300, 5);
  });
});

describe("StudioGraphSelectionController drag behavior", () => {
  it.each(["pan", "marquee", "node"] as const)("cancels %s listeners and queued movement when the canvas is replaced", (gesture) => {
    const host = createHost();
    const project = { graph: { nodes: [{ id: "node_1", position: { x: 40, y: 50 }, kind: "studio.input", config: {} }] } } as any;
    host.getCurrentProject = () => project;
    const commit = jest.fn((_reason, mutator) => mutator(project) !== false);
    host.commitProjectMutation = commit;
    const controller = new StudioGraphSelectionController(host);
    const viewport = createViewport();
    const nodeEl = createElementStub();
    controller.registerViewportElement(viewport);
    controller.registerMarqueeElement(createElementStub());
    controller.registerNodeElement("node_1", nodeEl);
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
    const harness = installWindowPointerListenerHarness();
    const start = { button: 0, pointerId: 7, clientX: 100, clientY: 120, preventDefault: jest.fn() } as unknown as PointerEvent;
    try {
      if (gesture === "pan") controller.startCanvasPan(start);
      else if (gesture === "marquee") controller.startMarqueeSelection(start);
      else controller.startNodeDrag("node_1", start, nodeEl);
      harness.emit("pointermove", { pointerId: 7, clientX: 300, clientY: 320, preventDefault: jest.fn() } as unknown as PointerEvent);
      expect(frames.size).toBe(1);
      controller.clearRenderBindings();
      expect(frames.size).toBe(0);
      expect(harness.has("pointermove")).toBe(false);
      expect(harness.has("pointerup")).toBe(false);
      expect(harness.has("pointercancel")).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      expect(project.graph.nodes[0].position).toEqual({ x: 40, y: 50 });
    } finally {
      controller.clearRenderBindings();
      harness.restore();
      request.mockRestore();
      cancel.mockRestore();
    }
  });

  it("allows dragging regular nodes while busy so layout can be reorganized during runs", () => {
    const host = createHost();
    const renderEdgeLayer = jest.fn();
    host.isBusy = () => true;
    host.renderEdgeLayer = renderEdgeLayer;

    const project = {
      graph: {
        nodes: [
          {
            id: "node_1",
            position: { x: 40, y: 50 },
            kind: "studio.input",
            config: {},
          },
        ],
      },
    } as any;
    const commitProjectMutation = jest.fn((_reason, mutator) => mutator(project) !== false);
    host.getCurrentProject = () => project;
    host.commitProjectMutation = commitProjectMutation;

    const controller = new StudioGraphSelectionController(host);
    const nodeEl = createElementStub();
    controller.registerNodeElement("node_1", nodeEl);
    const startEvent = {
      button: 0,
      pointerId: 11,
      clientX: 100,
      clientY: 120,
      preventDefault: jest.fn(),
    } as unknown as PointerEvent;

    const harness = installWindowPointerListenerHarness();
    const movePreventDefault = jest.fn();
    try {
      controller.startNodeDrag("node_1", startEvent, nodeEl);
      harness.emit(
        "pointermove",
        {
          pointerId: 11,
          clientX: 140,
          clientY: 180,
          preventDefault: movePreventDefault,
        } as PointerEvent
      );
      harness.emit(
        "pointerup",
        {
          pointerId: 11,
          clientX: 140,
          clientY: 180,
        } as PointerEvent
      );
    } finally {
      harness.restore();
    }

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(movePreventDefault).toHaveBeenCalledTimes(1);
    expect(project.graph.nodes[0].position).toEqual({ x: 80, y: 110 });
    expect(nodeEl.style.transform).toBe("translate(80px, 110px)");
    expect(renderEdgeLayer).toHaveBeenCalled();
    expect(commitProjectMutation).toHaveBeenCalledTimes(2);
    expect(commitProjectMutation).toHaveBeenNthCalledWith(
      1,
      "node.position",
      expect.any(Function),
      { captureHistory: true, mode: "continuous" }
    );
    expect(commitProjectMutation).toHaveBeenNthCalledWith(
      2,
      "node.position",
      expect.any(Function),
      { captureHistory: false, mode: "discrete" }
    );
  });

  it("does not prevent the initial pointer default until a node actually drags", () => {
    const host = createHost();
    const project = {
      graph: {
        nodes: [
          {
            id: "node_1",
            position: { x: 40, y: 50 },
            kind: "studio.text",
            config: {},
          },
        ],
      },
    } as any;
    host.getCurrentProject = () => project;
    host.commitProjectMutation = jest.fn((_reason, mutator) => mutator(project) !== false);

    const controller = new StudioGraphSelectionController(host);
    const nodeEl = createElementStub();
    controller.registerNodeElement("node_1", nodeEl);
    const startEvent = {
      button: 0,
      pointerId: 21,
      clientX: 100,
      clientY: 120,
      preventDefault: jest.fn(),
    } as unknown as PointerEvent;

    const harness = installWindowPointerListenerHarness();
    try {
      controller.startNodeDrag("node_1", startEvent, nodeEl);
      harness.emit(
        "pointerup",
        {
          pointerId: 21,
          clientX: 100,
          clientY: 120,
        } as PointerEvent
      );
    } finally {
      harness.restore();
    }

    expect(startEvent.preventDefault).not.toHaveBeenCalled();
    expect(project.graph.nodes[0].position).toEqual({ x: 40, y: 50 });
    expect(controller.getSelectedNodeIds()).toEqual(["node_1"]);
  });

  it("allows marquee selection while busy so multi-node layout changes stay available during runs", () => {
    const host = createHost();
    host.isBusy = () => true;
    host.getCurrentProject = () =>
      ({
        graph: {
          nodes: [
            {
              id: "node_1",
              version: "1.0.0",
              title: "Node 1",
              position: { x: 100, y: 100 },
              kind: "studio.input",
              config: {},
            },
          ],
        },
      } as any);

    const controller = new StudioGraphSelectionController(host);
    const viewport = createViewport();
    const marquee = createElementStub();
    controller.registerViewportElement(viewport);
    controller.registerMarqueeElement(marquee);

    const startEvent = {
      button: 0,
      pointerId: 5,
      clientX: 80,
      clientY: 80,
      preventDefault: jest.fn(),
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
    } as unknown as PointerEvent;

    const harness = installWindowPointerListenerHarness();
    try {
      controller.startMarqueeSelection(startEvent);
      expect(harness.has("pointermove")).toBe(true);
      expect(harness.has("pointerup")).toBe(true);
    } finally {
      harness.restore();
    }

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("pans the viewport for one-finger canvas touch gestures", () => {
    const host = createHost();
    const controller = new StudioGraphSelectionController(host);
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const startEvent = {
      button: 0,
      pointerId: 9,
      clientX: 240,
      clientY: 320,
      preventDefault: jest.fn(),
    } as unknown as PointerEvent;

    const harness = installWindowPointerListenerHarness();
    const movePreventDefault = jest.fn();
    const before = controller.getViewportWorldTopLeft()!;
    try {
      controller.startCanvasPan(startEvent);
      harness.emit(
        "pointermove",
        {
          pointerId: 9,
          clientX: 180,
          clientY: 260,
          preventDefault: movePreventDefault,
        } as PointerEvent
      );
      harness.emit(
        "pointerup",
        {
          pointerId: 9,
          clientX: 180,
          clientY: 260,
        } as PointerEvent
      );
    } finally {
      harness.restore();
    }

    expect(startEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(movePreventDefault).toHaveBeenCalledTimes(1);
    // Dragging the canvas 60px up-left reveals 60 world px more on the right
    // and bottom, whatever the elastic box did to the raw scroll offsets.
    const after = controller.getViewportWorldTopLeft()!;
    expect(after.x - before.x).toBeCloseTo(60, 5);
    expect(after.y - before.y).toBeCloseTo(60, 5);
    expect(controller.consumeSuppressedCanvasClick()).toBe(true);
  });
});
