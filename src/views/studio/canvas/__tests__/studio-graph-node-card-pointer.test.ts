/**
 * @jest-environment jsdom
 */
import {
  bindNodeCardPointerDown,
  isStudioNodeCardInteractiveTarget,
  markStudioNodeCardInteractive,
  STUDIO_NODE_CARD_INTERACTIVE_ATTR,
} from "../StudioGraphNodeCardPointer";

function createGraphInteractionStub() {
  return {
    startNodeDrag: jest.fn(),
    toggleNodeSelection: jest.fn(),
  };
}

function createPointerEvent(
  options: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {}
): PointerEvent {
  return new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    ...options,
  }) as PointerEvent;
}

describe("StudioGraphNodeCardPointer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  describe("isStudioNodeCardInteractiveTarget", () => {
    it("treats native controls, links, and pins as interactive", () => {
      const host = document.body.createDiv();
      const button = host.createEl("button");
      const iconInsideButton = button.createSpan();
      const input = host.createEl("input");
      const link = host.createEl("a");
      const pin = host.createEl("button", { cls: "ss-studio-port-pin" });

      for (const el of [button, iconInsideButton, input, link, pin]) {
        expect(isStudioNodeCardInteractiveTarget(el)).toBe(true);
      }
    });

    it("treats plain card body as inert", () => {
      const host = document.body.createDiv();
      const body = host.createDiv({ cls: "ss-studio-node-media-preview" });

      expect(isStudioNodeCardInteractiveTarget(body)).toBe(false);
      expect(isStudioNodeCardInteractiveTarget(null)).toBe(false);
    });

    it("exempts everything inside a marked interactive surface", () => {
      const host = document.body.createDiv();
      const toolbar = host.createDiv();
      markStudioNodeCardInteractive(toolbar);
      const divider = toolbar.createDiv({ cls: "some-divider" });

      expect(toolbar.hasAttribute(STUDIO_NODE_CARD_INTERACTIVE_ATTR)).toBe(true);
      expect(isStudioNodeCardInteractiveTarget(toolbar)).toBe(true);
      expect(isStudioNodeCardInteractiveTarget(divider)).toBe(true);
    });
  });

  describe("bindNodeCardPointerDown", () => {
    it("starts a drag from the card body", () => {
      const graphInteraction = createGraphInteractionStub();
      const nodeEl = document.body.createDiv();
      const body = nodeEl.createDiv();
      bindNodeCardPointerDown({
        nodeEl,
        nodeId: "node_1",
        graphInteraction: graphInteraction as never,
      });

      body.dispatchEvent(createPointerEvent());

      expect(graphInteraction.startNodeDrag).toHaveBeenCalledWith(
        "node_1",
        expect.any(MouseEvent),
        nodeEl
      );
    });

    it("toggles selection instead of dragging on modifier pointerdown", () => {
      const graphInteraction = createGraphInteractionStub();
      const nodeEl = document.body.createDiv();
      bindNodeCardPointerDown({
        nodeEl,
        nodeId: "node_1",
        graphInteraction: graphInteraction as never,
      });

      nodeEl.dispatchEvent(createPointerEvent({ shiftKey: true }));

      expect(graphInteraction.toggleNodeSelection).toHaveBeenCalledWith("node_1");
      expect(graphInteraction.startNodeDrag).not.toHaveBeenCalled();
    });

    it("leaves interactive surfaces alone — no drag, no selection toggle", () => {
      const graphInteraction = createGraphInteractionStub();
      const nodeEl = document.body.createDiv();
      const toolbar = nodeEl.createDiv();
      markStudioNodeCardInteractive(toolbar);
      const divider = toolbar.createDiv();
      const button = nodeEl.createEl("button");
      bindNodeCardPointerDown({
        nodeEl,
        nodeId: "node_1",
        graphInteraction: graphInteraction as never,
      });

      toolbar.dispatchEvent(createPointerEvent());
      divider.dispatchEvent(createPointerEvent());
      button.dispatchEvent(createPointerEvent());
      divider.dispatchEvent(createPointerEvent({ shiftKey: true }));

      expect(graphInteraction.startNodeDrag).not.toHaveBeenCalled();
      expect(graphInteraction.toggleNodeSelection).not.toHaveBeenCalled();
    });
  });
});
