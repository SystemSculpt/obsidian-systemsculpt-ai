/** @jest-environment jsdom */
import { StudioPortInteraction } from "../StudioPortInteraction";
import { StudioLinkStore } from "../StudioLinkStore";

// jsdom has no PointerEvent and no setPointerCapture; provide minimal shims.
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

function makePin(
  cls: string,
  nodeId: string,
  portId: string,
  rect: Rect
): HTMLElement {
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

describe("StudioPortInteraction drag-to-connect", () => {
  it("still knows the source port when the commit callback fires", () => {
    const store = new StudioLinkStore();

    const canvas = document.createElement("div");
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });

    const sourcePin = makePin("ss-studio-port-pin is-output", "src", "out", {
      left: 0,
      top: 50,
      width: 12,
      height: 12,
    });
    const targetPin = makePin("ss-studio-port-pin is-input", "dst", "in", {
      left: 200,
      top: 200,
      width: 12,
      height: 12,
    });
    document.body.append(canvas, sourcePin, targetPin);

    const host = {
      isBusy: () => false,
      getGraphZoom: () => 1,
      getPortType: () => "text",
      portTypeCompatible: () => true,
      describeConnectionAutoCreate: () => null,
    };

    // The whole point: read the pending source AT THE MOMENT of commit.
    let sourceAtCommit: string | null = "UNSET";
    const interaction = new StudioPortInteraction(host as never, store, {
      onConnectionCommit: () => {
        sourceAtCommit = interaction.getPendingConnectionSourceKey();
      },
      onAutoCreateHint: () => {},
      onAutoCreateRelease: () => false,
      onDragStateChange: () => {},
    });

    interaction.registerCanvas(canvas);
    interaction.registerPortElement("dst", "in", "in", targetPin);

    const down = new FakePointerEvent("pointerdown", {
      button: 0,
      clientX: 6,
      clientY: 56,
      pointerId: 1,
    });
    interaction.startDrag("src", "out", down as unknown as PointerEvent, sourcePin);

    window.dispatchEvent(
      new FakePointerEvent("pointermove", {
        clientX: 206,
        clientY: 206,
        pointerId: 1,
      })
    );

    window.dispatchEvent(
      new FakePointerEvent("pointerup", {
        clientX: 206,
        clientY: 206,
        pointerId: 1,
      })
    );

    expect(sourceAtCommit).toBe("src:out:out");
  });

  it("connects when the drag is released anywhere over another node's card", () => {
    const store = new StudioLinkStore();

    const canvas = document.createElement("div");
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });

    const sourcePin = makePin("ss-studio-port-pin is-output", "src", "out", {
      left: 0,
      top: 50,
      width: 12,
      height: 12,
    });
    // Far outside the pin snap radius: only the card drop can resolve it.
    const targetPin = makePin("ss-studio-port-pin is-input", "dst", "in", {
      left: 400,
      top: 400,
      width: 12,
      height: 12,
    });
    const targetCard = document.createElement("div");
    targetCard.className = "ss-studio-node-card";
    targetCard.dataset.nodeId = "dst";
    targetCard.append(targetPin);
    document.body.append(canvas, sourcePin, targetCard);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint =
      () => targetCard;

    const host = {
      isBusy: () => false,
      getGraphZoom: () => 1,
      getPortType: () => "any",
      portTypeCompatible: () => true,
      describeConnectionAutoCreate: () => null,
    };

    const commits: Array<{ nodeId: string; portId: string }> = [];
    const interaction = new StudioPortInteraction(host as never, store, {
      onConnectionCommit: (target) => commits.push(target),
      onAutoCreateHint: () => {},
      onAutoCreateRelease: () => false,
      onDragStateChange: () => {},
    });

    interaction.registerCanvas(canvas);
    interaction.registerPortElement("dst", "in", "in", targetPin);

    interaction.startDrag(
      "src",
      "out",
      new FakePointerEvent("pointerdown", {
        button: 0,
        clientX: 6,
        clientY: 56,
        pointerId: 1,
      }) as unknown as PointerEvent,
      sourcePin
    );
    window.dispatchEvent(
      new FakePointerEvent("pointermove", { clientX: 500, clientY: 300, pointerId: 1 })
    );
    window.dispatchEvent(
      new FakePointerEvent("pointerup", { clientX: 500, clientY: 300, pointerId: 1 })
    );

    expect(commits).toEqual([{ nodeId: "dst", portId: "in" }]);
  });

  it("never self-connects when the drag is released over its own card", () => {
    const store = new StudioLinkStore();

    const canvas = document.createElement("div");
    (canvas as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect =
      () => rectOf({ left: 0, top: 0, width: 1000, height: 1000 });

    const sourcePin = makePin("ss-studio-port-pin is-output", "src", "out", {
      left: 0,
      top: 50,
      width: 12,
      height: 12,
    });
    const sourceInputPin = makePin("ss-studio-port-pin is-input", "src", "in", {
      left: 0,
      top: 400,
      width: 12,
      height: 12,
    });
    const sourceCard = document.createElement("div");
    sourceCard.className = "ss-studio-node-card";
    sourceCard.dataset.nodeId = "src";
    sourceCard.append(sourcePin, sourceInputPin);
    document.body.append(canvas, sourceCard);
    (document as unknown as { elementFromPoint: () => Element }).elementFromPoint =
      () => sourceCard;

    const host = {
      isBusy: () => false,
      getGraphZoom: () => 1,
      getPortType: () => "any",
      portTypeCompatible: () => true,
      describeConnectionAutoCreate: () => null,
    };

    const commits: Array<{ nodeId: string; portId: string }> = [];
    const interaction = new StudioPortInteraction(host as never, store, {
      onConnectionCommit: (target) => commits.push(target),
      onAutoCreateHint: () => {},
      onAutoCreateRelease: () => false,
      onDragStateChange: () => {},
    });

    interaction.registerCanvas(canvas);
    interaction.registerPortElement("src", "in", "in", sourceInputPin);

    interaction.startDrag(
      "src",
      "out",
      new FakePointerEvent("pointerdown", {
        button: 0,
        clientX: 6,
        clientY: 56,
        pointerId: 1,
      }) as unknown as PointerEvent,
      sourcePin
    );
    window.dispatchEvent(
      new FakePointerEvent("pointermove", { clientX: 6, clientY: 200, pointerId: 1 })
    );
    window.dispatchEvent(
      new FakePointerEvent("pointerup", { clientX: 6, clientY: 200, pointerId: 1 })
    );

    expect(commits).toEqual([]);
  });
});
