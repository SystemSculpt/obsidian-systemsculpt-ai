/** @jest-environment jsdom */
import { startStudioPointerGesture } from "../StudioPointerGesture";

function pointer(type: string, pointerId: number): PointerEvent {
  const event = new Event(type, { bubbles: true }) as PointerEvent;
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

it("finishes a gesture when its window loses focus, flushing the last move once", () => {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const frames: FrameRequestCallback[] = [];
  const requestFrame = jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
  const cancelFrame = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const onMove = jest.fn(), onFrame = jest.fn(), onFinish = jest.fn(), onCancel = jest.fn();
  try {
    startStudioPointerGesture({ element, event: pointer("pointerdown", 7), onMove, onFrame, onFinish, onCancel });
    window.dispatchEvent(pointer("pointermove", 7));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onFrame).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("blur"));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);

    // Every listener is gone: a later pointerup or move does nothing.
    window.dispatchEvent(pointer("pointermove", 7));
    window.dispatchEvent(pointer("pointerup", 7));
    window.dispatchEvent(new Event("blur"));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  } finally {
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
    element.remove();
  }
});

it("ignores another pointer's release", () => {
  const element = document.createElement("div");
  const onFinish = jest.fn();
  const cancel = startStudioPointerGesture({ element, event: pointer("pointerdown", 1), onMove: jest.fn(), onFrame: jest.fn(), onFinish, onCancel: jest.fn() });
  window.dispatchEvent(pointer("pointerup", 2));
  expect(onFinish).not.toHaveBeenCalled();
  window.dispatchEvent(pointer("pointerup", 1));
  expect(onFinish).toHaveBeenCalledTimes(1);
  cancel();
});
