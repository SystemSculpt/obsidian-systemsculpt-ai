/**
 * @jest-environment jsdom
 */
import { TFile } from "obsidian";
import { TranscriptionProgressManager } from "../TranscriptionProgressManager";

// Mock obsidian
jest.mock("obsidian", () => ({
  TFile: class MockTFile {
    path: string;
    constructor(path: string) {
      this.path = path;
    }
  },
}));

// Mock TranscriptionService
jest.mock("../TranscriptionService", () => ({
  TranscriptionContext: {},
}));

describe("TranscriptionProgressManager", () => {
  let manager: TranscriptionProgressManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Reset singleton
    (TranscriptionProgressManager as any).instance = null;
    manager = TranscriptionProgressManager.getInstance();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = TranscriptionProgressManager.getInstance();
      const instance2 = TranscriptionProgressManager.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe("createProgressHandler", () => {
    it("creates progress handler for file", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      const context = manager.createProgressHandler(mockFile);

      expect(context.type).toBe("note");
      expect(context.onProgress).toBeDefined();
    });

    it("initializes active transcription tracking", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      manager.createProgressHandler(mockFile);

      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(true);
    });

    it("calls onProgress callback", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(50, "Processing...");

      expect(onProgress).toHaveBeenCalledWith(50, "Processing...", expect.any(String), undefined);
    });

    it("updates tracking info on progress", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      const context = manager.createProgressHandler(mockFile);
      context.onProgress(75, "Transcribing...");

      const tracking = (manager as any).activeTranscriptions.get("test/audio.mp3");
      expect(tracking.lastProgress).toBe(75);
      expect(tracking.lastStatus).toBe("Transcribing...");
    });

    it("sets x-circle icon for error status", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(0, "Error: Something went wrong");

      expect(onProgress).toHaveBeenCalledWith(0, "Error: Something went wrong", "x-circle", undefined);
    });

    it("sets check-circle icon for 100% progress", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(100, "Complete");

      expect(onProgress).toHaveBeenCalledWith(100, "Complete", "check-circle", undefined);
    });

    it("sets upload icon for uploading status", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(25, "Uploading file...");

      expect(onProgress).toHaveBeenCalledWith(25, "Uploading file...", "upload", undefined);
    });

    it("sets scissors icon for chunk status", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(30, "Chunk 1/3");

      expect(onProgress).toHaveBeenCalledWith(30, "Chunk 1/3", "scissors", undefined);
    });

    it("sets file-audio icon for transcribing status", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(60, "Transcribing audio...");

      expect(onProgress).toHaveBeenCalledWith(60, "Transcribing audio...", "file-audio", undefined);
    });

    it("sets cpu icon for processing status", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(80, "Processing result...");

      expect(onProgress).toHaveBeenCalledWith(80, "Processing result...", "cpu", undefined);
    });

    it("schedules cleanup on 100% completion", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      const context = manager.createProgressHandler(mockFile);
      context.onProgress(100, "Complete");

      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(true);

      jest.advanceTimersByTime(2000);

      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(false);
    });

    it("clears existing cleanup timeout on new progress", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      const context = manager.createProgressHandler(mockFile);
      context.onProgress(100, "Complete");

      // Before cleanup
      jest.advanceTimersByTime(1000);
      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(true);

      // Simulate new progress update which should clear the cleanup
      context.onProgress(50, "Still processing...");

      // Advance past original cleanup time
      jest.advanceTimersByTime(1500);
      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(true);
    });
  });

  describe("handleCompletion", () => {
    it("calls onComplete callback", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onComplete = jest.fn();

      manager.createProgressHandler(mockFile);
      manager.handleCompletion("test/audio.mp3", "test/audio.txt", onComplete);

      expect(onComplete).toHaveBeenCalledWith("test/audio.txt");
    });

    it("schedules cleanup after completion", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      manager.createProgressHandler(mockFile);
      manager.handleCompletion("test/audio.mp3", "test/audio.txt");

      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(true);

      jest.advanceTimersByTime(2000);

      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(false);
    });

    it("clears existing cleanup timeout", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      const context = manager.createProgressHandler(mockFile);
      context.onProgress(100, "Complete"); // Sets a cleanup timeout

      // Call handleCompletion which should clear the old timeout and set a new one
      manager.handleCompletion("test/audio.mp3", "test/audio.txt");

      // The transcription should still be tracked
      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(true);
    });

    it("does nothing for non-tracked file", () => {
      const onComplete = jest.fn();

      manager.handleCompletion("unknown/file.mp3", "unknown/file.txt", onComplete);

      expect(onComplete).not.toHaveBeenCalled();
    });
  });

  describe("clearProgress", () => {
    it("clears transcription tracking", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      manager.createProgressHandler(mockFile);
      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(true);

      manager.clearProgress("test/audio.mp3");

      expect((manager as any).activeTranscriptions.has("test/audio.mp3")).toBe(false);
    });

    it("clears cleanup timeout", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;

      const context = manager.createProgressHandler(mockFile);
      context.onProgress(100, "Complete"); // Sets a cleanup timeout

      manager.clearProgress("test/audio.mp3");

      // Should not throw even after timer advances
      jest.advanceTimersByTime(5000);
    });

    it("handles non-tracked file gracefully", () => {
      // Should not throw
      manager.clearProgress("unknown/file.mp3");
    });
  });

  describe("icon selection", () => {
    it("uses loader-2 as default icon", () => {
      const mockFile = { path: "test/audio.mp3" } as TFile;
      const onProgress = jest.fn();

      const context = manager.createProgressHandler(mockFile, onProgress);
      context.onProgress(50, "Some status");

      expect(onProgress).toHaveBeenCalledWith(50, "Some status", "loader-2", undefined);
    });
  });

  describe("multiple transcriptions", () => {
    it("tracks multiple files independently", () => {
      const mockFile1 = { path: "test/audio1.mp3" } as TFile;
      const mockFile2 = { path: "test/audio2.mp3" } as TFile;

      const context1 = manager.createProgressHandler(mockFile1);
      const context2 = manager.createProgressHandler(mockFile2);

      context1.onProgress(25, "Status 1");
      context2.onProgress(75, "Status 2");

      const tracking1 = (manager as any).activeTranscriptions.get("test/audio1.mp3");
      const tracking2 = (manager as any).activeTranscriptions.get("test/audio2.mp3");

      expect(tracking1.lastProgress).toBe(25);
      expect(tracking2.lastProgress).toBe(75);
    });

    it("cleans up files independently", () => {
      const mockFile1 = { path: "test/audio1.mp3" } as TFile;
      const mockFile2 = { path: "test/audio2.mp3" } as TFile;

      const context1 = manager.createProgressHandler(mockFile1);
      const context2 = manager.createProgressHandler(mockFile2);

      context1.onProgress(100, "Complete");
      // File 2 not complete yet

      jest.advanceTimersByTime(2000);

      expect((manager as any).activeTranscriptions.has("test/audio1.mp3")).toBe(false);
      expect((manager as any).activeTranscriptions.has("test/audio2.mp3")).toBe(true);
    });
  });
});
