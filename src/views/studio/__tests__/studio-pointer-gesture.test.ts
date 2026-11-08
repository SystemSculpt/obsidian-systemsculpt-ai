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

it.each(["pointercancel", "escape", "superseded"])("cancels a gesture on %s without leaking its pending frame", reason => {
  const element = document.createElement("div");
  const onMove = jest.fn(), onFrame = jest.fn(), onFinish = jest.fn(), onCancel = jest.fn();
  const requestFrame = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
  const cancelFrame = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  let nextCancel: (() => void) | undefined;
  try {
    const cancel = startStudioPointerGesture({ element, event: pointer("pointerdown", 1), onMove, onFrame, onFinish, onCancel });
    window.dispatchEvent(pointer("pointermove", 1));
    if (reason === "pointercancel") window.dispatchEvent(pointer("pointercancel", 1));
    if (reason === "escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (reason === "superseded") nextCancel = startStudioPointerGesture({ element, event: pointer("pointerdown", 2), onMove: jest.fn(), onFrame: jest.fn(), onFinish: jest.fn(), onCancel: jest.fn() });
    window.dispatchEvent(pointer("pointermove", 1));
    window.dispatchEvent(pointer("pointerup", 1));
    cancel();
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
    expect(onFrame).not.toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(42);
  } finally {
    nextCancel?.();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  }
});

it("keeps gestures in different owner windows isolated", () => {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const otherWindow = frame.contentWindow!;
  const first = document.createElement("div");
  const second = frame.contentDocument!.createElement("div");
  const firstFinish = jest.fn(), firstCancel = jest.fn(), secondFinish = jest.fn();
  const cancelFirst = startStudioPointerGesture({ element: first, event: pointer("pointerdown", 1), onMove: jest.fn(), onFrame: jest.fn(), onFinish: firstFinish, onCancel: firstCancel });
  const cancelSecond = startStudioPointerGesture({ element: second, event: pointer("pointerdown", 1), onMove: jest.fn(), onFrame: jest.fn(), onFinish: secondFinish, onCancel: jest.fn() });
  try {
    otherWindow.dispatchEvent(pointer("pointerup", 1));
    expect(secondFinish).toHaveBeenCalledTimes(1);
    expect(firstFinish).not.toHaveBeenCalled();
    expect(firstCancel).not.toHaveBeenCalled();
    window.dispatchEvent(pointer("pointerup", 1));
    expect(firstFinish).toHaveBeenCalledTimes(1);
  } finally { cancelFirst(); cancelSecond(); frame.remove(); }
});

it("finishes once when its element loses pointer capture", () => {
  const element = document.createElement("div");
  const onFinish = jest.fn();
  startStudioPointerGesture({ element, event: pointer("pointerdown", 1), onMove: jest.fn(), onFrame: jest.fn(), onFinish, onCancel: jest.fn() });
  element.dispatchEvent(pointer("lostpointercapture", 2));
  expect(onFinish).not.toHaveBeenCalled();
  element.dispatchEvent(pointer("lostpointercapture", 1));
  window.dispatchEvent(pointer("pointerup", 1));
  expect(onFinish).toHaveBeenCalledTimes(1);
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
