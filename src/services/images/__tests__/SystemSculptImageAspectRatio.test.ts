import {
  inferClosestSystemSculptAspectRatio,
  readImageDimensionsFromArrayBuffer,
  resolveSystemSculptImageAspectRatio,
} from "../SystemSculptImageAspectRatio";

function fakePngBytes(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes.buffer;
}

describe("SystemSculptImageAspectRatio", () => {
  it("reads PNG dimensions from image bytes", () => {
    expect(readImageDimensionsFromArrayBuffer(fakePngBytes(1500, 1000))).toEqual({
      width: 1500,
      height: 1000,
    });
  });

  it("maps wide legacy ratios to the nearest supported server ratio", () => {
    expect(inferClosestSystemSculptAspectRatio(2100, 900)).toBe("16:9");
    expect(resolveSystemSculptImageAspectRatio({ requestedAspectRatio: "21:9" })).toBe("16:9");
  });

  it("resolves match_input_image from the uploaded input bytes", () => {
    expect(
      resolveSystemSculptImageAspectRatio({
        requestedAspectRatio: "match_input_image",
        inputImageBytes: [fakePngBytes(1500, 1000)],
      })
    ).toBe("3:2");
  });
});
