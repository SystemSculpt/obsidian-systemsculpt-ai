/**
 * @jest-environment node
 */
import { App, TFile } from "obsidian";

// Mock obsidian
jest.mock("obsidian", () => ({
  App: jest.fn(),
  Notice: jest.fn(),
  TFile: jest.fn(),
}));

// Mock showPopup
jest.mock("../../core/ui", () => ({
  showPopup: jest.fn().mockResolvedValue({ confirmed: true }),
}));

import {
  MAX_FILE_SIZE,
  validateFileSize,
  validateBrowserFileSize,
  formatFileSize,
} from "../FileValidator";
import { showPopup } from "../../core/ui";

describe("FileValidator", () => {
  let mockApp: App;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApp = {} as App;
  });

  describe("MAX_FILE_SIZE", () => {
    it("is 500MB in bytes", () => {
      expect(MAX_FILE_SIZE).toBe(500 * 1024 * 1024);
    });
  });

  describe("formatFileSize", () => {
    it("formats bytes correctly", () => {
      expect(formatFileSize(100)).toBe("100 bytes");
      expect(formatFileSize(500)).toBe("500 bytes");
      expect(formatFileSize(1023)).toBe("1023 bytes");
    });

    it("formats kilobytes correctly", () => {
      expect(formatFileSize(1024)).toBe("1.0 KB");
      expect(formatFileSize(1536)).toBe("1.5 KB");
      expect(formatFileSize(10 * 1024)).toBe("10.0 KB");
    });

    it("formats megabytes correctly", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
      expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0 MB");
      expect(formatFileSize(500 * 1024 * 1024)).toBe("500.0 MB");
    });

    it("handles edge cases", () => {
      expect(formatFileSize(0)).toBe("0 bytes");
      expect(formatFileSize(1)).toBe("1 bytes");
    });
  });

  describe("validateFileSize", () => {
    it("returns true for small files", async () => {
      const mockFile = {
        name: "small.txt",
        stat: { size: 1000 },
      } as unknown as TFile;

      const result = await validateFileSize(mockFile, mockApp);

      expect(result).toBe(true);
      expect(showPopup).not.toHaveBeenCalled();
    });

    it("returns true for files at exactly max size", async () => {
      const mockFile = {
        name: "exact.txt",
        stat: { size: MAX_FILE_SIZE },
      } as unknown as TFile;

      const result = await validateFileSize(mockFile, mockApp);

      expect(result).toBe(true);
    });

    it("returns false for files exceeding max size", async () => {
      const mockFile = {
        name: "large.txt",
        stat: { size: MAX_FILE_SIZE + 1 },
      } as unknown as TFile;

      const result = await validateFileSize(mockFile, mockApp);

      expect(result).toBe(false);
      expect(showPopup).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining("large.txt"),
        expect.objectContaining({
          title: "File Size Limit Exceeded",
        })
      );
    });

    it("shows popup with file size info when too large", async () => {
      const mockFile = {
        name: "huge.txt",
        stat: { size: 600 * 1024 * 1024 },
      } as unknown as TFile;

      await validateFileSize(mockFile, mockApp);

      expect(showPopup).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining("600.0 MB"),
        expect.any(Object)
      );
    });

    it("supports custom max size and labels", async () => {
      const mockFile = {
        name: "custom.txt",
        stat: { size: 2048 },
      } as unknown as TFile;

      await validateFileSize(mockFile, mockApp, {
        maxBytes: 1024,
        maxLabel: "1 KB",
        title: "Custom Limit",
        description: "Custom description",
      });

      expect(showPopup).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining("maximum allowed size is 1 KB"),
        expect.objectContaining({
          title: "Custom Limit",
          description: "Custom description",
        })
      );
    });
  });

  describe("validateBrowserFileSize", () => {
    it("returns true for small files", async () => {
      const mockFile = {
        name: "small.txt",
        size: 1000,
      } as File;

      const result = await validateBrowserFileSize(mockFile, mockApp);

      expect(result).toBe(true);
      expect(showPopup).not.toHaveBeenCalled();
    });

    it("returns false for files exceeding max size", async () => {
      const mockFile = {
        name: "large.txt",
        size: MAX_FILE_SIZE + 1,
      } as File;

      const result = await validateBrowserFileSize(mockFile, mockApp);

      expect(result).toBe(false);
      expect(showPopup).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining("large.txt"),
        expect.objectContaining({
          title: "File Size Limit Exceeded",
        })
      );
    });

    it("returns true for files at exactly max size", async () => {
      const mockFile = {
        name: "exact.txt",
        size: MAX_FILE_SIZE,
      } as File;

      const result = await validateBrowserFileSize(mockFile, mockApp);

      expect(result).toBe(true);
    });

    it("shows popup with description for too large files", async () => {
      const mockFile = {
        name: "huge.txt",
        size: 600 * 1024 * 1024,
      } as File;

      await validateBrowserFileSize(mockFile, mockApp);

      expect(showPopup).toHaveBeenCalledWith(
        mockApp,
        expect.any(String),
        expect.objectContaining({
          description: "Please reduce the file size or choose a smaller file.",
          primaryButton: "OK",
        })
      );
    });

    it("supports custom max size for browser files", async () => {
      const mockFile = {
        name: "browser.txt",
        size: 2048,
      } as File;

      await validateBrowserFileSize(mockFile, mockApp, {
        maxBytes: 1024,
        maxLabel: "1 KB",
      });

      expect(showPopup).toHaveBeenCalledWith(
        mockApp,
        expect.stringContaining("maximum allowed size is 1 KB"),
        expect.any(Object)
      );
    });
  });
});
