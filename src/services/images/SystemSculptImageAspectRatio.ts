export const SYSTEMSCULPT_CONCRETE_IMAGE_ASPECT_RATIOS = [
  "16:9",
  "1:1",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
] as const;

export type SystemSculptConcreteImageAspectRatio =
  (typeof SYSTEMSCULPT_CONCRETE_IMAGE_ASPECT_RATIOS)[number];

function parseAspectRatioValue(aspectRatio: string): number | null {
  const raw = String(aspectRatio || "").trim();
  if (!raw.includes(":")) {
    return null;
  }
  const [widthPart, heightPart] = raw.split(":");
  const width = Number(widthPart);
  const height = Number(heightPart);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return width / height;
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) {
    return null;
  }
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < pngSignature.length; index += 1) {
    if (bytes[index] !== pngSignature[index]) {
      return null;
    }
  }
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ]);

  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      return null;
    }
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= bytes.length) {
      return null;
    }
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (!Number.isFinite(segmentLength) || segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }
    if (sofMarkers.has(marker)) {
      if (offset + 7 >= bytes.length) {
        return null;
      }
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (width <= 0 || height <= 0) {
        return null;
      }
      return { width, height };
    }
    offset += segmentLength;
  }

  return null;
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30) {
    return null;
  }
  const riffHeader = String.fromCharCode(...bytes.slice(0, 4));
  const webpHeader = String.fromCharCode(...bytes.slice(8, 12));
  if (riffHeader !== "RIFF" || webpHeader !== "WEBP") {
    return null;
  }
  const chunkType = String.fromCharCode(...bytes.slice(12, 16));

  if (chunkType === "VP8X") {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }

  if (chunkType === "VP8 " && bytes.length >= 30) {
    const width = ((bytes[26] | (bytes[27] << 8)) & 0x3fff) >>> 0;
    const height = ((bytes[28] | (bytes[29] << 8)) & 0x3fff) >>> 0;
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }

  if (chunkType === "VP8L" && bytes.length >= 25) {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = 1 + (b0 | ((b1 & 0x3f) << 8));
    const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  }

  return null;
}

export function readImageDimensionsFromArrayBuffer(
  bytes: ArrayBuffer | Uint8Array | null | undefined
): { width: number; height: number } | null {
  if (!bytes) {
    return null;
  }
  const normalized = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (
    readPngDimensions(normalized) ||
    readJpegDimensions(normalized) ||
    readWebpDimensions(normalized)
  );
}

export function inferClosestSystemSculptAspectRatio(
  width: number,
  height: number
): SystemSculptConcreteImageAspectRatio {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0) {
    return "1:1";
  }

  const sourceRatio = safeWidth / safeHeight;
  let bestRatio: SystemSculptConcreteImageAspectRatio = SYSTEMSCULPT_CONCRETE_IMAGE_ASPECT_RATIOS[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of SYSTEMSCULPT_CONCRETE_IMAGE_ASPECT_RATIOS) {
    const candidateRatio = parseAspectRatioValue(candidate);
    if (candidateRatio === null) {
      continue;
    }
    const distance = Math.abs(candidateRatio - sourceRatio);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRatio = candidate;
    }
  }

  return bestRatio;
}

export function resolveSystemSculptImageAspectRatio(options: {
  requestedAspectRatio?: string | null;
  inputImageBytes?: readonly (ArrayBuffer | Uint8Array)[];
  fallbackAspectRatio?: SystemSculptConcreteImageAspectRatio;
}): SystemSculptConcreteImageAspectRatio | null {
  const raw = String(options.requestedAspectRatio || "").trim();
  if (!raw) {
    return null;
  }

  const fallback = options.fallbackAspectRatio || "1:1";
  if (raw === "match_input_image") {
    for (const inputBytes of options.inputImageBytes || []) {
      const dimensions = readImageDimensionsFromArrayBuffer(inputBytes);
      if (dimensions) {
        return inferClosestSystemSculptAspectRatio(dimensions.width, dimensions.height);
      }
    }
    return fallback;
  }

  if (SYSTEMSCULPT_CONCRETE_IMAGE_ASPECT_RATIOS.includes(raw as SystemSculptConcreteImageAspectRatio)) {
    return raw as SystemSculptConcreteImageAspectRatio;
  }

  const parsedRatio = parseAspectRatioValue(raw);
  if (parsedRatio !== null) {
    return inferClosestSystemSculptAspectRatio(parsedRatio, 1);
  }

  return fallback;
}
