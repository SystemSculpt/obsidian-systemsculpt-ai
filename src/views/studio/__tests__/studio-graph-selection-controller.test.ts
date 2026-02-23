import { StudioGraphSelectionController } from "../StudioGraphSelectionController";

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
    clientHeight: 900,
  } as unknown as HTMLElement;
}

describe("StudioGraphSelectionController wheel behavior", () => {
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

  it("keeps native scrolling for wheel events inside editable form controls", () => {
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

    expect(preventDefault).not.toHaveBeenCalled();
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(240);
  });

  it("keeps native scrolling for wheel events inside image generation prompt editor", () => {
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

    expect(preventDefault).not.toHaveBeenCalled();
    expect(viewport.scrollLeft).toBe(120);
    expect(viewport.scrollTop).toBe(240);
  });
});
