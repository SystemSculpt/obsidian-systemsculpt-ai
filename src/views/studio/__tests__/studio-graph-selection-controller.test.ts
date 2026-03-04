import { StudioGraphSelectionController } from "../StudioGraphSelectionController";
import {
  createElementStub,
  installWindowPointerListenerHarness,
} from "./studio-graph-pointer-test-helpers";

type TestHost = ConstructorParameters<typeof StudioGraphSelectionController>[0];

function createHost(): TestHost {
  return {
    isBusy: () => false,
    getCurrentProject: () => null,
    renderEdgeLayer: () => undefined,
    scheduleProjectSave: () => undefined,
  };
}

function createViewport(): HTMLElement {
  return {
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

  it("keeps native scrolling for wheel events inside inspector overlays", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes(".ss-studio-node-inspector") ? ({} as Element) : null,
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

  it("pans the canvas for wheel events over unfocused editable form controls", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes("textarea") ? ({} as Element) : null,
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
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes("textarea") ? ({} as Element) : null,
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

  it("keeps native scrolling for wheel events inside focused editable form controls", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);

    const focusedTextarea = {} as Element;
    const originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      activeElement: focusedTextarea,
    };

    try {
      const preventDefault = jest.fn();
      const event = {
        target: {
          closest: (selector: string) =>
            selector.includes("textarea") ? focusedTextarea : null,
        },
        ctrlKey: false,
        metaKey: false,
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
    } finally {
      if (typeof originalDocument === "undefined") {
        delete (globalThis as { document?: unknown }).document;
      } else {
        (globalThis as { document?: unknown }).document = originalDocument;
      }
    }
  });

  it("zooms the canvas for ctrl+wheel events inside editable form controls", () => {
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

  it("still defers ctrl+wheel events inside inspector overlays", () => {
    const controller = new StudioGraphSelectionController(createHost());
    const viewport = createViewport();
    controller.registerViewportElement(viewport);
    const initialZoom = controller.getGraphZoom();

    const preventDefault = jest.fn();
    const event = {
      target: {
        closest: (selector: string) =>
          selector.includes(".ss-studio-node-inspector") ? ({} as Element) : null,
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

    expect(preventDefault).not.toHaveBeenCalled();
    expect(controller.getGraphZoom()).toBe(initialZoom);
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
    expect(controller.getGraphZoom()).toBeCloseTo(950 / 700, 5);
    expect(viewport.scrollLeft).toBeCloseTo(110.7142857, 5);
    expect(viewport.scrollTop).toBeCloseTo(242.8571429, 5);
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
});

describe("StudioGraphSelectionController drag behavior", () => {
  it("allows dragging regular nodes while busy so layout can be reorganized during runs", () => {
    const host = createHost();
    const scheduleProjectSave = jest.fn();
    const renderEdgeLayer = jest.fn();
    host.isBusy = () => true;
    host.scheduleProjectSave = scheduleProjectSave;
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
    host.getCurrentProject = () => project;

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
    try {
      controller.startNodeDrag("node_1", startEvent, nodeEl);
      harness.emit(
        "pointermove",
        {
          pointerId: 11,
          clientX: 140,
          clientY: 180,
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
    expect(project.graph.nodes[0].position).toEqual({ x: 80, y: 110 });
    expect(nodeEl.style.transform).toBe("translate(80px, 110px)");
    expect(renderEdgeLayer).toHaveBeenCalled();
    expect(scheduleProjectSave).toHaveBeenCalledTimes(1);
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
});
