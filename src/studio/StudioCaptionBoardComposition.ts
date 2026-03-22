import type { StudioAssetRef } from "./types";
import type {
  StudioCaptionBoardAnnotation,
  StudioCaptionBoardCrop,
  StudioCaptionBoardLabel,
  StudioCaptionBoardState,
  StudioCaptionBoardStyleVariant,
  StudioCaptionBoardTextAlign,
} from "./StudioCaptionBoardState";
import { boardStateHasRenderableEdits } from "./StudioCaptionBoardState";

export type StudioImageDimensions = {
  width: number;
  height: number;
};

export type StudioRenderedBoardImage = {
  bytes: ArrayBuffer;
  mimeType: string;
  dataUrl: string;
  width: number;
  height: number;
};

type StudioRenderMode = "final" | "editor";

type StudioOutputFrame = {
  exportWidth: number;
  exportHeight: number;
  viewBoxX: number;
  viewBoxY: number;
  viewBoxWidth: number;
  viewBoxHeight: number;
};

const DEFAULT_IMAGE_DIMENSIONS: StudioImageDimensions = { width: 1600, height: 900 };
const DEFAULT_OUTPUT_MIME = "image/png";

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function parsePngDimensions(bytes: Uint8Array): StudioImageDimensions | null {
  if (bytes.length < 24) {
    return null;
  }
  const signature = "89504e470d0a1a0a";
  const actualSignature = Array.from(bytes.slice(0, 8))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (actualSignature !== signature) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width > 0 && height > 0) {
    return { width, height };
  }
  return null;
}

function parseGifDimensions(bytes: Uint8Array): StudioImageDimensions | null {
  if (bytes.length < 10) {
    return null;
  }
  const header = String.fromCharCode(...bytes.slice(0, 6));
  if (header !== "GIF87a" && header !== "GIF89a") {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  if (width > 0 && height > 0) {
    return { width, height };
  }
  return null;
}

function parseJpegDimensions(bytes: Uint8Array): StudioImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const isStandalone = marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7);
    if (isStandalone) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
      break;
    }
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      if (width > 0 && height > 0) {
        return { width, height };
      }
      return null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function parseWebpDimensions(bytes: Uint8Array): StudioImageDimensions | null {
  if (bytes.length < 30) {
    return null;
  }
  const header = String.fromCharCode(...bytes.slice(0, 4));
  const webp = String.fromCharCode(...bytes.slice(8, 12));
  if (header !== "RIFF" || webp !== "WEBP") {
    return null;
  }
  const chunkType = String.fromCharCode(...bytes.slice(12, 16));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (chunkType === "VP8X" && bytes.length >= 30) {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  if (chunkType === "VP8 " && bytes.length >= 30) {
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  if (chunkType === "VP8L" && bytes.length >= 25) {
    const bits =
      bytes[21] |
      (bytes[22] << 8) |
      (bytes[23] << 16) |
      (bytes[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }

  return null;
}

function parseSvgDimensions(text: string): StudioImageDimensions | null {
  const viewBoxMatch = text.match(/viewBox\s*=\s*["']\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*["']/i);
  if (viewBoxMatch) {
    const width = Number(viewBoxMatch[3]);
    const height = Number(viewBoxMatch[4]);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  }
  const widthMatch = text.match(/width\s*=\s*["']\s*([\d.+-]+)/i);
  const heightMatch = text.match(/height\s*=\s*["']\s*([\d.+-]+)/i);
  if (!widthMatch || !heightMatch) {
    return null;
  }
  const width = Number(widthMatch[1]);
  const height = Number(heightMatch[1]);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }
  return null;
}

export function detectStudioImageDimensions(bytes: ArrayBuffer, mimeType: string): StudioImageDimensions | null {
  const normalizedMime = String(mimeType || "").trim().toLowerCase();
  const uint8 = new Uint8Array(bytes);
  if (normalizedMime === "image/png") {
    return parsePngDimensions(uint8);
  }
  if (normalizedMime === "image/jpeg" || normalizedMime === "image/jpg") {
    return parseJpegDimensions(uint8);
  }
  if (normalizedMime === "image/gif") {
    return parseGifDimensions(uint8);
  }
  if (normalizedMime === "image/webp") {
    return parseWebpDimensions(uint8);
  }
  if (normalizedMime === "image/svg+xml") {
    return parseSvgDimensions(new TextDecoder().decode(uint8));
  }
  return null;
}

function base64FromArrayBuffer(bytes: ArrayBuffer): string {
  const bufferCtor = (globalThis as any)?.Buffer;
  if (bufferCtor && typeof bufferCtor.from === "function") {
    return bufferCtor.from(bytes).toString("base64");
  }

  const uint8 = new Uint8Array(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < uint8.length; index += chunkSize) {
    binary += String.fromCharCode(...uint8.subarray(index, index + chunkSize));
  }
  if (typeof btoa !== "function") {
    throw new Error("Base64 encoding is unavailable in this environment.");
  }
  return btoa(binary);
}

function arrayBufferToDataUrl(bytes: ArrayBuffer, mimeType: string): string {
  return `data:${mimeType};base64,${base64FromArrayBuffer(bytes)}`;
}

function resolveTextAnchor(alignment: StudioCaptionBoardTextAlign): "start" | "middle" | "end" {
  if (alignment === "left") return "start";
  if (alignment === "right") return "end";
  return "middle";
}

function buildFilterMarkup(styleVariant: StudioCaptionBoardStyleVariant, id: string): string {
  if (styleVariant !== "shadow") {
    return "";
  }
  return `
    <filter id="${id}" x="-24%" y="-24%" width="148%" height="148%">
      <feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000000" flood-opacity="0.58" />
    </filter>
  `;
}

function wrapTextToWidth(text: string, maxWidthPx: number, fontSize: number): string[] {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const approxCharWidth = Math.max(6, fontSize * 0.58);
  const maxChars = Math.max(1, Math.floor(maxWidthPx / approxCharWidth));
  const rawLines = normalized.split("\n");
  const output: string[] = [];
  for (const rawLine of rawLines) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      output.push("");
      continue;
    }
    let currentLine = "";
    for (const word of words) {
      const candidate = currentLine ? `${currentLine} ${word}` : word;
      if (candidate.length <= maxChars) {
        currentLine = candidate;
        continue;
      }
      if (currentLine) {
        output.push(currentLine);
        currentLine = word;
        continue;
      }
      let remaining = word;
      while (remaining.length > maxChars) {
        output.push(remaining.slice(0, maxChars));
        remaining = remaining.slice(maxChars);
      }
      currentLine = remaining;
    }
    if (currentLine) {
      output.push(currentLine);
    }
  }
  return output.filter((line, index) => line.length > 0 || index === 0);
}

function buildLabelSvgMarkup(label: StudioCaptionBoardLabel, dimensions: StudioImageDimensions): string {
  const boxX = label.x * dimensions.width;
  const boxY = label.y * dimensions.height;
  const boxWidth = Math.max(1, label.width * dimensions.width);
  const boxHeight = Math.max(1, label.height * dimensions.height);
  const paddingX = Math.max(10, label.fontSize * 0.18);
  const paddingY = Math.max(8, label.fontSize * 0.14);
  const lineHeight = Math.max(label.fontSize * 1.16, label.fontSize + 6);
  const maxLines = Math.max(1, Math.floor((boxHeight - paddingY * 2) / lineHeight));
  const wrappedLines = wrapTextToWidth(label.text, Math.max(1, boxWidth - paddingX * 2), label.fontSize).slice(0, maxLines);
  const textAnchor = resolveTextAnchor(label.textAlign);
  const anchorX =
    label.textAlign === "left"
      ? boxX + paddingX
      : label.textAlign === "right"
        ? boxX + boxWidth - paddingX
        : boxX + boxWidth / 2;
  const totalTextHeight = wrappedLines.length * lineHeight;
  const firstBaseline = boxY + (boxHeight - totalTextHeight) / 2 + lineHeight / 2;
  const strokeWidth = label.styleVariant === "outline" ? Math.max(2, label.fontSize * 0.09) : 0;
  const filterId = `caption-board-shadow-${xmlEscape(label.id)}`;
  const filterMarkup = buildFilterMarkup(label.styleVariant, filterId);
  const filterAttribute = label.styleVariant === "shadow" ? ` filter="url(#${filterId})"` : "";
  const backgroundMarkup =
    label.styleVariant === "banner"
      ? `<rect x="${boxX.toFixed(2)}" y="${boxY.toFixed(2)}" width="${boxWidth.toFixed(2)}" height="${boxHeight.toFixed(
          2
        )}" fill="#000000" fill-opacity="0.48" rx="10" ry="10" />`
      : "";
  const textLinesMarkup = wrappedLines
    .map((line, index) => {
      const lineY = firstBaseline + index * lineHeight;
      const strokeMarkup =
        strokeWidth > 0
          ? ` stroke="#000000" stroke-width="${strokeWidth.toFixed(2)}" paint-order="stroke fill"`
          : "";
      return `<text x="${anchorX.toFixed(2)}" y="${lineY.toFixed(2)}" text-anchor="${textAnchor}" dominant-baseline="middle"${filterAttribute}${strokeMarkup}>${xmlEscape(
        line
      )}</text>`;
    })
    .join("");

  return `
    <g data-label-id="${xmlEscape(label.id)}">
      <defs>${filterMarkup}</defs>
      ${backgroundMarkup}
      <g fill="${xmlEscape(label.textColor)}" font-family="Inter, Arial, sans-serif" font-size="${label.fontSize}" font-weight="700" letter-spacing="0.01em">
        ${textLinesMarkup}
      </g>
    </g>
  `;
}

function buildAnnotationSvgMarkup(
  annotation: StudioCaptionBoardAnnotation,
  dimensions: StudioImageDimensions,
  imageHref: string
): string {
  const x = annotation.x * dimensions.width;
  const y = annotation.y * dimensions.height;
  const width = Math.max(1, annotation.width * dimensions.width);
  const height = Math.max(1, annotation.height * dimensions.height);

  if (annotation.kind === "highlight_circle") {
    return `
      <ellipse
        cx="${(x + width / 2).toFixed(2)}"
        cy="${(y + height / 2).toFixed(2)}"
        rx="${(width / 2).toFixed(2)}"
        ry="${(height / 2).toFixed(2)}"
        fill="${xmlEscape(annotation.color)}"
        fill-opacity="0.08"
        stroke="${xmlEscape(annotation.color)}"
        stroke-opacity="0.96"
        stroke-width="${annotation.strokeWidth.toFixed(2)}"
      />
    `;
  }

  if (annotation.kind === "blur_rect") {
    const radius = Math.min(width, height) * 0.08;
    const clipId = `caption-board-blur-clip-${xmlEscape(annotation.id)}`;
    const filterId = `caption-board-blur-filter-${xmlEscape(annotation.id)}`;
    return `
      <defs>
        <clipPath id="${clipId}">
          <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}" rx="${radius.toFixed(2)}" ry="${radius.toFixed(2)}" />
        </clipPath>
        <filter id="${filterId}" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="${annotation.blurRadius.toFixed(2)}" />
        </filter>
      </defs>
      <image
        href="${imageHref}"
        x="0"
        y="0"
        width="${dimensions.width}"
        height="${dimensions.height}"
        preserveAspectRatio="none"
        clip-path="url(#${clipId})"
        filter="url(#${filterId})"
      />
      <rect
        x="${x.toFixed(2)}"
        y="${y.toFixed(2)}"
        width="${width.toFixed(2)}"
        height="${height.toFixed(2)}"
        rx="${radius.toFixed(2)}"
        ry="${radius.toFixed(2)}"
        fill="${xmlEscape(annotation.color)}"
        fill-opacity="0.08"
        stroke="${xmlEscape(annotation.color)}"
        stroke-opacity="0.92"
        stroke-width="${Math.max(2, annotation.strokeWidth * 0.45).toFixed(2)}"
      />
    `;
  }

  const radius = Math.min(width, height) * 0.08;
  return `
    <rect
      x="${x.toFixed(2)}"
      y="${y.toFixed(2)}"
      width="${width.toFixed(2)}"
      height="${height.toFixed(2)}"
      rx="${radius.toFixed(2)}"
      ry="${radius.toFixed(2)}"
      fill="${xmlEscape(annotation.color)}"
      fill-opacity="0.12"
      stroke="${xmlEscape(annotation.color)}"
      stroke-opacity="0.94"
      stroke-width="${annotation.strokeWidth.toFixed(2)}"
    />
  `;
}

function resolveOutputFrame(
  dimensions: StudioImageDimensions,
  crop: StudioCaptionBoardCrop | null,
  mode: StudioRenderMode
): StudioOutputFrame {
  if (!crop || mode === "editor") {
    return {
      exportWidth: dimensions.width,
      exportHeight: dimensions.height,
      viewBoxX: 0,
      viewBoxY: 0,
      viewBoxWidth: dimensions.width,
      viewBoxHeight: dimensions.height,
    };
  }

  const viewBoxX = crop.x * dimensions.width;
  const viewBoxY = crop.y * dimensions.height;
  const viewBoxWidth = Math.max(1, crop.width * dimensions.width);
  const viewBoxHeight = Math.max(1, crop.height * dimensions.height);
  return {
    exportWidth: Math.max(1, Math.round(viewBoxWidth)),
    exportHeight: Math.max(1, Math.round(viewBoxHeight)),
    viewBoxX,
    viewBoxY,
    viewBoxWidth,
    viewBoxHeight,
  };
}

function buildFallbackSvgFromBaseBytes(options: {
  baseBytes: ArrayBuffer;
  baseMimeType: string;
  boardState: StudioCaptionBoardState;
  dimensions: StudioImageDimensions;
  mode: StudioRenderMode;
}): StudioRenderedBoardImage {
  const { baseBytes, baseMimeType, boardState, dimensions, mode } = options;
  const outputFrame = resolveOutputFrame(dimensions, boardState.crop, mode);
  const dataUrl = arrayBufferToDataUrl(baseBytes, baseMimeType);
  const annotationMarkup = boardState.annotations
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
    .map((annotation) => buildAnnotationSvgMarkup(annotation, dimensions, dataUrl))
    .join("");
  const cropMaskMarkup =
    mode === "editor" && boardState.crop
      ? (() => {
          const cropX = boardState.crop.x * dimensions.width;
          const cropY = boardState.crop.y * dimensions.height;
          const cropWidth = boardState.crop.width * dimensions.width;
          const cropHeight = boardState.crop.height * dimensions.height;
          return `
            <path d="M0 0 H${dimensions.width} V${dimensions.height} H0 Z M${cropX.toFixed(2)} ${cropY.toFixed(2)} H${(
              cropX + cropWidth
            ).toFixed(2)} V${(cropY + cropHeight).toFixed(2)} H${cropX.toFixed(2)} Z" fill="rgba(0,0,0,0.42)" fill-rule="evenodd" />
          `;
        })()
      : "";
  const labelMarkup = boardState.labels
    .filter((label) => label.text.trim().length > 0)
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))
    .map((label) => buildLabelSvgMarkup(label, dimensions))
    .join("");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${outputFrame.exportWidth}" height="${outputFrame.exportHeight}" viewBox="${outputFrame.viewBoxX.toFixed(
    2
  )} ${outputFrame.viewBoxY.toFixed(2)} ${outputFrame.viewBoxWidth.toFixed(2)} ${outputFrame.viewBoxHeight.toFixed(2)}">
  <image href="${dataUrl}" x="0" y="0" width="${dimensions.width}" height="${dimensions.height}" preserveAspectRatio="none" />
  ${annotationMarkup}
  ${labelMarkup}
  ${cropMaskMarkup}
</svg>`;
  const bytes = new TextEncoder().encode(svg).buffer;
  return {
    bytes,
    mimeType: "image/svg+xml",
    dataUrl: arrayBufferToDataUrl(bytes, "image/svg+xml"),
    width: outputFrame.exportWidth,
    height: outputFrame.exportHeight,
  };
}

function supportsCanvasBoardRender(): boolean {
  if (typeof document === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return typeof canvas.getContext === "function" && Boolean(canvas.getContext("2d"));
  } catch {
    return false;
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width));
  canvas.height = Math.max(1, Math.floor(height));
  return canvas;
}

async function canvasToArrayBuffer(canvas: HTMLCanvasElement, mimeType: string): Promise<ArrayBuffer> {
  if (typeof canvas.toBlob === "function") {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((nextBlob) => {
        if (!nextBlob) {
          reject(new Error("Failed to encode board canvas."));
          return;
        }
        resolve(nextBlob);
      }, mimeType);
    });
    return blob.arrayBuffer();
  }
  const dataUrl = canvas.toDataURL(mimeType);
  const base64 = dataUrl.split(",")[1] || "";
  const bufferCtor = (globalThis as any)?.Buffer;
  if (bufferCtor && typeof bufferCtor.from === "function") {
    const buffer = bufferCtor.from(base64, "base64");
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }
  if (typeof atob !== "function") {
    throw new Error("Canvas encoding is unavailable in this environment.");
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function loadImageFromBytes(options: {
  bytes: ArrayBuffer;
  mimeType: string;
}): Promise<{ source: CanvasImageSource; width: number; height: number; cleanup: () => void }> {
  const blob = new Blob([options.bytes], { type: options.mimeType });
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => {
        try {
          bitmap.close();
        } catch {
          // noop
        }
      },
    };
  }

  if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new Error("Canvas image decoding is unavailable in this environment.");
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to decode board image."));
      img.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
      cleanup: () => {
        URL.revokeObjectURL(objectUrl);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function mapRectToOutput(
  frame: { x: number; y: number; width: number; height: number },
  dimensions: StudioImageDimensions,
  outputFrame: StudioOutputFrame
): { x: number; y: number; width: number; height: number } {
  return {
    x: frame.x * dimensions.width - outputFrame.viewBoxX,
    y: frame.y * dimensions.height - outputFrame.viewBoxY,
    width: Math.max(1, frame.width * dimensions.width),
    height: Math.max(1, frame.height * dimensions.height),
  };
}

function drawRoundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function seedFromString(value: string): number {
  let seed = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    seed ^= value.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function nextPseudoRandom(seed: number): number {
  let next = seed >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return (next >>> 0) / 0xffffffff;
}

function drawIrreversibleBlurAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: StudioCaptionBoardAnnotation,
  dimensions: StudioImageDimensions,
  outputFrame: StudioOutputFrame
): void {
  const mapped = mapRectToOutput(annotation, dimensions, outputFrame);
  const width = Math.max(1, Math.round(mapped.width));
  const height = Math.max(1, Math.round(mapped.height));
  const x = Math.round(mapped.x);
  const y = Math.round(mapped.y);
  const patchCanvas = createCanvas(width, height);
  const patchCtx = patchCanvas.getContext("2d");
  if (!patchCtx) {
    return;
  }
  patchCtx.clearRect(0, 0, width, height);
  patchCtx.drawImage(ctx.canvas, x, y, width, height, 0, 0, width, height);

  const pixelBlockSize = clamp(Math.round(annotation.blurRadius * 0.55), 6, 28);
  const reducedWidth = Math.max(4, Math.round(width / pixelBlockSize));
  const reducedHeight = Math.max(4, Math.round(height / pixelBlockSize));
  const reducedCanvas = createCanvas(reducedWidth, reducedHeight);
  const reducedCtx = reducedCanvas.getContext("2d");
  if (!reducedCtx) {
    return;
  }
  reducedCtx.imageSmoothingEnabled = true;
  reducedCtx.drawImage(patchCanvas, 0, 0, reducedWidth, reducedHeight);

  patchCtx.clearRect(0, 0, width, height);
  patchCtx.imageSmoothingEnabled = false;
  patchCtx.drawImage(reducedCanvas, 0, 0, reducedWidth, reducedHeight, 0, 0, width, height);
  patchCtx.imageSmoothingEnabled = true;

  let seed = seedFromString(annotation.id);
  const noiseCell = clamp(Math.round(pixelBlockSize * 0.65), 3, 12);
  for (let row = 0; row < height; row += noiseCell) {
    for (let col = 0; col < width; col += noiseCell) {
      seed = Math.imul((seed ^ (row + 1) ^ (col + 7)) >>> 0, 1664525) + 1013904223;
      const noise = nextPseudoRandom(seed >>> 0);
      const alpha = 0.04 + noise * 0.14;
      const shade = noise > 0.52 ? 255 : 0;
      patchCtx.fillStyle = `rgba(${shade}, ${shade}, ${shade}, ${alpha.toFixed(3)})`;
      patchCtx.fillRect(col, row, noiseCell, noiseCell);
    }
  }
  patchCtx.fillStyle = "rgba(14, 8, 8, 0.1)";
  patchCtx.fillRect(0, 0, width, height);

  const radius = Math.min(width, height) * 0.08;
  ctx.save();
  drawRoundRectPath(ctx, x, y, width, height, radius);
  ctx.clip();
  ctx.drawImage(patchCanvas, x, y, width, height);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = annotation.color;
  ctx.lineWidth = Math.max(2, annotation.strokeWidth * 0.45);
  ctx.fillStyle = `${annotation.color}14`;
  drawRoundRectPath(ctx, x, y, width, height, radius);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawHighlightAnnotation(
  ctx: CanvasRenderingContext2D,
  annotation: StudioCaptionBoardAnnotation,
  dimensions: StudioImageDimensions,
  outputFrame: StudioOutputFrame
): void {
  const mapped = mapRectToOutput(annotation, dimensions, outputFrame);
  const radius = Math.min(mapped.width, mapped.height) * 0.08;
  ctx.save();
  ctx.strokeStyle = annotation.color;
  ctx.lineWidth = annotation.strokeWidth;
  if (annotation.kind === "highlight_circle") {
    ctx.fillStyle = `${annotation.color}14`;
    ctx.beginPath();
    ctx.ellipse(
      mapped.x + mapped.width / 2,
      mapped.y + mapped.height / 2,
      mapped.width / 2,
      mapped.height / 2,
      0,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.fillStyle = `${annotation.color}1a`;
  drawRoundRectPath(ctx, mapped.x, mapped.y, mapped.width, mapped.height, radius);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function applyLabelTextStyle(
  ctx: CanvasRenderingContext2D,
  label: StudioCaptionBoardLabel
): void {
  ctx.fillStyle = label.textColor;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.92)";
  ctx.lineWidth = Math.max(2, label.fontSize * 0.09);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  if (label.styleVariant === "shadow") {
    ctx.shadowColor = "rgba(0, 0, 0, 0.82)";
    ctx.shadowBlur = Math.max(10, label.fontSize * 0.28);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = Math.max(4, label.fontSize * 0.1);
  }
}

function drawLabelOnCanvas(
  ctx: CanvasRenderingContext2D,
  label: StudioCaptionBoardLabel,
  dimensions: StudioImageDimensions,
  outputFrame: StudioOutputFrame
): void {
  if (!label.text.trim()) {
    return;
  }
  const mapped = mapRectToOutput(label, dimensions, outputFrame);
  const paddingX = Math.max(10, label.fontSize * 0.18);
  const paddingY = Math.max(8, label.fontSize * 0.14);
  const lineHeight = Math.max(label.fontSize * 1.16, label.fontSize + 6);
  const maxLines = Math.max(1, Math.floor((mapped.height - paddingY * 2) / lineHeight));
  const wrappedLines = wrapTextToWidth(label.text, Math.max(1, mapped.width - paddingX * 2), label.fontSize).slice(0, maxLines);
  const totalTextHeight = wrappedLines.length * lineHeight;
  const firstBaseline = mapped.y + (mapped.height - totalTextHeight) / 2 + lineHeight / 2;
  const anchorX =
    label.textAlign === "left"
      ? mapped.x + paddingX
      : label.textAlign === "right"
        ? mapped.x + mapped.width - paddingX
        : mapped.x + mapped.width / 2;

  ctx.save();
  ctx.font = `700 ${label.fontSize}px Inter, Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = label.textAlign === "left" ? "left" : label.textAlign === "right" ? "right" : "center";

  if (label.styleVariant === "banner") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
    drawRoundRectPath(ctx, mapped.x, mapped.y, mapped.width, mapped.height, 10);
    ctx.fill();
  }

  applyLabelTextStyle(ctx, label);
  for (let index = 0; index < wrappedLines.length; index += 1) {
    const line = wrappedLines[index] || "";
    const lineY = firstBaseline + index * lineHeight;
    if (label.styleVariant === "outline") {
      ctx.strokeText(line, anchorX, lineY);
    }
    ctx.fillText(line, anchorX, lineY);
  }
  ctx.restore();
}

async function renderRasterBoardImage(options: {
  baseBytes: ArrayBuffer;
  baseMimeType: string;
  boardState: StudioCaptionBoardState;
  dimensions: StudioImageDimensions;
  mode: StudioRenderMode;
}): Promise<StudioRenderedBoardImage> {
  const { baseBytes, baseMimeType, boardState, dimensions, mode } = options;
  const decoded = await loadImageFromBytes({
    bytes: baseBytes,
    mimeType: baseMimeType,
  });
  try {
    const outputFrame = resolveOutputFrame(dimensions, boardState.crop, mode);
    const canvas = createCanvas(outputFrame.exportWidth, outputFrame.exportHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas context is unavailable for board rendering.");
    }
    ctx.clearRect(0, 0, outputFrame.exportWidth, outputFrame.exportHeight);
    if (mode === "editor" || !boardState.crop) {
      ctx.drawImage(decoded.source, 0, 0, outputFrame.exportWidth, outputFrame.exportHeight);
    } else {
      ctx.drawImage(
        decoded.source,
        outputFrame.viewBoxX,
        outputFrame.viewBoxY,
        outputFrame.viewBoxWidth,
        outputFrame.viewBoxHeight,
        0,
        0,
        outputFrame.exportWidth,
        outputFrame.exportHeight
      );
    }

    for (const annotation of boardState.annotations
      .filter((annotation) => annotation.kind === "blur_rect")
      .slice()
      .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))) {
      drawIrreversibleBlurAnnotation(ctx, annotation, dimensions, outputFrame);
    }

    for (const annotation of boardState.annotations
      .filter((annotation) => annotation.kind !== "blur_rect")
      .slice()
      .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))) {
      drawHighlightAnnotation(ctx, annotation, dimensions, outputFrame);
    }

    for (const label of boardState.labels
      .filter((label) => label.text.trim().length > 0)
      .slice()
      .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id))) {
      drawLabelOnCanvas(ctx, label, dimensions, outputFrame);
    }

    if (mode === "editor" && boardState.crop) {
      const cropX = boardState.crop.x * dimensions.width;
      const cropY = boardState.crop.y * dimensions.height;
      const cropWidth = boardState.crop.width * dimensions.width;
      const cropHeight = boardState.crop.height * dimensions.height;
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      ctx.beginPath();
      ctx.rect(0, 0, outputFrame.exportWidth, outputFrame.exportHeight);
      ctx.rect(cropX, cropY, cropWidth, cropHeight);
      ctx.fill("evenodd");
      ctx.restore();
    }

    const bytes = await canvasToArrayBuffer(canvas, DEFAULT_OUTPUT_MIME);
    return {
      bytes,
      mimeType: DEFAULT_OUTPUT_MIME,
      dataUrl: arrayBufferToDataUrl(bytes, DEFAULT_OUTPUT_MIME),
      width: outputFrame.exportWidth,
      height: outputFrame.exportHeight,
    };
  } finally {
    decoded.cleanup();
  }
}

export async function renderStudioCaptionBoardImageFromBytes(options: {
  baseBytes: ArrayBuffer;
  baseMimeType: string;
  boardState: StudioCaptionBoardState;
  mode?: StudioRenderMode;
}): Promise<StudioRenderedBoardImage> {
  const { baseBytes, baseMimeType, boardState, mode = "final" } = options;
  const dimensions = detectStudioImageDimensions(baseBytes, baseMimeType) || DEFAULT_IMAGE_DIMENSIONS;
  if (!boardStateHasRenderableEdits(boardState)) {
    return {
      bytes: baseBytes,
      mimeType: baseMimeType,
      dataUrl: arrayBufferToDataUrl(baseBytes, baseMimeType),
      width: dimensions.width,
      height: dimensions.height,
    };
  }

  if (supportsCanvasBoardRender()) {
    try {
      return await renderRasterBoardImage({
        baseBytes,
        baseMimeType,
        boardState,
        dimensions,
        mode,
      });
    } catch {
      // Fall back to SVG composition below.
    }
  }

  return buildFallbackSvgFromBaseBytes({
    baseBytes,
    baseMimeType,
    boardState,
    dimensions,
    mode,
  });
}

export async function renderStudioCaptionBoardImage(options: {
  baseImage: StudioAssetRef;
  boardState: StudioCaptionBoardState;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
}): Promise<StudioRenderedBoardImage> {
  const baseBytes = await options.readAsset(options.baseImage);
  return renderStudioCaptionBoardImageFromBytes({
    baseBytes,
    baseMimeType: options.baseImage.mimeType,
    boardState: options.boardState,
  });
}

export async function composeStudioCaptionBoardImage(options: {
  baseImage: StudioAssetRef;
  boardState: StudioCaptionBoardState;
  readAsset: (asset: StudioAssetRef) => Promise<ArrayBuffer>;
  storeAsset: (bytes: ArrayBuffer, mimeType: string) => Promise<StudioAssetRef>;
}): Promise<StudioAssetRef> {
  if (!boardStateHasRenderableEdits(options.boardState)) {
    return options.baseImage;
  }

  const rendered = await renderStudioCaptionBoardImage({
    baseImage: options.baseImage,
    boardState: options.boardState,
    readAsset: options.readAsset,
  });
  return options.storeAsset(rendered.bytes, rendered.mimeType);
}
