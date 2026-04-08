import { App, TFile } from "obsidian";
import { SystemSculptError } from "./errors";

/**
 * Vision models tile images internally (typically 512px tiles), so anything
 * beyond ~1536px on the longest side is wasted inference tokens.  Resizing
 * and JPEG-compressing at capture time gives 10-20x payload reduction for
 * typical screenshots while remaining visually indistinguishable.
 */
const VISION_MAX_DIMENSION = 1536;
const VISION_JPEG_QUALITY = 0.85;

export class ImageProcessor {
  private static MAX_FILE_SIZE = 10 * 1024 * 1024;
  private static SUPPORTED_FORMATS = new Set([
    "jpg",
    "jpeg",
    "png",
    "webp",
  ]);

  /**
   * Load a Blob into a drawable image source with dimensions, using
   * createImageBitmap where available and falling back to HTMLImageElement
   * (matches the pattern in CanvasFlowRunner / StudioCaptionBoardComposition).
   */
  private static async loadImage(
    blob: Blob,
  ): Promise<{ source: CanvasImageSource; width: number; height: number; cleanup: () => void }> {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => {
          try { bitmap.close(); } catch { /* noop */ }
        },
      };
    }

    if (typeof Image === "undefined" || typeof URL.createObjectURL !== "function") {
      throw new SystemSculptError(
        "Image decoding is unavailable in this environment",
        "PROCESSING_ERROR",
        500,
      );
    }

    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Failed to decode image"));
        el.src = objectUrl;
      });
      return {
        source: img,
        width: img.naturalWidth || img.width || 1,
        height: img.naturalHeight || img.height || 1,
        cleanup: () => URL.revokeObjectURL(objectUrl),
      };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  /**
   * Resize and JPEG-compress a Blob for vision-model consumption.
   * Returns a `data:image/jpeg;base64,...` string.
   */
  private static async optimizeForVision(blob: Blob): Promise<string> {
    const image = await ImageProcessor.loadImage(blob);
    let { width, height } = image;

    if (width > VISION_MAX_DIMENSION || height > VISION_MAX_DIMENSION) {
      const scale = VISION_MAX_DIMENSION / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      image.cleanup();
      throw new SystemSculptError(
        "Failed to create canvas context for image optimization",
        "PROCESSING_ERROR",
        500,
      );
    }
    ctx.drawImage(image.source, 0, 0, width, height);
    image.cleanup();

    // Prefer toBlob, fall back to toDataURL (matches StudioCaptionBoardComposition)
    if (typeof canvas.toBlob === "function") {
      const optimized = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
          "image/jpeg",
          VISION_JPEG_QUALITY,
        );
      });

      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(optimized);
      });
    }

    return canvas.toDataURL("image/jpeg", VISION_JPEG_QUALITY);
  }

  static async processImage(file: TFile, app: App): Promise<string> {
    if (!file) {
      throw new SystemSculptError("File not found", "FILE_NOT_FOUND", 404);
    }

    if (file.stat.size > ImageProcessor.MAX_FILE_SIZE) {
      throw new SystemSculptError(
        "Image too large (max 10MB)",
        "FILE_TOO_LARGE",
        413,
      );
    }

    const extension = file.extension.toLowerCase();
    if (!ImageProcessor.SUPPORTED_FORMATS.has(extension)) {
      throw new SystemSculptError(
        "Unsupported image format",
        "UNSUPPORTED_FORMAT",
        415,
      );
    }

    try {
      const arrayBuffer = await app.vault.readBinary(file);
      const type = `image/${extension === "jpg" ? "jpeg" : extension}`;
      const blob = new Blob([arrayBuffer], { type });
      return await ImageProcessor.optimizeForVision(blob);
    } catch (error) {
      if (error instanceof SystemSculptError) throw error;
      throw new SystemSculptError(
        "Failed to process image",
        "PROCESSING_ERROR",
        500,
      );
    }
  }

  static async processClipboardImage(
    clipboardData: DataTransfer,
  ): Promise<string> {
    const file = clipboardData.files[0];
    if (!file || !file.type.startsWith("image/")) {
      throw new SystemSculptError("No image in clipboard", "NO_IMAGE", 400);
    }

    if (file.size > this.MAX_FILE_SIZE) {
      throw new SystemSculptError(
        "Image too large (max 10MB)",
        "FILE_TOO_LARGE",
        413,
      );
    }

    try {
      return await ImageProcessor.optimizeForVision(file);
    } catch (error) {
      if (error instanceof SystemSculptError) throw error;
      throw new SystemSculptError(
        "Failed to process clipboard image",
        "PROCESSING_ERROR",
        500,
      );
    }
  }
}
