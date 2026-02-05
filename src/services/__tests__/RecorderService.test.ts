/**
 * @jest-environment node
 */

import { App } from "obsidian";
import { RecorderService } from "../RecorderService";

// Mock dependencies
jest.mock("../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn().mockReturnValue({
      isMobile: jest.fn().mockReturnValue(false),
    }),
  },
}));

jest.mock("../recorder/RecorderUIManager", () => ({
  RecorderUIManager: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    setStatus: jest.fn(),
    setRecordingState: jest.fn(),
    startTimer: jest.fn(),
    stopTimer: jest.fn(),
    attachStream: jest.fn(),
    detachStream: jest.fn(),
    linger: jest.fn(),
    closeAfter: jest.fn(),
    isVisible: jest.fn().mockReturnValue(false),
  })),
}));

jest.mock("../recorder/RecorderFormats", () => ({
  pickRecorderFormat: jest.fn().mockReturnValue({
    mimeType: "audio/webm;codecs=opus",
    extension: "webm",
  }),
}));

jest.mock("../recorder/RecordingSession", () => ({
  RecordingSession: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    dispose: jest.fn(),
    isActive: jest.fn().mockReturnValue(false),
    getMediaStream: jest.fn().mockReturnValue(null),
    getOutputPath: jest.fn().mockReturnValue("test/path.webm"),
  })),
}));

jest.mock("../transcription/TranscriptionCoordinator", () => ({
  TranscriptionCoordinator: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue("Transcribed text"),
  })),
}));

jest.mock("../../utils/errorHandling", () => ({
  logDebug: jest.fn(),
  logInfo: jest.fn(),
  logWarning: jest.fn(),
  logError: jest.fn(),
}));

describe("RecorderService", () => {
  let mockApp: App;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset singleton
    (RecorderService as any).instance = null;

    mockApp = new App();

    mockPlugin = {
      settings: {
        recordingsDirectory: "SystemSculpt/Recordings",
        preferredMicrophoneId: null,
        autoTranscribeRecordings: false,
        postProcessingEnabled: false,
      },
      directoryManager: {
        ensureDirectoryByPath: jest.fn().mockResolvedValue(undefined),
      },
    };
  });

  describe("getInstance", () => {
    it("creates singleton instance", () => {
      const instance1 = RecorderService.getInstance(mockApp, mockPlugin);
      const instance2 = RecorderService.getInstance();

      expect(instance1).toBe(instance2);
    });

    it("throws when not initialized and no args provided", () => {
      expect(() => RecorderService.getInstance()).toThrow(
        "RecorderService has not been initialized"
      );
    });

    it("updates onTranscriptionComplete callback", () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const instance1 = RecorderService.getInstance(mockApp, mockPlugin, {
        onTranscriptionComplete: callback1,
      });
      const instance2 = RecorderService.getInstance(mockApp, mockPlugin, {
        onTranscriptionComplete: callback2,
      });

      expect(instance1).toBe(instance2);
      // Callback should be updated
      expect((instance2 as any).onTranscriptionDone).toBe(callback2);
    });
  });

  describe("onToggle", () => {
    it("registers toggle listener", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const listener = jest.fn();

      service.onToggle(listener);

      expect((service as any).listeners.has(listener)).toBe(true);
    });

    it("returns unsubscribe function", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const listener = jest.fn();

      const unsubscribe = service.onToggle(listener);
      unsubscribe();

      expect((service as any).listeners.has(listener)).toBe(false);
    });
  });

  describe("unload", () => {
    it("clears listeners", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      service.onToggle(jest.fn());

      service.unload();

      expect((service as any).listeners.size).toBe(0);
    });

    it("stops recording if active", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).isRecording = true;

      const stopSpy = jest.spyOn(service as any, "stopRecording");
      service.unload();

      expect(stopSpy).toHaveBeenCalled();
    });
  });

  describe("toggleRecording", () => {
    it("queues toggle operations", async () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      // Mock the internal methods
      const performToggleSpy = jest
        .spyOn(service as any, "performToggle")
        .mockResolvedValue(undefined);

      await service.toggleRecording();

      expect(performToggleSpy).toHaveBeenCalled();
    });

    it("serializes concurrent toggle calls", async () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      let callCount = 0;

      jest
        .spyOn(service as any, "performToggle")
        .mockImplementation(async () => {
          callCount++;
          await new Promise((resolve) => setTimeout(resolve, 10));
        });

      // Make concurrent calls
      const promise1 = service.toggleRecording();
      const promise2 = service.toggleRecording();

      await Promise.all([promise1, promise2]);

      expect(callCount).toBe(2);
    });

    it("honors stop pressed while starting (single tap)", async () => {
      const { RecordingSession } = require("../recorder/RecordingSession");

      const startDeferred = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
          resolve = res;
        });
        return { promise, resolve };
      })();

      let onComplete: ((result: any) => void) | null = null;
      const stopMock = jest.fn(() => {
        onComplete?.({
          filePath: "SystemSculpt/Recordings/test.webm",
          blob: new Blob(["test"], { type: "audio/webm" }),
          startedAt: Date.now(),
          durationMs: 50,
        });
      });

      (RecordingSession as jest.Mock).mockImplementationOnce((options: any) => {
        onComplete = options.onComplete;
        return {
          start: jest.fn().mockReturnValue(startDeferred.promise),
          stop: stopMock,
          dispose: jest.fn(),
          isActive: jest.fn().mockReturnValue(true),
          getMediaStream: jest.fn().mockReturnValue(null),
          getOutputPath: jest.fn().mockReturnValue("SystemSculpt/Recordings/test.webm"),
        };
      });

      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const togglePromise = service.toggleRecording();

      for (let i = 0; i < 4; i++) {
        const openMock = (service as any).ui.open as jest.Mock;
        if (openMock.mock.calls.length > 0) break;
        await Promise.resolve();
      }

      const openMock = (service as any).ui.open as jest.Mock;
      expect(openMock).toHaveBeenCalledTimes(1);
      const stopCallback = openMock.mock.calls[0][0] as () => void;

      stopCallback();
      expect(stopMock).not.toHaveBeenCalled();

      startDeferred.resolve();
      await togglePromise;

      expect(stopMock).toHaveBeenCalledTimes(1);
      expect((service as any).isRecording).toBe(false);
    });
  });

  describe("notifyListeners (private)", () => {
    it("notifies all listeners with recording state", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const listener1 = jest.fn();
      const listener2 = jest.fn();

      service.onToggle(listener1);
      service.onToggle(listener2);

      (service as any).isRecording = true;
      (service as any).notifyListeners();

      expect(listener1).toHaveBeenCalledWith(true);
      expect(listener2).toHaveBeenCalledWith(true);
    });

    it("handles listener errors gracefully", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const throwingListener = jest.fn().mockImplementation(() => {
        throw new Error("Listener error");
      });
      const goodListener = jest.fn();

      service.onToggle(throwingListener);
      service.onToggle(goodListener);

      expect(() => (service as any).notifyListeners()).not.toThrow();
      expect(goodListener).toHaveBeenCalled();
    });
  });

  describe("cleanup (private)", () => {
    it("disposes session if exists", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const mockSession = {
        dispose: jest.fn(),
        isActive: jest.fn().mockReturnValue(false),
      };
      (service as any).session = mockSession;

      (service as any).cleanup(true);

      expect(mockSession.dispose).toHaveBeenCalled();
      expect((service as any).session).toBeNull();
    });

    it("resets recording state", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).isRecording = true;
      (service as any).lifecycleState = "recording";

      (service as any).cleanup(false);

      expect((service as any).isRecording).toBe(false);
      expect((service as any).lifecycleState).toBe("idle");
    });

    it("closes UI when hideUI is true", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const mockClose = (service as any).ui.close;

      (service as any).cleanup(true);

      expect(mockClose).toHaveBeenCalled();
    });

    it("does not close UI when hideUI is false", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const mockClose = (service as any).ui.close;

      (service as any).cleanup(false);

      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  describe("getStateSnapshot (private)", () => {
    it("returns current state", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).isRecording = true;
      (service as any).lifecycleState = "recording";

      const snapshot = (service as any).getStateSnapshot();

      expect(snapshot).toEqual(
        expect.objectContaining({
          isRecording: true,
          lifecycleState: "recording",
          hasSession: false,
        })
      );
    });
  });

  describe("storeRecordingInMemory (private)", () => {
    it("stores blob in offline recordings map", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const mockBlob = new Blob(["test"], { type: "audio/webm" });
      const result = {
        filePath: "test/recording.webm",
        blob: mockBlob,
        startedAt: Date.now(),
        durationMs: 1000,
      };

      (service as any).storeRecordingInMemory(result);

      expect((service as any).offlineRecordings.has("test/recording.webm")).toBe(
        true
      );
    });
  });

  describe("handleError (private)", () => {
    it("logs error", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const mockError = new Error("Test error");

      (service as any).handleError(mockError);

      const { logError } = require("../../utils/errorHandling");
      expect(logError).toHaveBeenCalled();
    });

    it("shows error message with backup if available", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).lastRecordingPath = "test/file.webm";
      (service as any).offlineRecordings.set(
        "test/file.webm",
        new Blob(["test"])
      );

      (service as any).handleError(new Error("Processing failed"));

      expect((service as any).ui.setStatus).toHaveBeenCalledWith(
        expect.stringContaining("processing failed")
      );
    });

    it("resets lifecycle state", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).lifecycleState = "recording";

      (service as any).handleError(new Error("Error"));

      expect((service as any).lifecycleState).toBe("idle");
    });
  });

  describe("updateStatus (private)", () => {
    it("calls ui setStatus", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      (service as any).updateStatus("Test status");

      expect((service as any).ui.setStatus).toHaveBeenCalledWith("Test status");
    });
  });

  describe("handleTranscriptionComplete (private)", () => {
    it("calls onTranscriptionDone callback", () => {
      const callback = jest.fn();
      const service = RecorderService.getInstance(mockApp, mockPlugin, {
        onTranscriptionComplete: callback,
      });

      (service as any).handleTranscriptionComplete("Test transcription");

      expect(callback).toHaveBeenCalledWith("Test transcription");
    });

    it("shows linger message when no callback", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      (service as any).handleTranscriptionComplete("Test transcription");

      expect((service as any).ui.linger).toHaveBeenCalledWith(
        "Transcription ready.",
        2600
      );
    });

    it("shows post-processing message when enabled", () => {
      mockPlugin.settings.postProcessingEnabled = true;
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      (service as any).handleTranscriptionComplete("Test transcription");

      expect((service as any).ui.linger).toHaveBeenCalledWith(
        "Transcription ready. Post-processing complete.",
        2600
      );
    });

    it("handles errors gracefully", () => {
      const throwingCallback = jest.fn().mockImplementation(() => {
        throw new Error("Callback error");
      });
      const service = RecorderService.getInstance(mockApp, mockPlugin, {
        onTranscriptionComplete: throwingCallback,
      });

      expect(() =>
        (service as any).handleTranscriptionComplete("Test")
      ).not.toThrow();

      expect((service as any).ui.setStatus).toHaveBeenCalledWith(
        expect.stringContaining("Failed to process transcription")
      );
    });
  });

  describe("handleRecordingComplete (private)", () => {
    it("shows explicit lock/background guidance when stop reason is background", async () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      mockPlugin.settings.autoTranscribeRecordings = false;
      (service as any).isRecording = true;

      await (service as any).handleRecordingComplete({
        filePath: "SystemSculpt/Recordings/test-audio.webm",
        blob: new Blob(["audio"], { type: "audio/webm" }),
        startedAt: Date.now() - 1500,
        durationMs: 1500,
        stopReason: "background-hidden",
      });

      expect((service as any).isRecording).toBe(false);
      expect((service as any).ui.setRecordingState).toHaveBeenCalledWith(false);
      expect((service as any).ui.stopTimer).toHaveBeenCalled();
      expect((service as any).ui.linger).toHaveBeenCalledWith(
        expect.stringContaining("iOS stopped recording when the app locked/backgrounded"),
        4200
      );
    });

    it("uses normal saved message for manual stop reason", async () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      mockPlugin.settings.autoTranscribeRecordings = false;
      (service as any).isRecording = true;

      await (service as any).handleRecordingComplete({
        filePath: "SystemSculpt/Recordings/test-audio.webm",
        blob: new Blob(["audio"], { type: "audio/webm" }),
        startedAt: Date.now() - 900,
        durationMs: 900,
        stopReason: "manual",
      });

      expect((service as any).isRecording).toBe(false);
      expect((service as any).ui.setRecordingState).toHaveBeenCalledWith(false);
      expect((service as any).ui.stopTimer).toHaveBeenCalled();
      expect((service as any).ui.linger).toHaveBeenCalledWith(
        expect.stringContaining("Saved to test-audio.webm"),
        2400
      );
    });
  });

  describe("handleStreamChanged (private)", () => {
    it("attaches stream to UI", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      const mockStream = {} as MediaStream;

      (service as any).handleStreamChanged(mockStream);

      expect((service as any).ui.attachStream).toHaveBeenCalledWith(mockStream);
    });
  });

  describe("beginSessionLifecycle (private)", () => {
    it("creates session completion promise", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      (service as any).beginSessionLifecycle();

      expect((service as any).sessionCompletionPromise).not.toBeNull();
      expect((service as any).sessionCompletionResolver).not.toBeNull();
    });

    it("skips if promise already active", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).beginSessionLifecycle();
      const firstPromise = (service as any).sessionCompletionPromise;

      (service as any).beginSessionLifecycle();

      expect((service as any).sessionCompletionPromise).toBe(firstPromise);
    });
  });

  describe("resolveSessionLifecycle (private)", () => {
    it("resolves pending promise", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).beginSessionLifecycle();

      (service as any).resolveSessionLifecycle();

      expect((service as any).sessionCompletionPromise).toBeNull();
      expect((service as any).sessionCompletionResolver).toBeNull();
    });

    it("does nothing if no pending promise", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      expect(() => (service as any).resolveSessionLifecycle()).not.toThrow();
    });
  });

  describe("waitForSessionLifecycle (private)", () => {
    it("waits for pending promise", async () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).beginSessionLifecycle();

      let resolved = false;
      const waitPromise = (service as any).waitForSessionLifecycle().then(() => {
        resolved = true;
      });

      expect(resolved).toBe(false);

      (service as any).resolveSessionLifecycle();
      await waitPromise;

      expect(resolved).toBe(true);
    });

    it("handles errors gracefully", async () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);
      (service as any).sessionCompletionPromise = Promise.reject(
        new Error("Test error")
      );

      await expect(
        (service as any).waitForSessionLifecycle()
      ).resolves.not.toThrow();
    });
  });

  describe("lifecycle state management", () => {
    it("starts in idle state", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      expect((service as any).lifecycleState).toBe("idle");
    });

    it("isRecording starts as false", () => {
      const service = RecorderService.getInstance(mockApp, mockPlugin);

      expect((service as any).isRecording).toBe(false);
    });
  });
});
