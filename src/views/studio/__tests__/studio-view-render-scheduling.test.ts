/** @jest-environment jsdom */
import { SystemSculptStudioView } from "../SystemSculptStudioView";

const view = (SystemSculptStudioView as any).prototype;

it("coalesces background render requests into one frame, and a direct render supersedes it", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const request = jest.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.set(nextFrame, callback); return nextFrame++; });
  const cancel = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  const rendered = jest.fn();
  // A hidden leaf: render() itself does nothing past superseding the frame.
  const context: Record<string, any> = { closed: false, leafVisible: false, renderFrame: null, contentEl: document.createElement("div") };
  context.scheduleRender = view.scheduleRender;
  context.cancelScheduledRender = view.cancelScheduledRender;
  context.render = function (this: unknown) { rendered(); view.render.call(this); };
  try {
    context.scheduleRender();
    context.scheduleRender();
    context.scheduleRender();
    expect(frames.size).toBe(1);
    [...frames.values()][0](0);
    expect(rendered).toHaveBeenCalledTimes(1);

    context.scheduleRender();
    expect(frames.size).toBe(2);
    context.render();
    expect(rendered).toHaveBeenCalledTimes(2);
    expect(context.renderFrame).toBeNull();
    expect(frames.has(2)).toBe(false);

    context.closed = true;
    context.scheduleRender();
    expect(context.renderFrame).toBeNull();
  } finally {
    request.mockRestore();
    cancel.mockRestore();
  }
});
