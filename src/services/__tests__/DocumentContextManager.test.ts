/**
 * @jest-environment jsdom
 */
import { App, TFile, Notice, TFolder } from "obsidian";
import { DocumentContextManager, ChatContextManager } from "../DocumentContextManager";

// Mock dependencies
const mockCheckLicenseForFile = jest.fn();
jest.mock("../../core/license/LicenseChecker", () => ({
  LicenseChecker: {
    checkLicenseForFile: (...args: any[]) => mockCheckLicenseForFile(...args),
  },
}));

const mockProcessDocument = jest.fn();
jest.mock("../DocumentProcessingService", () => ({
  DocumentProcessingService: {
    getInstance: jest.fn(() => ({
      processDocument: mockProcessDocument,
    })),
  },
}));

const mockTranscribeFile = jest.fn();
jest.mock("../TranscriptionService", () => ({
  TranscriptionService: {
    getInstance: jest.fn(() => ({
      transcribeFile: mockTranscribeFile,
    })),
  },
}));

jest.mock("../TranscriptionProgressManager", () => ({
  TranscriptionProgressManager: {
    getInstance: jest.fn(() => ({
      createProgressHandler: jest.fn(() => ({
        onProgress: jest.fn(),
      })),
      handleCompletion: jest.fn((filePath, outputPath, callback) => callback()),
    })),
  },
}));

describe("DocumentContextManager", () => {
  let mockApp: App;
  let mockPlugin: any;
  let mockContextManager: ChatContextManager;
  let manager: DocumentContextManager;

  const createMockFile = (overrides: Partial<TFile> = {}): TFile =>
    new TFile({
      path: "test/document.md",
      basename: "document",
      extension: "md",
      ...overrides,
    });

  const createMockContextManager = (): ChatContextManager => ({
    getContextFiles: jest.fn(() => new Set<string>()),
    hasContextFile: jest.fn(() => false),
    addToContextFiles: jest.fn(() => true),
    triggerContextChange: jest.fn(() => Promise.resolve()),
    updateProcessingStatus: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset singleton
    (DocumentContextManager as any).instance = null;

    mockApp = new App();
    mockPlugin = {
      settings: {
        extractionsDirectory: "Extractions",
        cleanTranscriptionOutput: false,
      },
      directoryManager: {
        ensureDirectoryByKey: jest.fn(),
        ensureDirectoryByPath: jest.fn(),
      },
    };

    mockContextManager = createMockContextManager();

    // Default mock behaviors
    mockCheckLicenseForFile.mockResolvedValue(true);
    mockProcessDocument.mockResolvedValue("Extractions/document/document.md");
    mockTranscribeFile.mockResolvedValue("Transcribed text content");
    (mockApp.vault.create as jest.Mock).mockResolvedValue({});
    (mockApp.vault.modify as jest.Mock).mockResolvedValue({});

    manager = DocumentContextManager.getInstance(mockApp, mockPlugin);
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = DocumentContextManager.getInstance(mockApp, mockPlugin);
      const instance2 = DocumentContextManager.getInstance(mockApp, mockPlugin);

      expect(instance1).toBe(instance2);
    });
  });

  describe("addFileToContext", () => {
    describe("regular files", () => {
      it("adds markdown file to context", async () => {
        const file = createMockFile({ extension: "md" });

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(true);
        expect(mockContextManager.addToContextFiles).toHaveBeenCalledWith("[[test/document.md]]");
        expect(mockContextManager.triggerContextChange).toHaveBeenCalled();
      });

      it("returns false when file already in context", async () => {
        const file = createMockFile();
        (mockContextManager.hasContextFile as jest.Mock).mockReturnValue(true);

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(false);
        expect(mockContextManager.addToContextFiles).not.toHaveBeenCalled();
      });

      it("returns false when license check fails", async () => {
        const file = createMockFile();
        mockCheckLicenseForFile.mockResolvedValue(false);

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(false);
        expect(mockContextManager.addToContextFiles).not.toHaveBeenCalled();
      });

      it("does not save changes when saveChanges is false", async () => {
        const file = createMockFile();

        await manager.addFileToContext(file, mockContextManager, { saveChanges: false });

        expect(mockContextManager.triggerContextChange).not.toHaveBeenCalled();
      });
    });

    describe("document files", () => {
      it("processes PDF and adds extracted content to context", async () => {
        const file = createMockFile({ path: "test/doc.pdf", extension: "pdf", basename: "doc" });
        mockProcessDocument.mockResolvedValue("Extractions/doc/doc.md");
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
        (mockApp.vault.getAllLoadedFiles as jest.Mock).mockReturnValue([]);

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(true);
        expect(mockProcessDocument).toHaveBeenCalled();
        expect(mockContextManager.addToContextFiles).toHaveBeenCalledWith("[[Extractions/doc/doc.md]]");
        expect(mockContextManager.updateProcessingStatus).toHaveBeenCalledWith(
          file,
          expect.objectContaining({ stage: "queued" })
        );
        expect(mockContextManager.updateProcessingStatus).toHaveBeenCalledWith(
          file,
          expect.objectContaining({ stage: "ready" })
        );
      });

      it("processes DOCX files", async () => {
        const file = createMockFile({ path: "test/doc.docx", extension: "docx", basename: "doc" });
        mockProcessDocument.mockResolvedValue("Extractions/doc/doc.md");
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
        (mockApp.vault.getAllLoadedFiles as jest.Mock).mockReturnValue([]);

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(true);
        expect(mockProcessDocument).toHaveBeenCalled();
      });

      it("handles document processing error", async () => {
        const file = createMockFile({ path: "test/doc.pdf", extension: "pdf" });
        mockProcessDocument.mockRejectedValue(new Error("Processing failed"));

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(false);
        expect(mockContextManager.updateProcessingStatus).toHaveBeenCalledWith(
          file,
          expect.objectContaining({
            stage: "error",
            error: "Processing failed",
          })
        );
      });

      it("adds extracted images to context", async () => {
        const file = createMockFile({ path: "test/doc.pdf", extension: "pdf", basename: "doc" });
        mockProcessDocument.mockResolvedValue("Extractions/doc/doc.md");

        const mockExtractedFile = new TFile({ path: "Extractions/doc/doc.md" });
        const mockParentFolder = new TFolder({ path: "Extractions/doc" });
        (mockExtractedFile as any).parent = mockParentFolder;

        const mockImageFile = new TFile({ path: "Extractions/doc/images-123/image1.png" });

        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(mockExtractedFile);
        (mockApp.vault.getAllLoadedFiles as jest.Mock).mockReturnValue([mockImageFile]);

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(true);
        expect(mockContextManager.addToContextFiles).toHaveBeenCalledWith("[[Extractions/doc/images-123/image1.png]]");
      });
    });

    describe("audio files", () => {
      it("transcribes audio file and adds to context", async () => {
        const file = createMockFile({ path: "test/audio.mp3", extension: "mp3", basename: "audio" });
        mockTranscribeFile.mockResolvedValue("Transcribed text");
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(true);
        expect(mockTranscribeFile).toHaveBeenCalled();
        expect(mockPlugin.directoryManager.ensureDirectoryByKey).toHaveBeenCalledWith("extractionsDirectory");
        expect(mockApp.vault.create).toHaveBeenCalled();
      });

      it("processes WAV files", async () => {
        const file = createMockFile({ path: "test/audio.wav", extension: "wav", basename: "audio" });
        mockTranscribeFile.mockResolvedValue("Transcribed text");
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(true);
        expect(mockTranscribeFile).toHaveBeenCalled();
      });

      it("modifies existing transcription file", async () => {
        const file = createMockFile({ path: "test/audio.mp3", extension: "mp3", basename: "audio" });
        const existingFile = createMockFile({ path: "Extractions/audio/audio.md" });
        mockTranscribeFile.mockResolvedValue("Transcribed text");
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(existingFile);

        await manager.addFileToContext(file, mockContextManager);

        expect(mockApp.vault.modify).toHaveBeenCalled();
        expect(mockApp.vault.create).not.toHaveBeenCalled();
      });

      it("handles transcription error", async () => {
        const file = createMockFile({ path: "test/audio.mp3", extension: "mp3" });
        mockTranscribeFile.mockRejectedValue(new Error("Transcription failed"));

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(false);
        expect(mockContextManager.updateProcessingStatus).toHaveBeenCalledWith(
          file,
          expect.objectContaining({
            stage: "error",
            error: "Transcription failed",
          })
        );
      });

      it("uses clean output when setting enabled", async () => {
        mockPlugin.settings.cleanTranscriptionOutput = true;
        const file = createMockFile({ path: "test/audio.mp3", extension: "mp3", basename: "audio" });
        mockTranscribeFile.mockResolvedValue("Just the text");
        (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

        await manager.addFileToContext(file, mockContextManager);

        expect(mockApp.vault.create).toHaveBeenCalledWith(
          expect.any(String),
          "Just the text"
        );
      });
    });
  });

  describe("addFilesToContext", () => {
    it("adds multiple files to context", async () => {
      const files = [
        createMockFile({ path: "test/doc1.md", basename: "doc1" }),
        createMockFile({ path: "test/doc2.md", basename: "doc2" }),
      ];

      const result = await manager.addFilesToContext(files, mockContextManager);

      expect(result).toBe(2);
      expect(mockContextManager.addToContextFiles).toHaveBeenCalledTimes(2);
      expect(mockContextManager.triggerContextChange).toHaveBeenCalledTimes(1);
    });

    it("respects maxFiles limit", async () => {
      const contextFiles = new Set(["[[file1.md]]", "[[file2.md]]"]);
      (mockContextManager.getContextFiles as jest.Mock).mockReturnValue(contextFiles);

      const files = [
        createMockFile({ path: "test/doc1.md", basename: "doc1" }),
        createMockFile({ path: "test/doc2.md", basename: "doc2" }),
      ];

      const result = await manager.addFilesToContext(files, mockContextManager, { maxFiles: 3 });

      expect(result).toBe(1);
    });

    it("does not save changes when saveChanges is false", async () => {
      const files = [createMockFile()];

      await manager.addFilesToContext(files, mockContextManager, { saveChanges: false });

      expect(mockContextManager.triggerContextChange).not.toHaveBeenCalled();
    });

    it("returns 0 when at max files limit", async () => {
      const contextFiles = new Set(["[[file1.md]]", "[[file2.md]]", "[[file3.md]]"]);
      (mockContextManager.getContextFiles as jest.Mock).mockReturnValue(contextFiles);

      const files = [createMockFile()];

      const result = await manager.addFilesToContext(files, mockContextManager, { maxFiles: 3 });

      expect(result).toBe(0);
    });
  });

  describe("mapAudioStatusToStage", () => {
    // Access private method via bracket notation for testing
    it("maps error status to error stage", () => {
      const result = (manager as any).mapAudioStatusToStage("Error occurred", 0);
      expect(result).toBe("error");
    });

    it("maps upload status to uploading stage", () => {
      const result = (manager as any).mapAudioStatusToStage("Uploading file", 20);
      expect(result).toBe("uploading");
    });

    it("maps complete status to ready stage", () => {
      const result = (manager as any).mapAudioStatusToStage("Complete", 100);
      expect(result).toBe("ready");
    });

    it("maps progress 100 to ready stage", () => {
      const result = (manager as any).mapAudioStatusToStage("Finalizing", 100);
      expect(result).toBe("ready");
    });

    it("maps context status to contextualizing stage", () => {
      const result = (manager as any).mapAudioStatusToStage("Adding to context", 90);
      expect(result).toBe("contextualizing");
    });

    it("maps unknown status to processing stage", () => {
      const result = (manager as any).mapAudioStatusToStage("Working", 50);
      expect(result).toBe("processing");
    });
  });

  describe("resolveAudioIcon", () => {
    it("returns x-circle for error status", () => {
      const result = (manager as any).resolveAudioIcon("Error occurred");
      expect(result).toBe("x-circle");
    });

    it("returns upload for upload status", () => {
      const result = (manager as any).resolveAudioIcon("Uploading");
      expect(result).toBe("upload");
    });

    it("returns scissors for chunk status", () => {
      const result = (manager as any).resolveAudioIcon("Chunking audio");
      expect(result).toBe("scissors");
    });

    it("returns file-audio for transcrib status", () => {
      const result = (manager as any).resolveAudioIcon("Transcribing");
      expect(result).toBe("file-audio");
    });

    it("returns cpu for process status", () => {
      const result = (manager as any).resolveAudioIcon("Processing audio");
      expect(result).toBe("cpu");
    });

    it("returns check-circle for complete status", () => {
      const result = (manager as any).resolveAudioIcon("Complete");
      expect(result).toBe("check-circle");
    });

    it("returns fallback for unknown status", () => {
      const result = (manager as any).resolveAudioIcon("Unknown", "default-icon");
      expect(result).toBe("default-icon");
    });

    it("returns file-audio as default fallback", () => {
      const result = (manager as any).resolveAudioIcon("Unknown");
      expect(result).toBe("file-audio");
    });
  });
});
