/**
 * @jest-environment jsdom
 */
import { startStudioShapeDrawGesture } from "../StudioShapeDrawGesture";

function pointerEvent(type: string, clientX: number, clientY: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event as PointerEvent;
}

function drawOn(
  canvas: HTMLElement,
  options?: { zoom?: number; onCancel?: () => void }
): { commits: Array<{ x: number; y: number; width: number; height: number }> } {
  const commits: Array<{ x: number; y: number; width: number; height: number }> = [];
  startStudioShapeDrawGesture({
    canvasEl: canvas,
    startEvent: pointerEvent("pointerdown", 100, 100),
    shape: "rectangle",
    getGraphZoom: () => options?.zoom ?? 1,
    minWidth: 48,
    minHeight: 48,
    defaultWidth: 180,
    defaultHeight: 120,
    onCommit: (rect) => commits.push(rect),
    onCancel: options?.onCancel,
  });
  return { commits };
}

describe("studio shape draw gesture", () => {
  let canvas: HTMLElement;

  beforeEach(() => {
    document.body.empty();
    canvas = document.body.createDiv({ cls: "ss-studio-graph-canvas" });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  });

  it("paints a live preview while dragging and removes it on release", () => {
    const { commits } = drawOn(canvas);

    expect(canvas.querySelector(".ss-studio-shape-draw-preview")).not.toBeNull();
    window.dispatchEvent(pointerEvent("pointermove", 260, 220));
    const preview = canvas.querySelector<HTMLElement>(".ss-studio-shape-draw-preview")!;
    expect(preview.style.left).toBe("100px");
    expect(preview.style.width).toBe("160px");
    expect(preview.style.height).toBe("120px");

    window.dispatchEvent(pointerEvent("pointerup", 260, 220));
    expect(canvas.querySelector(".ss-studio-shape-draw-preview")).toBeNull();
    expect(commits).toEqual([{ x: 100, y: 100, width: 160, height: 120 }]);
  });

  it("commits the drawn bounds in graph coordinates under zoom", () => {
    const { commits } = drawOn(canvas, { zoom: 2 });

    window.dispatchEvent(pointerEvent("pointerup", 300, 300));

    expect(commits).toEqual([{ x: 50, y: 50, width: 100, height: 100 }]);
  });

  it("drags backwards into a normalized rect", () => {
    const { commits } = drawOn(canvas);

    window.dispatchEvent(pointerEvent("pointerup", 20, 30));

    expect(commits).toEqual([{ x: 20, y: 30, width: 80, height: 70 }]);
  });

  it("falls back to the default size for a tap", () => {
    const { commits } = drawOn(canvas);

    window.dispatchEvent(pointerEvent("pointerup", 102, 101));

    expect(commits).toEqual([{ x: 10, y: 40, width: 180, height: 120 }]);
  });

  it("grows a too-small drawn box to the shape minimum", () => {
    const { commits } = drawOn(canvas);

    window.dispatchEvent(pointerEvent("pointerup", 120, 130));

    expect(commits).toEqual([{ x: 100, y: 100, width: 48, height: 48 }]);
  });

  it("cancels on Escape without committing", () => {
    const onCancel = jest.fn();
    const { commits } = drawOn(canvas, { onCancel });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(commits).toEqual([]);
    expect(canvas.querySelector(".ss-studio-shape-draw-preview")).toBeNull();
  });
});
