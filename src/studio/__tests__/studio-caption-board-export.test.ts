/** @jest-environment jsdom */
import { composeStudioCaptionBoardImage, renderStudioCaptionBoardImageFromBytes } from "../StudioCaptionBoardComposition";
import { createEmptyStudioCaptionBoardState, createStudioCaptionBoardAnnotation, createStudioCaptionBoardLabel } from "../StudioCaptionBoardState";

const originalBytes = new TextEncoder().encode("private original image").buffer;
const original = { path: "assets/original.png", hash: "a".repeat(64), sizeBytes: originalBytes.byteLength, mimeType: "image/png" };
const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");

function stateFor(edit: "blur" | "crop" | "label") {
  const state = createEmptyStudioCaptionBoardState();
  if (edit === "blur") state.annotations.push(createStudioCaptionBoardAnnotation({ kind: "blur_rect" }));
  if (edit === "crop") state.crop = { x: 0, y: 0, width: 0.5, height: 0.5 };
  if (edit === "label") state.labels.push(createStudioCaptionBoardLabel({ text: "Caption" }));
  return state;
}

afterEach(() => {
  jest.restoreAllMocks();
  if (bitmapDescriptor) Object.defineProperty(globalThis, "createImageBitmap", bitmapDescriptor);
  else Reflect.deleteProperty(globalThis, "createImageBitmap");
});

describe("Caption board final export", () => {
  it.each(["blur", "crop"] as const)("refuses a recoverable SVG %s export when canvas is unavailable", async edit => {
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const storeAsset = jest.fn();
    await expect(composeStudioCaptionBoardImage({ baseImage: original, boardState: stateFor(edit),
      readAsset: async () => originalBytes, storeAsset })).rejects.toThrow("raster");
    expect(storeAsset).not.toHaveBeenCalled();
  });

  it.each(["blur", "crop"] as const)("refuses a recoverable SVG %s export when image decoding fails", async edit => {
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true,
      value: jest.fn(async () => { throw new Error("decode failed"); }) });
    await expect(renderStudioCaptionBoardImageFromBytes({ baseBytes: originalBytes,
      baseMimeType: "image/png", boardState: stateFor(edit) })).rejects.toThrow("raster");
  });

  it.each(["blur", "crop"] as const)("stores successful raster %s exports and releases decoded resources", async edit => {
    const close = jest.fn();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true,
      value: jest.fn(async () => ({ width: 1600, height: 900, close })) });
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { canvas: this, clearRect: jest.fn(), drawImage: jest.fn(), save: jest.fn(), restore: jest.fn(),
        beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), quadraticCurveTo: jest.fn(), closePath: jest.fn(),
        clip: jest.fn(), fill: jest.fn(), stroke: jest.fn(), fillRect: jest.fn() } as unknown as CanvasRenderingContext2D;
    });
    const encoded = new Uint8Array([7, 8, 9]).buffer;
    jest.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => {
      callback({ arrayBuffer: async () => encoded } as Blob);
    });
    const stored = { ...original, path: "assets/edited.png" };
    const storeAsset = jest.fn(async () => stored);
    await expect(composeStudioCaptionBoardImage({ baseImage: original, boardState: stateFor(edit),
      readAsset: async () => originalBytes, storeAsset })).resolves.toBe(stored);
    expect(storeAsset).toHaveBeenCalledWith(encoded, "image/png");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([3, 4])("rejects final blur export if intermediate canvas %s cannot render", async unavailableCall => {
    const close = jest.fn();
    Object.defineProperty(globalThis, "createImageBitmap", { configurable: true,
      value: jest.fn(async () => ({ width: 1600, height: 900, close })) });
    let calls = 0;
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      if (++calls === unavailableCall) return null;
      return { canvas: this, clearRect: jest.fn(), drawImage: jest.fn() } as unknown as CanvasRenderingContext2D;
    });
    const storeAsset = jest.fn();
    await expect(composeStudioCaptionBoardImage({ baseImage: original, boardState: stateFor("blur"),
      readAsset: async () => originalBytes, storeAsset })).rejects.toThrow("raster");
    expect(storeAsset).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps SVG fallback for captions and editor previews", async () => {
    jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    for (const [edit, mode] of [["label", "final"], ["blur", "editor"], ["crop", "editor"]] as const) {
      const rendered = await renderStudioCaptionBoardImageFromBytes({ baseBytes: originalBytes,
        baseMimeType: "image/png", boardState: stateFor(edit), mode });
      expect(rendered.mimeType).toBe("image/svg+xml");
    }
  });
});
