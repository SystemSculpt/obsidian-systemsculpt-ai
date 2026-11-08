export type StudioEncodedImageBoard = {
  bytes: ArrayBuffer;
  mimeType: "image/png" | "image/webp";
};

const PNG = "image/png";
const WEBP = "image/webp";

/** Check the container, not a codec name that could occur inside metadata. */
function isLosslessWebp(bytes: ArrayBuffer, width: number, height: number): boolean {
  const data = new DataView(bytes);
  const tag = (at: number): string => String.fromCharCode(
    data.getUint8(at), data.getUint8(at + 1), data.getUint8(at + 2), data.getUint8(at + 3)
  );
  if (data.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP"
    || data.getUint32(4, true) + 8 !== data.byteLength) return false;
  let extended = false;
  let image = false;
  let offset = 12;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) return false;
    const kind = tag(offset);
    const size = data.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size & 1);
    if (next > data.byteLength || ((size & 1) && data.getUint8(end) !== 0)) return false;
    if (kind === "VP8X") {
      if (offset !== 12 || size !== 10) return false;
      // Reserved bits/bytes and the animation flag must be unset.
      if ((data.getUint8(start) & 0xc3) !== 0 || data.getUint8(start + 1)
        || data.getUint8(start + 2) || data.getUint8(start + 3)) return false;
      const read24 = (at: number): number => data.getUint8(at)
        + (data.getUint8(at + 1) << 8) + (data.getUint8(at + 2) << 16);
      if (read24(start + 4) + 1 !== width || read24(start + 7) + 1 !== height) return false;
      extended = true;
    } else if (kind === "VP8L") {
      if (image || size < 5 || data.getUint8(start) !== 0x2f) return false;
      const header = data.getUint32(start + 1, true);
      if ((header >>> 29) !== 0 || (header & 0x3fff) + 1 !== width
        || ((header >>> 14) & 0x3fff) + 1 !== height) return false;
      image = true;
    } else if (!extended || kind === "VP8 " || kind === "ANIM" || kind === "ANMF" || kind === "ALPH") {
      return false;
    }
    offset = next;
  }
  return image;
}

function isOpaque(context: CanvasRenderingContext2D): boolean {
  const { width, height } = context.canvas;
  // Read in bands rather than duplicating a full-resolution RGBA image.
  for (let y = 0; y < height; y += 64) {
    const { data } = context.getImageData(0, y, width, Math.min(64, height - y));
    for (let alpha = 3; alpha < data.length; alpha += 4) {
      if (data[alpha] !== 255) return false;
    }
  }
  return true;
}

async function encodeCanvas(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((next) => {
        if (next) resolve(next);
        else reject(new Error("The edited image could not be encoded."));
      }, mimeType, quality);
    });
    return { bytes: await blob.arrayBuffer(), mimeType: blob.type };
  }
  const url = canvas.toDataURL(mimeType, quality);
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!match || typeof atob !== "function") throw new Error("The edited image could not be encoded.");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { bytes: bytes.buffer, mimeType: match[1] };
}

/**
 * New opaque JPEG/WebP edits may use lossless WebP. Quality 1 requests it in
 * Chromium, but other encoders need not honor that: accept only static VP8L.
 * This preserves the painted raster, not original file metadata or JPEG bytes.
 * PNG sources, transparency, clipboard renders and unsupported encoders keep PNG.
 */
export async function encodeStudioImageBoard(
  context: CanvasRenderingContext2D,
  sourceMimeType: string = PNG
): Promise<StudioEncodedImageBoard> {
  const source = sourceMimeType.split(";", 1)[0].trim().toLowerCase();
  if (source === "image/jpeg" || source === WEBP) {
    try {
      if (isOpaque(context)) {
        const candidate = await encodeCanvas(context.canvas, WEBP, 1);
        if (candidate.mimeType === WEBP
          && isLosslessWebp(candidate.bytes, context.canvas.width, context.canvas.height)) {
          return { bytes: candidate.bytes, mimeType: WEBP };
        }
        // Browsers without a WebP encoder normally return PNG themselves.
        if (candidate.mimeType === PNG) return { bytes: candidate.bytes, mimeType: PNG };
      }
    } catch {
      // A missing encoder/readback must not sacrifice pixels or the user's edits.
    }
  }
  const png = await encodeCanvas(context.canvas, PNG);
  if (png.mimeType && png.mimeType !== PNG) throw new Error("The edited image could not be encoded as PNG.");
  return { bytes: png.bytes, mimeType: PNG };
}
