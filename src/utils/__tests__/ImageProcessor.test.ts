/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
  TFile: jest.fn(),
}));

import { ImageProcessor } from "../ImageProcessor";
import { SystemSculptError } from "../errors";

// ---------------------------------------------------------------------------
// Helpers to mock the Canvas-based optimizeForVision pipeline:
//   createImageBitmap -> canvas.getContext('2d').drawImage -> canvas.toBlob -> FileReader
// ---------------------------------------------------------------------------

function installCanvasMocks(dataUrl = "data:image/jpeg;base64,optimized") {
  const bitmapStub = { width: 800, height: 600, close: jest.fn() };
  (globalThis as any).createImageBitmap = jest.fn().mockResolvedValue(bitmapStub);

  const ctxStub = { drawImage: jest.fn() };
  const canvasStub = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => ctxStub),
    toBlob: jest.fn((cb: (b: Blob | null) => void) => {
      cb(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
    }),
  };
  jest.spyOn(document, "createElement").mockReturnValue(canvasStub as any);

  const mockFileReader = {
    onload: null as any,
    onerror: null as any,
    result: dataUrl,
    readAsDataURL: jest.fn(function (this: any) {
      setTimeout(() => this.onload?.(), 0);
    }),
  };
  global.FileReader = jest.fn(() => mockFileReader) as any;

  return { bitmapStub, ctxStub, canvasStub, mockFileReader };
}

describe("ImageProcessor", () => {
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
    mockApp = {
      vault: {
        readBinary: jest.fn(),
      },
    } as unknown as App;
  });

  describe("processImage", () => {
    it("throws FILE_NOT_FOUND for null file", async () => {
      await expect(
        ImageProcessor.processImage(null as any, mockApp),
      ).rejects.toThrow(SystemSculptError);

      await expect(
        ImageProcessor.processImage(null as any, mockApp),
      ).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
        statusCode: 404,
      });
    });

    it("throws FILE_NOT_FOUND for undefined file", async () => {
      await expect(
        ImageProcessor.processImage(undefined as any, mockApp),
      ).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
      });
    });

    it("throws FILE_TOO_LARGE for files over 10MB", async () => {
      const mockFile = {
        stat: { size: 11 * 1024 * 1024 },
        extension: "png",
      } as unknown as TFile;

      await expect(
        ImageProcessor.processImage(mockFile, mockApp),
      ).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
        statusCode: 413,
      });
    });

    it("accepts files at exactly 10MB", async () => {
      const mockFile = {
        stat: { size: 10 * 1024 * 1024 },
        extension: "png",
      } as unknown as TFile;

      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));
      installCanvasMocks("data:image/jpeg;base64,optimized");

      const result = await ImageProcessor.processImage(mockFile, mockApp);

      expect(result).toBe("data:image/jpeg;base64,optimized");
    });

    it("throws UNSUPPORTED_FORMAT for unsupported extensions", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "bmp",
      } as unknown as TFile;

      await expect(
        ImageProcessor.processImage(mockFile, mockApp),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
        statusCode: 415,
      });
    });

    it("throws UNSUPPORTED_FORMAT for text files", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "txt",
      } as unknown as TFile;

      await expect(
        ImageProcessor.processImage(mockFile, mockApp),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
      });
    });

    it("accepts jpg extension and returns optimized JPEG", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "jpg" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));
      const { bitmapStub } = installCanvasMocks();

      const result = await ImageProcessor.processImage(mockFile, mockApp);

      expect(result).toMatch(/^data:image\/jpeg;base64,/);
      expect(bitmapStub.close).toHaveBeenCalled();
    });

    it("accepts jpeg extension", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "jpeg" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));
      installCanvasMocks();

      const result = await ImageProcessor.processImage(mockFile, mockApp);
      expect(result).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("accepts png extension and compresses to JPEG", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "PNG" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));
      installCanvasMocks();

      const result = await ImageProcessor.processImage(mockFile, mockApp);
      // PNG input should still produce JPEG output after optimization
      expect(result).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("accepts webp extension", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "webp" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));
      installCanvasMocks();

      const result = await ImageProcessor.processImage(mockFile, mockApp);
      expect(result).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("resizes images exceeding the max dimension", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "png" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));

      const largeBitmap = { width: 4000, height: 3000, close: jest.fn() };
      (globalThis as any).createImageBitmap = jest.fn().mockResolvedValue(largeBitmap);

      const canvasStub = {
        width: 0,
        height: 0,
        getContext: jest.fn(() => ({ drawImage: jest.fn() })),
        toBlob: jest.fn((cb: (b: Blob | null) => void) => {
          cb(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
        }),
      };
      jest.spyOn(document, "createElement").mockReturnValue(canvasStub as any);

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/jpeg;base64,resized",
        readAsDataURL: jest.fn(function (this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      await ImageProcessor.processImage(mockFile, mockApp);

      // Canvas dimensions should be scaled to fit 1536px max
      expect(canvasStub.width).toBe(1536);
      expect(canvasStub.height).toBe(1152); // 3000 * (1536/4000) = 1152
    });

    it("does not upscale small images", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "png" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));

      const smallBitmap = { width: 400, height: 300, close: jest.fn() };
      (globalThis as any).createImageBitmap = jest.fn().mockResolvedValue(smallBitmap);

      const canvasStub = {
        width: 0,
        height: 0,
        getContext: jest.fn(() => ({ drawImage: jest.fn() })),
        toBlob: jest.fn((cb: (b: Blob | null) => void) => {
          cb(new Blob(["jpeg-bytes"], { type: "image/jpeg" }));
        }),
      };
      jest.spyOn(document, "createElement").mockReturnValue(canvasStub as any);

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/jpeg;base64,small",
        readAsDataURL: jest.fn(function (this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      await ImageProcessor.processImage(mockFile, mockApp);

      expect(canvasStub.width).toBe(400);
      expect(canvasStub.height).toBe(300);
    });

    it("throws PROCESSING_ERROR when vault read fails", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "png" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockRejectedValue(new Error("Read failed"));

      await expect(
        ImageProcessor.processImage(mockFile, mockApp),
      ).rejects.toMatchObject({
        code: "PROCESSING_ERROR",
        statusCode: 500,
      });
    });

    it("throws PROCESSING_ERROR when canvas context unavailable", async () => {
      const mockFile = { stat: { size: 1000 }, extension: "png" } as unknown as TFile;
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(new ArrayBuffer(8));

      (globalThis as any).createImageBitmap = jest.fn().mockResolvedValue({
        width: 100, height: 100, close: jest.fn(),
      });
      jest.spyOn(document, "createElement").mockReturnValue({
        width: 0, height: 0,
        getContext: jest.fn(() => null),
      } as any);

      await expect(
        ImageProcessor.processImage(mockFile, mockApp),
      ).rejects.toMatchObject({
        code: "PROCESSING_ERROR",
        statusCode: 500,
      });
    });
  });

  describe("processClipboardImage", () => {
    it("throws NO_IMAGE when no files in clipboard", async () => {
      const mockClipboard = { files: [] } as unknown as DataTransfer;

      await expect(
        ImageProcessor.processClipboardImage(mockClipboard),
      ).rejects.toMatchObject({
        code: "NO_IMAGE",
        statusCode: 400,
      });
    });

    it("throws NO_IMAGE when first file is not an image", async () => {
      const mockClipboard = {
        files: [{ type: "text/plain", size: 100 }],
      } as unknown as DataTransfer;

      await expect(
        ImageProcessor.processClipboardImage(mockClipboard),
      ).rejects.toMatchObject({
        code: "NO_IMAGE",
      });
    });

    it("throws FILE_TOO_LARGE for images over 10MB", async () => {
      const mockClipboard = {
        files: [{ type: "image/png", size: 11 * 1024 * 1024 }],
      } as unknown as DataTransfer;

      await expect(
        ImageProcessor.processClipboardImage(mockClipboard),
      ).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
        statusCode: 413,
      });
    });

    it("processes valid clipboard image through optimization pipeline", async () => {
      const mockFile = { type: "image/png", size: 1000 };
      const mockClipboard = { files: [mockFile] } as unknown as DataTransfer;
      installCanvasMocks("data:image/jpeg;base64,clipboard-optimized");

      const result = await ImageProcessor.processClipboardImage(mockClipboard);

      expect(result).toBe("data:image/jpeg;base64,clipboard-optimized");
    });

    it("throws PROCESSING_ERROR when optimization fails", async () => {
      const mockFile = { type: "image/png", size: 1000 };
      const mockClipboard = { files: [mockFile] } as unknown as DataTransfer;

      (globalThis as any).createImageBitmap = jest.fn().mockRejectedValue(
        new Error("bitmap failed"),
      );

      await expect(
        ImageProcessor.processClipboardImage(mockClipboard),
      ).rejects.toMatchObject({
        code: "PROCESSING_ERROR",
      });
    });
  });
});
