/** @jest-environment jsdom */
import { StudioPortInteraction } from "../StudioPortInteraction";
import { StudioLinkStore } from "../StudioLinkStore";

// jsdom has no PointerEvent; provide the minimal shim Plan 001's harness uses.
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

type Rect = { left: number; top: number; width: number; height: number };
function rectOf(r: Rect): DOMRect {
  return {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    right: r.left + r.width,
    bottom: r.top + r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  } as DOMRect;
}
function makePin(cls: string, nodeId: string, portId: string, rect: Rect): HTMLElement {
  const el = document.createElement("button");
  el.className = cls;
  el.dataset.nodeId = nodeId;
  el.dataset.portId = portId;
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => rectOf(rect);
  (el as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  (el as unknown as { releasePointerCapture: () => void }).releasePointerCapture =
    () => {};
  return el;
}
function makeHost() {
  return {
    getCurrentProject: () => null,
    isBusy: () => false,
    getGraphZoom: () => 1,
    getPortType: () => "text",
    portTypeCompatible: () => true,
    describeConnectionAutoCreate: () => null,
  };
}
// Armed moves are drawn on the next animation frame; tests run the frames themselves.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation((handle) => {
    frames.delete(handle);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  document.body.replaceChildren();
});
function runFrames(): void {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
}

function makeInteraction(store: StudioLinkStore) {
  const workspace = document.createElement("div");
  const viewport = workspace.appendChild(document.createElement("div"));
  const controls = workspace.appendChild(document.createElement("div"));
  controls.className = "ss-studio-graph-workspace-controls";
  const zoomOut = controls.appendChild(document.createElement("button"));
  const elsewhere = document.createElement("div");
  const canvas = document.createElement("div");
  (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
    () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });
  const outPin = makePin("ss-studio-port-pin is-output", "src", "out", {
    left: 0,
    top: 50,
    width: 12,
    height: 12,
  });
  const inPin = makePin("ss-studio-port-pin is-input", "dst", "in", {
    left: 200,
    top: 200,
    width: 12,
    height: 12,
  });
  viewport.append(canvas, outPin, inPin);
  document.body.append(workspace, elsewhere);
  const interaction = new StudioPortInteraction(makeHost() as never, store, {
    onConnectionCommit: () => {},
    onAutoCreateHint: () => {},
    onAutoCreateRelease: () => false,
    onDragStateChange: () => {},
  });
  interaction.registerViewport(viewport);
  interaction.registerCanvas(canvas);
  interaction.registerPortElement("src", "out", "out", outPin);
  interaction.registerPortElement("dst", "in", "in", inPin);
  return { interaction, outPin, inPin, viewport, canvas, zoomOut, elsewhere };
}

describe("StudioPortInteraction armed (click-to-connect)", () => {
  it("arming an output sets a pending source and shows a preview", () => {
    const store = new StudioLinkStore();
    const { interaction, outPin } = makeInteraction(store);

    interaction.arm("src", "out");

    expect(interaction.getPendingConnectionSourceKey()).toBe("src:out:out");
    expect(outPin.getAttribute("aria-pressed")).toBe("true");
    expect(store.getDragState()).not.toBeNull();
    expect(store.getDragState()?.source).toEqual({ nodeId: "src", portId: "out" });
  });

  it("the preview follows the cursor over the viewport, once per frame", () => {
    const store = new StudioLinkStore();
    const { interaction, viewport, canvas } = makeInteraction(store);
    interaction.arm("src", "out");
    const emitted = jest.fn();
    store.subscribe(emitted);
    const measure = jest.spyOn(canvas, "getBoundingClientRect");

    for (const point of [80, 120, 160, 206]) {
      viewport.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: point, clientY: point }));
    }
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(measure).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();

    runFrames();

    // One measurement and one store update, at the last point: over the input port's center.
    expect(measure).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(store.getDragState()?.snapTarget).toEqual({ nodeId: "dst", portId: "in" });

    viewport.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 500, clientY: 500 }));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it("moves outside the viewport cost nothing while armed", () => {
    const store = new StudioLinkStore();
    const { interaction, canvas, elsewhere } = makeInteraction(store);
    interaction.arm("src", "out");
    const before = store.getDragState();
    const measure = jest.spyOn(canvas, "getBoundingClientRect");

    elsewhere.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 206, clientY: 206 }));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 206, clientY: 206 }));
    runFrames();

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(measure).not.toHaveBeenCalled();
    expect(store.getDragState()).toBe(before);
  });

  it("clicking the same output again cancels (toggle off)", () => {
    const store = new StudioLinkStore();
    const { interaction, outPin } = makeInteraction(store);

    interaction.arm("src", "out");
    interaction.arm("src", "out");

    expect(interaction.getPendingConnectionSourceKey()).toBeNull();
    expect(store.getDragState()).toBeNull();
    expect(outPin.getAttribute("aria-pressed")).toBe("false");
  });

  it("Escape cancels the armed connection", () => {
    const store = new StudioLinkStore();
    const { interaction } = makeInteraction(store);
    interaction.arm("src", "out");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(interaction.getPendingConnectionSourceKey()).toBeNull();
    expect(store.getDragState()).toBeNull();
  });

  function expectDisarmed(store: StudioLinkStore, interaction: StudioPortInteraction, inPin: HTMLElement) {
    expect(interaction.getPendingConnectionSourceKey()).toBeNull();
    expect(store.getDragState()).toBeNull();
    // No compatible input keeps its halo running.
    expect(inPin.classList.contains("is-drop-target")).toBe(false);
  }

  it("the window losing focus cancels the armed connection", () => {
    const store = new StudioLinkStore();
    const { interaction, inPin } = makeInteraction(store);
    interaction.arm("src", "out");
    expect(inPin.classList.contains("is-drop-target")).toBe(true);

    window.dispatchEvent(new FocusEvent("blur"));

    expectDisarmed(store, interaction, inPin);
  });

  it("a press outside the viewport cancels the armed connection", () => {
    const store = new StudioLinkStore();
    const { interaction, inPin, elsewhere } = makeInteraction(store);
    interaction.arm("src", "out");

    elsewhere.dispatchEvent(new FakePointerEvent("pointerdown", { bubbles: true, button: 0 }));

    expectDisarmed(store, interaction, inPin);
  });

  it("presses inside the viewport and on the graph's zoom controls keep the connection", () => {
    const store = new StudioLinkStore();
    const { interaction, inPin, canvas, zoomOut } = makeInteraction(store);
    interaction.arm("src", "out");

    canvas.dispatchEvent(new FakePointerEvent("pointerdown", { bubbles: true, button: 0 }));
    inPin.dispatchEvent(new FakePointerEvent("pointerdown", { bubbles: true, button: 0 }));
    zoomOut.dispatchEvent(new FakePointerEvent("pointerdown", { bubbles: true, button: 0 }));

    expect(interaction.getPendingConnectionSourceKey()).toBe("src:out:out");
    expect(inPin.classList.contains("is-drop-target")).toBe(true);
  });

  it("another graph's controls are outside this viewport", () => {
    const store = new StudioLinkStore();
    const { interaction, inPin } = makeInteraction(store);
    interaction.arm("src", "out");
    const otherControls = document.body.appendChild(document.createElement("div"));
    otherControls.className = "ss-studio-graph-workspace-controls";

    otherControls.dispatchEvent(new FakePointerEvent("pointerdown", { bubbles: true, button: 0 }));

    expectDisarmed(store, interaction, inPin);
  });

  it("cancelling drops a pending frame and every armed listener", () => {
    const store = new StudioLinkStore();
    const { interaction, viewport, canvas, elsewhere } = makeInteraction(store);
    interaction.arm("src", "out");
    viewport.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 206, clientY: 206 }));
    expect(frames.size).toBe(1);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(frames.size).toBe(0);

    const emitted = jest.fn();
    store.subscribe(emitted);
    const measure = jest.spyOn(canvas, "getBoundingClientRect");
    viewport.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 100, clientY: 100 }));
    window.dispatchEvent(new FocusEvent("blur"));
    elsewhere.dispatchEvent(new FakePointerEvent("pointerdown", { bubbles: true, button: 0 }));
    runFrames();
    expect(measure).not.toHaveBeenCalled();
    expect(emitted).not.toHaveBeenCalled();
  });

  it("a plain output click (press-release, no drag) is NOT suppressed", () => {
    const store = new StudioLinkStore();
    const { interaction, outPin } = makeInteraction(store);

    const down = new FakePointerEvent("pointerdown", {
      button: 0,
      clientX: 6,
      clientY: 56,
      pointerId: 1,
    });
    interaction.startDrag("src", "out", down as unknown as PointerEvent, outPin);
    // Release at the same point: never crosses the activation threshold.
    window.dispatchEvent(
      new FakePointerEvent("pointerup", { clientX: 6, clientY: 56, pointerId: 1 })
    );

    // Not suppressed -> the trailing click reaches beginConnection -> arm.
    expect(interaction.consumeSuppressedOutputClick("src", "out")).toBe(false);
  });

  it("a real drag DOES suppress the trailing output click", () => {
    const store = new StudioLinkStore();
    const { interaction, outPin } = makeInteraction(store);

    const down = new FakePointerEvent("pointerdown", {
      button: 0,
      clientX: 6,
      clientY: 56,
      pointerId: 1,
    });
    interaction.startDrag("src", "out", down as unknown as PointerEvent, outPin);
    window.dispatchEvent(
      new FakePointerEvent("pointermove", { clientX: 206, clientY: 206, pointerId: 1 })
    );
    window.dispatchEvent(
      new FakePointerEvent("pointerup", { clientX: 206, clientY: 206, pointerId: 1 })
    );

    // Suppressed once -> prevents a phantom re-arm right after the drag.
    expect(interaction.consumeSuppressedOutputClick("src", "out")).toBe(true);
  });
});
