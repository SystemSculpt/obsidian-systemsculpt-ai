/** @jest-environment jsdom */
import { encodeStudioImageBoard } from "../StudioImageBoardEncoding";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const png = new Uint8Array([137, 80, 78, 71]).buffer;

function chunk(kind: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length + (payload.length & 1));
  bytes.set(text(kind));
  new DataView(bytes.buffer).setUint32(4, payload.length, true);
  bytes.set(payload, 8);
  return bytes;
}

function riff(...chunks: Uint8Array[]): ArrayBuffer {
  const bytes = new Uint8Array(12 + chunks.reduce((sum, value) => sum + value.length, 0));
  bytes.set(text("RIFF"));
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(text("WEBP"), 8);
  let offset = 12;
  for (const value of chunks) { bytes.set(value, offset); offset += value.length; }
  return bytes.buffer;
}

function lossless(width: number = 3, height: number = 2): Uint8Array {
  const header = new Uint8Array(6);
  header[0] = 0x2f;
  new DataView(header.buffer).setUint32(1, (width - 1) | ((height - 1) << 14), true);
  return chunk("VP8L", header);
}

function extended(flags: number = 0): Uint8Array {
  return chunk("VP8X", new Uint8Array([flags, 0, 0, 0, 2, 0, 0, 1, 0, 0]));
}

function harness(webp: ArrayBuffer = riff(lossless()), mimeType: string = "image/webp") {
  const canvas = document.createElement("canvas");
  canvas.width = 3;
  canvas.height = 2;
  const getImageData = jest.fn((_x: number, _y: number, width: number, height: number) => ({
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  }));
  const context = { canvas, getImageData } as unknown as CanvasRenderingContext2D;
  const toBlob = jest.spyOn(canvas, "toBlob").mockImplementation((callback, requested) => {
    callback({
      type: requested === "image/webp" ? mimeType : "image/png",
      arrayBuffer: async () => requested === "image/webp" ? webp : png,
    } as Blob);
  });
  return { canvas, context, getImageData, toBlob, webp };
}

afterEach(() => jest.restoreAllMocks());

describe("image board encoding", () => {
  it.each(["image/jpeg", "image/webp", "IMAGE/JPEG; charset=binary"])(
    "stores opaque %s edits as verified lossless WebP at explicit quality one", async (source) => {
      const h = harness();
      await expect(encodeStudioImageBoard(h.context, source)).resolves.toEqual({ bytes: h.webp, mimeType: "image/webp" });
      expect(h.toBlob).toHaveBeenCalledTimes(1);
      expect(h.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 1);
    }
  );

  it("accepts a static extended lossless container with metadata", async () => {
    const h = harness(riff(extended(0x08), lossless(), chunk("EXIF", new Uint8Array([1]))));
    await expect(encodeStudioImageBoard(h.context, "image/jpeg")).resolves.toEqual({ bytes: h.webp, mimeType: "image/webp" });
  });

  it.each([undefined, "image/png", "image/svg+xml", "image/avif"])(
    "keeps %s and clipboard renders PNG without reading back pixels", async (source) => {
      const h = harness();
      await expect(encodeStudioImageBoard(h.context, source)).resolves.toEqual({ bytes: png, mimeType: "image/png" });
      expect(h.getImageData).not.toHaveBeenCalled();
      expect(h.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png", undefined);
    }
  );

  it("keeps even one partially transparent pixel PNG, including a final readback band", async () => {
    const h = harness();
    h.canvas.height = 65;
    h.getImageData.mockImplementation((_x, y, width, height) => {
      const data = new Uint8ClampedArray(width * height * 4).fill(255);
      if (y === 64) data[data.length - 1] = 254;
      return { data };
    });
    await expect(encodeStudioImageBoard(h.context, "image/jpeg")).resolves.toEqual({ bytes: png, mimeType: "image/png" });
    expect(h.getImageData.mock.calls).toEqual([[0, 0, 3, 64], [0, 64, 3, 1]]);
    expect(h.toBlob).toHaveBeenCalledTimes(1);
  });

  it("reuses PNG returned by an unsupported WebP encoder with its actual MIME", async () => {
    const h = harness(png, "image/png");
    await expect(encodeStudioImageBoard(h.context, "image/webp")).resolves.toEqual({ bytes: png, mimeType: "image/png" });
    expect(h.toBlob).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["lossy payload", riff(chunk("VP8 ", new Uint8Array([1, 2, 3])))],
    ["codec name inside metadata", riff(extended(), chunk("EXIF", text("VP8L")), chunk("VP8 ", new Uint8Array([1])))],
    ["animation flag", riff(extended(2), lossless())],
    ["animation chunk", riff(extended(), chunk("ANIM", new Uint8Array(6)), lossless())],
    ["frame chunk", riff(extended(), chunk("ANMF", new Uint8Array(16)), lossless())],
    ["separate lossy alpha", riff(extended(), chunk("ALPH", new Uint8Array(1)), lossless())],
    ["two images", riff(lossless(), lossless())],
    ["two extended headers", riff(extended(), extended(), lossless())],
    ["wrong image dimensions", riff(lossless(4, 2))],
    ["wrong extended dimensions", riff(extended(), lossless(4, 2))],
    ["reserved flags", riff(extended(1), lossless())],
    ["short extended header", riff(chunk("VP8X", new Uint8Array(9)), lossless())],
    ["bad signature", riff(chunk("VP8L", new Uint8Array(6)))],
    ["short image header", riff(chunk("VP8L", new Uint8Array([0x2f])))],
    ["missing image", riff(extended())],
    ["truncated container", riff(lossless()).slice(0, -1)],
    ["wrong file type", png],
  ])("rejects %s rather than silently saving lossy or malformed WebP", async (_name, bytes) => {
    const h = harness(bytes as ArrayBuffer);
    await expect(encodeStudioImageBoard(h.context, "image/jpeg")).resolves.toEqual({ bytes: png, mimeType: "image/png" });
    expect(h.toBlob).toHaveBeenCalledTimes(2);
  });

  it.each(["length", "padding", "version", "chunk length", "trailing header"])(
    "rejects corrupt %s", async (kind) => {
      let bytes = riff(chunk("VP8L", new Uint8Array([0x2f, 2, 0x40, 0, 0])));
      const data = new DataView(bytes);
      if (kind === "length") data.setUint32(4, bytes.byteLength, true);
      if (kind === "padding") data.setUint8(bytes.byteLength - 1, 1);
      if (kind === "version") data.setUint8(24, 0xe0);
      if (kind === "chunk length") data.setUint32(16, 0xffffffff, true);
      if (kind === "trailing header") {
        const extendedBytes = new Uint8Array(bytes.byteLength + 1);
        extendedBytes.set(new Uint8Array(bytes));
        bytes = extendedBytes.buffer;
        new DataView(bytes).setUint32(4, bytes.byteLength - 8, true);
      }
      const h = harness(bytes);
      await expect(encodeStudioImageBoard(h.context, "image/jpeg")).resolves.toEqual({ bytes: png, mimeType: "image/png" });
    }
  );

  it.each(["readback", "encoder"])("falls back to PNG after %s failure", async (failure) => {
    const h = harness();
    if (failure === "readback") h.getImageData.mockImplementation(() => { throw new Error("unavailable"); });
    else h.toBlob.mockImplementationOnce((callback) => callback(null));
    await expect(encodeStudioImageBoard(h.context, "image/jpeg")).resolves.toEqual({ bytes: png, mimeType: "image/png" });
  });

  it("supports the data URL path and checks its actual MIME and codec", async () => {
    const h = harness();
    Object.defineProperty(h.canvas, "toBlob", { value: undefined });
    const toDataURL = jest.spyOn(h.canvas, "toDataURL").mockReturnValue(
      `data:image/webp;base64,${btoa(String.fromCharCode(...new Uint8Array(h.webp)))}`
    );
    await expect(encodeStudioImageBoard(h.context, "image/jpeg")).resolves.toEqual({ bytes: h.webp, mimeType: "image/webp" });
    expect(toDataURL).toHaveBeenCalledWith("image/webp", 1);
    toDataURL.mockReturnValue(`data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(png)))}`);
    await expect(encodeStudioImageBoard(h.context, "image/jpeg")).resolves.toEqual({ bytes: png, mimeType: "image/png" });
  });

  it("fails closed when neither encoder can produce an image", async () => {
    const h = harness();
    h.toBlob.mockImplementation((callback) => callback(null));
    await expect(encodeStudioImageBoard(h.context, "image/jpeg")).rejects.toThrow("could not be encoded");
  });
});
