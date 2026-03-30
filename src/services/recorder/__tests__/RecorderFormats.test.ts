/**
 * @jest-environment jsdom
 */

import { pickRecorderFormat, RecorderFormat } from "../RecorderFormats";

describe("RecorderFormats", () => {
  const originalMediaRecorder = (global as any).MediaRecorder;

  afterEach(() => {
    // Restore original MediaRecorder
    if (originalMediaRecorder) {
      (global as any).MediaRecorder = originalMediaRecorder;
    } else {
      delete (global as any).MediaRecorder;
    }
  });

  describe("pickRecorderFormat", () => {
    it("prefers m4a on mobile when requested and supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/mp4;codecs=mp4a.40.2";
        }),
      };

      const format = pickRecorderFormat({ preferM4a: true });

      expect(format.mimeType).toBe("audio/mp4;codecs=mp4a.40.2");
      expect(format.extension).toBe("m4a");
    });

    it("falls back to standard formats when m4a is preferred but unsupported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/webm;codecs=opus";
        }),
      };

      const format = pickRecorderFormat({ preferM4a: true });

      expect(format.mimeType).toBe("audio/webm;codecs=opus");
      expect(format.extension).toBe("webm");
    });

    it("returns webm with opus codec when supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/webm;codecs=opus";
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm;codecs=opus");
      expect(format.extension).toBe("webm");
    });

    it("returns plain webm when opus not supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/webm";
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm");
      expect(format.extension).toBe("webm");
    });

    it("returns ogg with opus when webm not supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/ogg;codecs=opus";
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/ogg;codecs=opus");
      expect(format.extension).toBe("ogg");
    });

    it("returns wav when no other format supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/wav";
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/wav");
      expect(format.extension).toBe("wav");
    });

    it("returns fallback webm when no formats supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn(() => false),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm");
      expect(format.extension).toBe("webm");
    });

    it("returns fallback when MediaRecorder is undefined", () => {
      delete (global as any).MediaRecorder;

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm");
      expect(format.extension).toBe("webm");
    });

    it("returns fallback when isTypeSupported throws", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn(() => {
          throw new Error("Not supported");
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm");
      expect(format.extension).toBe("webm");
    });

    it("returns fallback when isTypeSupported is not a function", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: "not a function",
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm");
      expect(format.extension).toBe("webm");
    });

    it("prefers opus webm over plain webm", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/webm;codecs=opus" || mimeType === "audio/webm";
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm;codecs=opus");
    });

    it("prefers webm over ogg", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/webm" || mimeType === "audio/ogg;codecs=opus";
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/webm");
    });

    it("prefers ogg over wav", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/ogg;codecs=opus" || mimeType === "audio/wav";
        }),
      };

      const format = pickRecorderFormat();

      expect(format.mimeType).toBe("audio/ogg;codecs=opus");
    });

    it("prefers m4a on mobile when mp4 recording is supported", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/mp4";
        }),
      };

      const format = pickRecorderFormat({ preferM4a: true });

      expect(format.mimeType).toBe("audio/mp4");
      expect(format.extension).toBe("m4a");
    });

    it("falls back to webm on mobile when m4a is unavailable", () => {
      (global as any).MediaRecorder = {
        isTypeSupported: jest.fn((mimeType: string) => {
          return mimeType === "audio/webm;codecs=opus";
        }),
      };

      const format = pickRecorderFormat({ preferM4a: true });

      expect(format.mimeType).toBe("audio/webm;codecs=opus");
      expect(format.extension).toBe("webm");
    });
  });

  describe("RecorderFormat interface", () => {
    it("has mimeType and extension properties", () => {
      const format: RecorderFormat = {
        mimeType: "audio/test",
        extension: "test",
      };

      expect(format.mimeType).toBe("audio/test");
      expect(format.extension).toBe("test");
    });
  });
});
