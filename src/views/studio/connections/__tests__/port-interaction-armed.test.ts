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
    isBusy: () => false,
    getGraphZoom: () => 1,
    getPortType: () => "text",
    portTypeCompatible: () => true,
    describeConnectionAutoCreate: () => null,
  };
}
function makeInteraction(store: StudioLinkStore) {
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
  document.body.append(canvas, outPin, inPin);
  const interaction = new StudioPortInteraction(makeHost() as never, store, {
    onConnectionCommit: () => {},
    onAutoCreateHint: () => {},
    onAutoCreateRelease: () => false,
    onDragStateChange: () => {},
  });
  interaction.registerCanvas(canvas);
  interaction.registerPortElement("src", "out", "out", outPin);
  interaction.registerPortElement("dst", "in", "in", inPin);
  return { interaction, outPin, inPin };
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

  it("the preview follows the cursor while armed", () => {
    const store = new StudioLinkStore();
    const { interaction } = makeInteraction(store);
    interaction.arm("src", "out");

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 206, clientY: 206 }));

    // Cursor is over the input port center -> it should snap to it.
    expect(store.getDragState()?.snapTarget).toEqual({ nodeId: "dst", portId: "in" });
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
