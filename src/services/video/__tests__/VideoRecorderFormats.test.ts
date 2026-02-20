/**
 * @jest-environment jsdom
 */

import { canRecordVideoInRuntime, pickVideoRecorderFormat, type VideoRecorderFormat } from "../VideoRecorderFormats";

describe("VideoRecorderFormats", () => {
  const originalMediaRecorder = (global as any).MediaRecorder;
  const originalMediaDevices = (global as any).navigator?.mediaDevices;

  afterEach(() => {
    if (originalMediaRecorder) {
      (global as any).MediaRecorder = originalMediaRecorder;
    } else {
      delete (global as any).MediaRecorder;
    }

    if (originalMediaDevices) {
      Object.defineProperty((global as any).navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices,
      });
    } else {
      delete (global as any).navigator.mediaDevices;
    }
  });

  describe("pickVideoRecorderFormat", () => {
    it("prefers mp4 when supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => mimeType.startsWith("video/mp4")),
      };

      const format = pickVideoRecorderFormat();

      expect(format.extension).toBe("mp4");
      expect(format.mimeType).toContain("video/mp4");
    });

    it("falls back to webm when mp4 is unavailable", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => mimeType === "video/webm"),
      };

      const format = pickVideoRecorderFormat();

      expect(format.mimeType).toBe("video/webm");
      expect(format.extension).toBe("webm");
    });

    it("returns fallback webm when no formats are supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn(() => false),
      };

      const format = pickVideoRecorderFormat();

      expect(format.mimeType).toBe("video/webm");
      expect(format.extension).toBe("webm");
    });
  });

  describe("canRecordVideoInRuntime", () => {
    it("returns true when getDisplayMedia and MediaRecorder are available", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn(() => true),
      };
      Object.defineProperty((global as any).navigator, "mediaDevices", {
        configurable: true,
        value: {
          getDisplayMedia: jest.fn(),
        },
      });

      expect(canRecordVideoInRuntime()).toBe(true);
    });

    it("returns false when getDisplayMedia is unavailable", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn(() => true),
      };
      Object.defineProperty((global as any).navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });

      expect(canRecordVideoInRuntime()).toBe(false);
    });
  });

  describe("VideoRecorderFormat interface", () => {
    it("has mimeType and extension", () => {
      const format: VideoRecorderFormat = {
        mimeType: "video/webm",
        extension: "webm",
      };

      expect(format.mimeType).toBe("video/webm");
      expect(format.extension).toBe("webm");
    });
  });
});
