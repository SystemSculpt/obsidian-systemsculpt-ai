/**
 * jsdom has no canvas. These stand-ins let the editor mount, measure text,
 * paint, and export so its behaviour can be tested through the DOM.
 */

export const TEST_IMAGE_SIZE = { width: 400, height: 200 };

const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");

export function installImageBoardTestCanvas(): { encoded: ArrayBuffer } {
  const contexts = new WeakMap<HTMLCanvasElement, unknown>();
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    const existing = contexts.get(this);
    if (existing) return existing as CanvasRenderingContext2D;
    const context: Record<string, unknown> = { canvas: this };
    for (const name of [
      "setTransform", "clearRect", "save", "restore", "drawImage", "fillRect", "beginPath", "rect", "clip",
      "fill", "stroke", "moveTo", "lineTo", "quadraticCurveTo", "closePath", "ellipse", "fillText", "strokeText",
      "putImageData",
    ]) {
      context[name] = jest.fn();
    }
    // Half an em a character at whatever size the font is set to.
    context.measureText = (text: string) => ({
      width: text.length * Number(/(\d+(?:\.\d+)?)px/.exec(String(context.font))?.[1] ?? 16) * 0.5,
    });
    context.getImageData = (_x: number, _y: number, width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    });
    context.createImageData = (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    });
    context.createPattern = () => ({});
    context.createLinearGradient = () => ({ addColorStop: () => undefined });
    contexts.set(this, context);
    return context as unknown as CanvasRenderingContext2D;
  });
  const encoded = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
  jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback({ arrayBuffer: async () => encoded } as Blob);
  });
  // One screen pixel per image pixel: pointer coordinates read directly as image coordinates.
  jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, x: 0, y: 0, right: TEST_IMAGE_SIZE.width, bottom: TEST_IMAGE_SIZE.height,
    width: TEST_IMAGE_SIZE.width, height: TEST_IMAGE_SIZE.height, toJSON: () => ({}),
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: jest.fn(async () => ({ ...TEST_IMAGE_SIZE, close: jest.fn() })),
  });
  return { encoded };
}

export function restoreImageBoardTestCanvas(): void {
  jest.restoreAllMocks();
  if (bitmapDescriptor) Object.defineProperty(globalThis, "createImageBitmap", bitmapDescriptor);
  else Reflect.deleteProperty(globalThis, "createImageBitmap");
}

export function pointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  x: number,
  y: number,
  init: { shiftKey?: boolean } = {}
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    shiftKey: init.shiftKey ?? false,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  target.dispatchEvent(event);
}

/** Press on `target`, optionally travel through points, and release. */
export function drag(
  target: EventTarget,
  from: [number, number],
  ...through: Array<[number, number]>
): void {
  pointer(target, "pointerdown", from[0], from[1]);
  for (const [x, y] of through) {
    pointer(window, "pointermove", x, y);
  }
  const [endX, endY] = through[through.length - 1] ?? from;
  pointer(window, "pointerup", endX, endY);
}

export async function flushImageBoard(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
