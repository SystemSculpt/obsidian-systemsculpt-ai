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

describe("ImageProcessor", () => {
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {
      vault: {
        readBinary: jest.fn(),
      },
    } as unknown as App;
  });

  describe("processImage", () => {
    it("throws FILE_NOT_FOUND for null file", async () => {
      await expect(
        ImageProcessor.processImage(null as any, mockApp)
      ).rejects.toThrow(SystemSculptError);

      await expect(
        ImageProcessor.processImage(null as any, mockApp)
      ).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
        statusCode: 404,
      });
    });

    it("throws FILE_NOT_FOUND for undefined file", async () => {
      await expect(
        ImageProcessor.processImage(undefined as any, mockApp)
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
        ImageProcessor.processImage(mockFile, mockApp)
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

      const mockArrayBuffer = new ArrayBuffer(8);
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(mockArrayBuffer);

      // Mock FileReader
      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/png;base64,test",
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      const result = await ImageProcessor.processImage(mockFile, mockApp);

      expect(result).toBe("data:image/png;base64,test");
    });

    it("throws UNSUPPORTED_FORMAT for unsupported extensions", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "bmp",
      } as unknown as TFile;

      await expect(
        ImageProcessor.processImage(mockFile, mockApp)
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
        ImageProcessor.processImage(mockFile, mockApp)
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
      });
    });

    it("accepts jpg extension", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "jpg",
      } as unknown as TFile;

      const mockArrayBuffer = new ArrayBuffer(8);
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(mockArrayBuffer);

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/jpeg;base64,test",
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      const result = await ImageProcessor.processImage(mockFile, mockApp);

      expect(result).toBe("data:image/jpeg;base64,test");
    });

    it("accepts jpeg extension", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "jpeg",
      } as unknown as TFile;

      const mockArrayBuffer = new ArrayBuffer(8);
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(mockArrayBuffer);

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/jpeg;base64,test",
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      const result = await ImageProcessor.processImage(mockFile, mockApp);

      expect(result).toBe("data:image/jpeg;base64,test");
    });

    it("accepts png extension", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "PNG",
      } as unknown as TFile;

      const mockArrayBuffer = new ArrayBuffer(8);
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(mockArrayBuffer);

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/png;base64,test",
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      const result = await ImageProcessor.processImage(mockFile, mockApp);

      expect(result).toBe("data:image/png;base64,test");
    });

    it("accepts webp extension", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "webp",
      } as unknown as TFile;

      const mockArrayBuffer = new ArrayBuffer(8);
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(mockArrayBuffer);

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/webp;base64,test",
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      const result = await ImageProcessor.processImage(mockFile, mockApp);

      expect(result).toBe("data:image/webp;base64,test");
    });

    it("throws PROCESSING_ERROR when vault read fails", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "png",
      } as unknown as TFile;

      (mockApp.vault.readBinary as jest.Mock).mockRejectedValue(new Error("Read failed"));

      await expect(
        ImageProcessor.processImage(mockFile, mockApp)
      ).rejects.toMatchObject({
        code: "PROCESSING_ERROR",
        statusCode: 500,
      });
    });

    it("throws PROCESSING_ERROR when FileReader fails", async () => {
      const mockFile = {
        stat: { size: 1000 },
        extension: "png",
      } as unknown as TFile;

      const mockArrayBuffer = new ArrayBuffer(8);
      (mockApp.vault.readBinary as jest.Mock).mockResolvedValue(mockArrayBuffer);

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        error: new Error("FileReader error"),
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onerror?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      await expect(
        ImageProcessor.processImage(mockFile, mockApp)
      ).rejects.toMatchObject({
        code: "PROCESSING_ERROR",
      });
    });
  });

  describe("processClipboardImage", () => {
    it("throws NO_IMAGE when no files in clipboard", async () => {
      const mockClipboard = {
        files: [],
      } as unknown as DataTransfer;

      await expect(
        ImageProcessor.processClipboardImage(mockClipboard)
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
        ImageProcessor.processClipboardImage(mockClipboard)
      ).rejects.toMatchObject({
        code: "NO_IMAGE",
      });
    });

    it("throws FILE_TOO_LARGE for images over 10MB", async () => {
      const mockClipboard = {
        files: [{ type: "image/png", size: 11 * 1024 * 1024 }],
      } as unknown as DataTransfer;

      await expect(
        ImageProcessor.processClipboardImage(mockClipboard)
      ).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
        statusCode: 413,
      });
    });

    it("processes valid clipboard image", async () => {
      const mockFile = {
        type: "image/png",
        size: 1000,
      };

      const mockClipboard = {
        files: [mockFile],
      } as unknown as DataTransfer;

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        result: "data:image/png;base64,clipboardtest",
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onload?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      const result = await ImageProcessor.processClipboardImage(mockClipboard);

      expect(result).toBe("data:image/png;base64,clipboardtest");
    });

    it("handles FileReader errors for clipboard images", async () => {
      const mockFile = {
        type: "image/png",
        size: 1000,
      };

      const mockClipboard = {
        files: [mockFile],
      } as unknown as DataTransfer;

      const mockFileReader = {
        onload: null as any,
        onerror: null as any,
        error: new Error("Clipboard read error"),
        readAsDataURL: jest.fn(function(this: any) {
          setTimeout(() => this.onerror?.(), 0);
        }),
      };
      global.FileReader = jest.fn(() => mockFileReader) as any;

      await expect(
        ImageProcessor.processClipboardImage(mockClipboard)
      ).rejects.toBeDefined();
    });
  });
});
