/**
 * @jest-environment jsdom
 */

// Assigned inside the Jest mock factory (jest.mock calls are hoisted).
// eslint-disable-next-line no-var
var MockTFile: any;

// Mock navigator.clipboard
Object.defineProperty(navigator, "clipboard", {
  value: {
    writeText: jest.fn().mockResolvedValue(undefined),
  },
  writable: true,
});

// Mock obsidian
jest.mock("obsidian", () => {
  MockTFile = class MockTFile {
    path: string;
    basename: string;
    stat: { mtime: number };

    constructor(path: string) {
      this.path = path;
      this.basename = path.split("/").pop()?.replace(/\.[^.]+$/, "") || path;
      this.stat = { mtime: Date.now() };
    }
  };

  return {
    App: jest.fn(),
    Notice: jest.fn(),
    TFile: MockTFile,
    MarkdownView: jest.fn(),
  };
});

// Mock AudioTranscriptionModal
jest.mock("../../../modals/AudioTranscriptionModal", () => ({
  AudioTranscriptionModal: jest.fn().mockImplementation((app: any, options: any) => ({
    open: jest.fn(() => {
      // Simulate modal completion
      if (options.onTranscriptionComplete) {
        setTimeout(() => options.onTranscriptionComplete("Modal transcription"), 0);
      }
    }),
  })),
}));

// Mock PlatformContext
jest.mock("../../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      isMobile: jest.fn(() => false),
    })),
  },
}));

// Mock ChatView
jest.mock("../../../views/chatview/ChatView", () => ({
  CHAT_VIEW_TYPE: "systemsculpt-chat-view",
}));

// Mock TranscriptionService
// eslint-disable-next-line no-var
var mockTranscribeFile: jest.Mock;
jest.mock("../../TranscriptionService", () => {
  mockTranscribeFile = jest.fn();
  return {
    TranscriptionService: {
      getInstance: jest.fn(() => ({
        transcribeFile: mockTranscribeFile,
      })),
    },
  };
});

// Mock PostProcessingService
// eslint-disable-next-line no-var
var mockProcessTranscription: jest.Mock;
jest.mock("../../PostProcessingService", () => {
  mockProcessTranscription = jest.fn();
  return {
    PostProcessingService: {
      getInstance: jest.fn(() => ({
        processTranscription: mockProcessTranscription,
      })),
    },
  };
});

// Mock TranscriptionProgressManager
// eslint-disable-next-line no-var
var mockCreateProgressHandler: jest.Mock;
// eslint-disable-next-line no-var
var mockHandleCompletion: jest.Mock;
// eslint-disable-next-line no-var
var mockClearProgress: jest.Mock;
jest.mock("../../TranscriptionProgressManager", () => {
  mockCreateProgressHandler = jest.fn();
  mockHandleCompletion = jest.fn();
  mockClearProgress = jest.fn();
  return {
    TranscriptionProgressManager: {
      getInstance: jest.fn(() => ({
        createProgressHandler: mockCreateProgressHandler,
        handleCompletion: mockHandleCompletion,
        clearProgress: mockClearProgress,
      })),
    },
  };
});

import { TranscriptionCoordinator } from "../TranscriptionCoordinator";
import { TranscriptionTitleService } from "../TranscriptionTitleService";

describe("TranscriptionCoordinator", () => {
  let coordinator: TranscriptionCoordinator;
  let mockApp: any;
  let mockPlugin: any;
  let mockTFile: any;

  beforeEach(() => {
    jest.clearAllMocks();
    (TranscriptionTitleService as any).instance = null;

    // Use MockTFile instance for instanceof checks
    mockTFile = new MockTFile("recordings/test-audio.webm");

    mockApp = {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => (path === mockTFile.path ? mockTFile : null)),
        delete: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockImplementation(async (path: string) => new MockTFile(path)),
        modify: jest.fn().mockResolvedValue(undefined),
      },
      workspace: {
        activeLeaf: {
          view: {
            getViewType: jest.fn(() => "markdown"),
          },
        },
        getActiveViewOfType: jest.fn(() => null),
      },
    };

    mockPlugin = {
      settings: {
        postProcessingEnabled: false,
        autoPasteTranscription: false,
        keepRecordingsAfterTranscription: true,
        cleanTranscriptionOutput: true,
      },
    };

    // Setup default mocks
    mockTranscribeFile.mockResolvedValue("Transcribed text");
    mockProcessTranscription.mockResolvedValue("Processed text");
    mockCreateProgressHandler.mockReturnValue({
      onProgress: jest.fn(),
    });

    const mockPlatform = {
      isMobile: jest.fn(() => false),
    };

    coordinator = new TranscriptionCoordinator(mockApp, mockPlugin, mockPlatform as any);
  });

  describe("constructor", () => {
    it("creates instance with app and plugin", () => {
      expect(coordinator).toBeInstanceOf(TranscriptionCoordinator);
    });
  });

  describe("start", () => {
    describe("modal mode", () => {
      it("opens modal when useModal is true", async () => {
        const { AudioTranscriptionModal } = require("../../../modals/AudioTranscriptionModal");

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          useModal: true,
        });

        expect(AudioTranscriptionModal).toHaveBeenCalled();
      });
    });

    describe("inline mode", () => {
      it("runs inline transcription when callbacks provided", async () => {
        const onComplete = jest.fn();

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: onComplete,
        });

        expect(mockTranscribeFile).toHaveBeenCalled();
        expect(onComplete).toHaveBeenCalledWith("Transcribed text");
      });

      it("reports status updates during transcription", async () => {
        const onStatus = jest.fn();

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: jest.fn(),
          onStatus,
        });

        expect(onStatus).toHaveBeenCalledWith("Transcribing…");
      });

      it("applies post-processing when enabled", async () => {
        mockPlugin.settings.postProcessingEnabled = true;
        mockPlugin.settings.cleanTranscriptionOutput = true;
        const onComplete = jest.fn();

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: onComplete,
        });

        expect(mockProcessTranscription).toHaveBeenCalledWith("Transcribed text");
        expect(onComplete).toHaveBeenCalledWith("Processed text");
      });

      it("skips post-processing when disabled", async () => {
        mockPlugin.settings.postProcessingEnabled = false;

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: jest.fn(),
        });

        expect(mockProcessTranscription).not.toHaveBeenCalled();
      });

      it("creates markdown file for transcription", async () => {
        // Make getAbstractFileByPath return null for .md file (doesn't exist)
        mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
          if (path.endsWith(".md")) return null;
          return mockTFile;
        });

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: jest.fn(),
        });

        expect(mockApp.vault.create).toHaveBeenCalledWith(
          "recordings/test-audio - transcript.md",
          expect.any(String)
        );
      });

      it("reports renamed path to progress manager when title service returns one", async () => {
        mockApp.vault.getAbstractFileByPath.mockImplementation((path: string) => {
          if (path.endsWith(".md")) return null;
          return mockTFile;
        });

        const titleService = TranscriptionTitleService.getInstance(mockPlugin);
        jest.spyOn(titleService, "tryRenameTranscriptionFile").mockResolvedValue(
          "recordings/test-audio - transcript - My Title.md"
        );

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: jest.fn(),
        });

        expect(mockHandleCompletion).toHaveBeenCalledWith(
          "recordings/test-audio.webm",
          "recordings/test-audio - transcript - My Title.md"
        );
      });

      it("keeps recording when keepRecordingsAfterTranscription is true", async () => {
        mockPlugin.settings.keepRecordingsAfterTranscription = true;

        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: jest.fn(),
        });

        expect(mockApp.vault.delete).not.toHaveBeenCalled();
      });
    });

    describe("error handling", () => {
      it("throws error when file not found", async () => {
        mockApp.vault.getAbstractFileByPath.mockReturnValue(null);

        await expect(
          coordinator.start({
            filePath: "nonexistent.webm",
            onTranscriptionComplete: jest.fn(),
          })
        ).rejects.toThrow("Recording file not found");
      });

      it("calls onError callback on transcription failure", async () => {
        const error = new Error("Transcription failed");
        mockTranscribeFile.mockRejectedValue(error);
        const onError = jest.fn();

        await expect(
          coordinator.start({
            filePath: "recordings/test-audio.webm",
            onTranscriptionComplete: jest.fn(),
            onError,
          })
        ).rejects.toThrow("Transcription failed");

        expect(onError).toHaveBeenCalledWith(error);
      });

      it("clears progress on error", async () => {
        mockTranscribeFile.mockRejectedValue(new Error("Failure"));

        await expect(
          coordinator.start({
            filePath: "recordings/test-audio.webm",
            onTranscriptionComplete: jest.fn(),
          })
        ).rejects.toThrow();

        expect(mockClearProgress).toHaveBeenCalledWith("recordings/test-audio.webm");
      });
    });

    describe("context detection", () => {
      it("respects explicit isChatContext setting", async () => {
        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: jest.fn(),
          isChatContext: true,
        });

        // Should pass chat context to transcription service
        expect(mockTranscribeFile).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ type: "chat" })
        );
      });
    });

    describe("timestamped transcription", () => {
      it("passes timestamped option to transcription service", async () => {
        await coordinator.start({
          filePath: "recordings/test-audio.webm",
          onTranscriptionComplete: jest.fn(),
          timestamped: true,
        });

        expect(mockTranscribeFile).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ timestamped: true })
        );
      });
    });
  });

  describe("transcription flow", () => {
    it("copies transcription to clipboard", async () => {
      await coordinator.start({
        filePath: "recordings/test-audio.webm",
        onTranscriptionComplete: jest.fn(),
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Transcribed text");
    });

    it("calls handleCompletion on progress manager", async () => {
      await coordinator.start({
        filePath: "recordings/test-audio.webm",
        onTranscriptionComplete: jest.fn(),
      });

      expect(mockHandleCompletion).toHaveBeenCalledWith(
        "recordings/test-audio.webm",
        "recordings/test-audio - transcript.md"
      );
    });
  });
});
