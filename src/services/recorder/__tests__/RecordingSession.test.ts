/**
 * @jest-environment node
 */

// Mock dependencies
jest.mock("../MicrophoneRecorder", () => ({
  MicrophoneRecorder: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    cleanup: jest.fn(),
    getMediaStream: jest.fn().mockReturnValue(null),
  })),
}));

jest.mock("../../../utils/errorHandling", () => ({
  logDebug: jest.fn(),
  logError: jest.fn(),
}));

import { RecordingSession, RecordingSessionOptions } from "../RecordingSession";
import { MicrophoneRecorder } from "../MicrophoneRecorder";

describe("RecordingSession", () => {
  let mockOptions: RecordingSessionOptions;
  let session: RecordingSession;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOptions = {
      app: {
        vault: {
          adapter: {
            exists: jest.fn().mockResolvedValue(true),
          },
        },
      } as any,
      directoryPath: "SystemSculpt/Recordings",
      ensureDirectory: jest.fn().mockResolvedValue(undefined),
      format: {
        mimeType: "audio/webm;codecs=opus",
        extension: "webm",
      },
      preferredMicrophoneId: null,
      onStatus: jest.fn(),
      onError: jest.fn(),
      onComplete: jest.fn(),
    };

    session = new RecordingSession(mockOptions);
  });

  describe("constructor", () => {
    it("creates instance with options", () => {
      expect(session).toBeInstanceOf(RecordingSession);
    });

    it("initializes in inactive state", () => {
      expect(session.isActive()).toBe(false);
    });

    it("initializes with null output path", () => {
      expect(session.getOutputPath()).toBe(null);
    });
  });

  describe("start", () => {
    it("starts recording", async () => {
      await session.start();

      expect(mockOptions.ensureDirectory).toHaveBeenCalledWith("SystemSculpt/Recordings");
      expect(MicrophoneRecorder).toHaveBeenCalled();
      expect(session.isActive()).toBe(true);
    });

    it("sets output path", async () => {
      await session.start();

      const outputPath = session.getOutputPath();
      // Format: YYYY-MM-DD_HH-MM-SS-MMMZ.extension (includes milliseconds and timezone)
      expect(outputPath).toMatch(/SystemSculpt\/Recordings\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.*\.webm/);
    });

    it("does nothing if already active", async () => {
      await session.start();
      await session.start();

      expect(MicrophoneRecorder).toHaveBeenCalledTimes(1);
    });

    it("throws if directory creation fails", async () => {
      (mockOptions.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);

      await expect(session.start()).rejects.toThrow("Failed to create recordings directory");
    });

    it("uses preferred microphone id", async () => {
      mockOptions.preferredMicrophoneId = "test-mic-id";
      session = new RecordingSession(mockOptions);

      await session.start();

      expect(MicrophoneRecorder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          preferredMicrophoneId: "test-mic-id",
        })
      );
    });

    it("passes format to recorder", async () => {
      await session.start();

      expect(MicrophoneRecorder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          mimeType: "audio/webm;codecs=opus",
          extension: "webm",
        })
      );
    });
  });

  describe("stop", () => {
    it("stops the recorder", async () => {
      await session.start();

      session.stop();

      const mockRecorder = (MicrophoneRecorder as jest.Mock).mock.results[0].value;
      expect(mockRecorder.stop).toHaveBeenCalled();
    });

    it("does nothing if no recorder", () => {
      expect(() => session.stop()).not.toThrow();
    });
  });

  describe("dispose", () => {
    it("cleans up recorder", async () => {
      await session.start();

      session.dispose();

      const mockRecorder = (MicrophoneRecorder as jest.Mock).mock.results[0].value;
      expect(mockRecorder.cleanup).toHaveBeenCalled();
      expect(session.isActive()).toBe(false);
    });

    it("does nothing if no recorder", () => {
      expect(() => session.dispose()).not.toThrow();
    });
  });

  describe("getMediaStream", () => {
    it("returns null when no recorder", () => {
      expect(session.getMediaStream()).toBe(null);
    });

    it("returns stream from recorder", async () => {
      const mockStream = {} as MediaStream;
      (MicrophoneRecorder as jest.Mock).mockImplementationOnce(() => ({
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
        cleanup: jest.fn(),
        getMediaStream: jest.fn().mockReturnValue(mockStream),
      }));

      session = new RecordingSession(mockOptions);
      await session.start();

      expect(session.getMediaStream()).toBe(mockStream);
    });
  });

  describe("isActive", () => {
    it("returns false initially", () => {
      expect(session.isActive()).toBe(false);
    });

    it("returns true after start", async () => {
      await session.start();
      expect(session.isActive()).toBe(true);
    });

    it("returns false after dispose", async () => {
      await session.start();
      session.dispose();
      expect(session.isActive()).toBe(false);
    });
  });

  describe("getOutputPath", () => {
    it("returns null before start", () => {
      expect(session.getOutputPath()).toBe(null);
    });

    it("returns path after start", async () => {
      await session.start();
      expect(session.getOutputPath()).not.toBe(null);
    });
  });

  describe("onComplete callback", () => {
    it("is called when recording completes", async () => {
      let completeCallback: ((path: string, blob: Blob) => void) | null = null;

      (MicrophoneRecorder as jest.Mock).mockImplementationOnce(
        (_app: any, opts: any) => {
          completeCallback = opts.onComplete;
          return {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn(),
            cleanup: jest.fn(),
            getMediaStream: jest.fn().mockReturnValue(null),
          };
        }
      );

      session = new RecordingSession(mockOptions);
      await session.start();

      const mockBlob = new Blob(["test"], { type: "audio/webm" });
      completeCallback!("test/path.webm", mockBlob);

      expect(mockOptions.onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: "test/path.webm",
          blob: mockBlob,
          startedAt: expect.any(Number),
          durationMs: expect.any(Number),
        })
      );
    });

    it("disposes session after completion", async () => {
      let completeCallback: ((path: string, blob: Blob) => void) | null = null;

      (MicrophoneRecorder as jest.Mock).mockImplementationOnce(
        (_app: any, opts: any) => {
          completeCallback = opts.onComplete;
          return {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn(),
            cleanup: jest.fn(),
            getMediaStream: jest.fn().mockReturnValue(null),
          };
        }
      );

      session = new RecordingSession(mockOptions);
      await session.start();

      const mockBlob = new Blob(["test"], { type: "audio/webm" });
      completeCallback!("test/path.webm", mockBlob);

      expect(session.isActive()).toBe(false);
    });

    it("propagates recorder stop reason to onComplete result", async () => {
      let completeCallback:
        | ((path: string, blob: Blob, stopReason?: "manual" | "background-hidden" | "background-pagehide") => void)
        | null = null;

      (MicrophoneRecorder as jest.Mock).mockImplementationOnce(
        (_app: any, opts: any) => {
          completeCallback = opts.onComplete;
          return {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn(),
            cleanup: jest.fn(),
            getMediaStream: jest.fn().mockReturnValue(null),
          };
        }
      );

      session = new RecordingSession(mockOptions);
      await session.start();

      const mockBlob = new Blob(["test"], { type: "audio/webm" });
      completeCallback!("test/path.webm", mockBlob, "background-hidden");

      expect(mockOptions.onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: "test/path.webm",
          stopReason: "background-hidden",
        })
      );
    });
  });

  describe("onError callback", () => {
    it("is called when recorder errors", async () => {
      let errorCallback: ((error: Error) => void) | null = null;

      (MicrophoneRecorder as jest.Mock).mockImplementationOnce(
        (_app: any, opts: any) => {
          errorCallback = opts.onError;
          return {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn(),
            cleanup: jest.fn(),
            getMediaStream: jest.fn().mockReturnValue(null),
          };
        }
      );

      session = new RecordingSession(mockOptions);
      await session.start();

      const testError = new Error("Test error");
      errorCallback!(testError);

      expect(mockOptions.onError).toHaveBeenCalledWith(testError);
    });

    it("disposes session on error", async () => {
      let errorCallback: ((error: Error) => void) | null = null;

      (MicrophoneRecorder as jest.Mock).mockImplementationOnce(
        (_app: any, opts: any) => {
          errorCallback = opts.onError;
          return {
            start: jest.fn().mockResolvedValue(undefined),
            stop: jest.fn(),
            cleanup: jest.fn(),
            getMediaStream: jest.fn().mockReturnValue(null),
          };
        }
      );

      session = new RecordingSession(mockOptions);
      await session.start();

      errorCallback!(new Error("Test error"));

      expect(session.isActive()).toBe(false);
    });
  });

  describe("onStreamChanged callback", () => {
    it("is passed to recorder", async () => {
      const onStreamChanged = jest.fn();
      mockOptions.onStreamChanged = onStreamChanged;

      session = new RecordingSession(mockOptions);
      await session.start();

      expect(MicrophoneRecorder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          onStreamChanged,
        })
      );
    });
  });

  describe("buildOutputPath", () => {
    it("generates timestamp-based filename", async () => {
      await session.start();

      const outputPath = session.getOutputPath();
      // Format: YYYY-MM-DD_HH-MM-SS-MMMZ.extension (includes milliseconds and timezone)
      expect(outputPath).toMatch(
        /^SystemSculpt\/Recordings\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.*\.webm$/
      );
    });
  });
});
