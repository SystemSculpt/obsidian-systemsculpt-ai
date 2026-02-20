/**
 * @jest-environment node
 */

jest.mock("../ObsidianWindowRecorder", () => ({
  ObsidianWindowRecorder: jest.fn().mockImplementation(() => ({
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

import { ObsidianWindowRecorder } from "../ObsidianWindowRecorder";
import { VideoRecordingSession, type VideoRecordingSessionOptions } from "../VideoRecordingSession";

describe("VideoRecordingSession", () => {
  let mockOptions: VideoRecordingSessionOptions;
  let session: VideoRecordingSession;

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
      directoryPath: "SystemSculpt/Video Recordings",
      ensureDirectory: jest.fn().mockResolvedValue(undefined),
      format: {
        mimeType: "video/webm",
        extension: "webm",
      },
      onStatus: jest.fn(),
      onError: jest.fn(),
      onComplete: jest.fn(),
      captureAudio: {
        includeSystemAudio: true,
        includeMicrophoneAudio: true,
        preferredMicrophoneId: "default",
      },
    };

    session = new VideoRecordingSession(mockOptions);
  });

  it("starts a video recording session", async () => {
    await session.start();

    expect(mockOptions.ensureDirectory).toHaveBeenCalledWith("SystemSculpt/Video Recordings");
    expect(ObsidianWindowRecorder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        captureAudio: expect.objectContaining({
          includeSystemAudio: true,
          includeMicrophoneAudio: true,
          preferredMicrophoneId: "default",
        }),
      })
    );
    expect(session.isActive()).toBe(true);
  });

  it("builds output path with configured extension", async () => {
    await session.start();

    const outputPath = session.getOutputPath();
    expect(outputPath).toMatch(/SystemSculpt\/Video Recordings\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}.*\.webm/);
  });

  it("throws when directory cannot be created", async () => {
    (mockOptions.app.vault.adapter.exists as jest.Mock).mockResolvedValue(false);
    await expect(session.start()).rejects.toThrow("Failed to create video recordings directory");
  });

  it("stops the underlying recorder", async () => {
    await session.start();
    session.stop();
    const recorder = (ObsidianWindowRecorder as jest.Mock).mock.results[0].value;
    expect(recorder.stop).toHaveBeenCalled();
  });

  it("disposes recorder on dispose", async () => {
    await session.start();
    session.dispose();
    const recorder = (ObsidianWindowRecorder as jest.Mock).mock.results[0].value;
    expect(recorder.cleanup).toHaveBeenCalled();
    expect(session.isActive()).toBe(false);
  });

  it("forwards completion payload and stop reason", async () => {
    let completeCallback:
      | ((path: string, blob: Blob, stopReason?: "manual" | "source-ended" | "permission-revoked") => void)
      | null = null;

    (ObsidianWindowRecorder as jest.Mock).mockImplementationOnce((_app: any, opts: any) => {
      completeCallback = opts.onComplete;
      return {
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn(),
        cleanup: jest.fn(),
        getMediaStream: jest.fn().mockReturnValue(null),
      };
    });

    session = new VideoRecordingSession(mockOptions);
    await session.start();

    const blob = new Blob(["video-data"], { type: "video/webm" });
    completeCallback!("SystemSculpt/Video Recordings/test.webm", blob, "source-ended");

    expect(mockOptions.onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: "SystemSculpt/Video Recordings/test.webm",
        blob,
        stopReason: "source-ended",
      })
    );
  });
});
