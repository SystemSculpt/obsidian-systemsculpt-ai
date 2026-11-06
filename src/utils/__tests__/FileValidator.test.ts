/**
 * @jest-environment node
 */

jest.mock("../../core/ui/modals/PromptModal", () => {
  throw new Error("File-size utilities must not load presentation code.");
});

import { MAX_FILE_SIZE, formatFileSize } from "../FileValidator";

describe("FileValidator", () => {
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
      expect(formatFileSize(1024)).toBe("1.0 KiB");
      expect(formatFileSize(1536)).toBe("1.5 KiB");
      expect(formatFileSize(10 * 1024)).toBe("10.0 KiB");
    });

    it("formats megabytes correctly", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.0 MiB");
      expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0 MiB");
      expect(formatFileSize(500 * 1024 * 1024)).toBe("500.0 MiB");
    });

    it("handles edge cases", () => {
      expect(formatFileSize(0)).toBe("0 bytes");
      expect(formatFileSize(1)).toBe("1 bytes");
    });
  });
});
