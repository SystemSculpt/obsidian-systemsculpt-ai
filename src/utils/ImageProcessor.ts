import { App, TFile } from "obsidian";
import { SystemSculptError } from "./errors";

export class ImageProcessor {
  private static MAX_FILE_SIZE = 10 * 1024 * 1024; 
  private static SUPPORTED_FORMATS = new Set([
    "jpg",
    "jpeg",
    "png",
    "webp",
  ]);

  static async processImage(file: TFile, app: App): Promise<string> {
    
    if (!file) {
      throw new SystemSculptError("File not found", "FILE_NOT_FOUND", 404);
    }

    
    if (file.stat.size > ImageProcessor.MAX_FILE_SIZE) {
      throw new SystemSculptError(
        "Image too large (max 10MB)",
        "FILE_TOO_LARGE",
        413
      );
    }

    
    const extension = file.extension.toLowerCase();
    if (!ImageProcessor.SUPPORTED_FORMATS.has(extension)) {
      throw new SystemSculptError(
        "Unsupported image format",
        "UNSUPPORTED_FORMAT",
        415
      );
    }

    try {
      
      const arrayBuffer = await app.vault.readBinary(file);

      
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          
          const dataUrl = reader.result as string;
          resolve(dataUrl);
        };
        reader.onerror = () => reject(reader.error);

        
        const type = `image/${extension === "jpg" ? "jpeg" : extension}`;
        const blob = new Blob([arrayBuffer], { type });

        
        reader.readAsDataURL(blob);
      });

      return base64;
    } catch (error) {
      throw new SystemSculptError(
        "Failed to process image",
        "PROCESSING_ERROR",
        500
      );
    }
  }

  static async processClipboardImage(
    clipboardData: DataTransfer
  ): Promise<string> {
    const file = clipboardData.files[0];
    if (!file || !file.type.startsWith("image/")) {
      throw new SystemSculptError("No image in clipboard", "NO_IMAGE", 400);
    }

    if (file.size > this.MAX_FILE_SIZE) {
      throw new SystemSculptError(
        "Image too large (max 10MB)",
        "FILE_TOO_LARGE",
        413
      );
    }

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}
