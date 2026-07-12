/**
 * @jest-environment jsdom
 */
import { App, TFile, Notice } from "obsidian";
import { DocumentContextManager, ChatContextManager } from "../DocumentContextManager";

const mockProcessDocument = jest.fn();
jest.mock("../DocumentProcessingService", () => ({
  DocumentProcessingService: {
    getInstance: jest.fn(() => ({
      processDocumentWithReceipt: mockProcessDocument,
    })),
  },
}));

const documentReceipt = (extractionPath: string, imagePaths: string[] = []) => ({
  extractionPath,
  imagePaths,
  operationId: "document-operation-1",
  outputIdentity: `vault:${extractionPath}`,
  markdownSha256: "b".repeat(64),
  contextEffectId: "a".repeat(64),
});

const resolveDocument = (extractionPath: string, imagePaths: string[] = []) =>
  mockProcessDocument.mockImplementationOnce(async (_file: TFile, options: any) => {
    const receipt = documentReceipt(extractionPath, imagePaths);
    await options.commitContextEffect?.(receipt, new AbortController().signal);
    return receipt;
  });

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
      loadData: jest.fn().mockResolvedValue({ settingsSentinel: true }),
      saveData: jest.fn().mockResolvedValue(undefined),
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
    mockProcessDocument.mockImplementation(async (_file: TFile, options: any) => {
      const receipt = documentReceipt("Extractions/document/document.md");
      await options.commitContextEffect?.(receipt, new AbortController().signal);
      return receipt;
    });
    mockTranscribeFile.mockResolvedValue("Transcribed text content");
    (mockApp.vault.create as jest.Mock).mockImplementation(async (path: string) => new TFile({ path }));
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

  describe("document conversion context effects", () => {
    const effect = {
      effectId: "a".repeat(64), operationId: "operation-1", outputIdentity: "output-1",
      outputPath: "Extractions/document.md", markdownSha256: "b".repeat(64),
    };
    const record = (projectionMutated: boolean, notificationAcknowledged: boolean) => ({
      operationId: effect.operationId, outputIdentity: effect.outputIdentity,
      outputPath: effect.outputPath, markdownSha256: effect.markdownSha256,
      projectionMutated, notificationAcknowledged,
    });

    it("persists identity, projection mutation, and notification acknowledgement in order", async () => {
      const order: string[] = [];
      mockPlugin.saveData.mockImplementation(async (data: any) => {
        const saved = data.managedDocumentContextEffectsV1[effect.effectId];
        order.push(saved.notificationAcknowledged ? "ack" : saved.projectionMutated ? "projection-state" : "identity");
      });
      (mockContextManager.addToContextFiles as jest.Mock).mockImplementation(() => { order.push("project"); return true; });
      (mockContextManager.triggerContextChange as jest.Mock).mockImplementation(async () => { order.push("notify"); });

      await expect(manager.applyDocumentConversionContextEffect(effect, mockContextManager)).resolves.toBe("applied");
      expect(order).toEqual(["identity", "project", "projection-state", "notify", "ack"]);
    });

    it("returns already_applied only after both durable phases and the link are present", async () => {
      mockPlugin.loadData.mockResolvedValue({ managedDocumentContextEffectsV1: { [effect.effectId]: record(true, true) } });
      (mockContextManager.hasContextFile as jest.Mock).mockReturnValue(true);
      await expect(manager.applyDocumentConversionContextEffect(effect, mockContextManager)).resolves.toBe("already_applied");
      expect(mockContextManager.addToContextFiles).not.toHaveBeenCalled();
      expect(mockContextManager.triggerContextChange).not.toHaveBeenCalled();
      expect(mockPlugin.saveData).not.toHaveBeenCalled();
    });

    it("repairs notification after the link exists but triggerContextChange was never acknowledged", async () => {
      mockPlugin.loadData.mockResolvedValue({ managedDocumentContextEffectsV1: { [effect.effectId]: record(true, false) } });
      (mockContextManager.hasContextFile as jest.Mock).mockReturnValue(true);
      await expect(manager.applyDocumentConversionContextEffect(effect, mockContextManager)).resolves.toBe("repaired");
      expect(mockContextManager.addToContextFiles).not.toHaveBeenCalled();
      expect(mockContextManager.triggerContextChange).toHaveBeenCalledTimes(1);
      expect(mockPlugin.saveData).toHaveBeenLastCalledWith(expect.objectContaining({
        managedDocumentContextEffectsV1: { [effect.effectId]: record(true, true) },
      }));
    });

    it("repairs a missing link even when earlier state claimed projection", async () => {
      mockPlugin.loadData.mockResolvedValue({ managedDocumentContextEffectsV1: { [effect.effectId]: record(true, false) } });
      await expect(manager.applyDocumentConversionContextEffect(effect, mockContextManager)).resolves.toBe("repaired");
      expect(mockContextManager.addToContextFiles).toHaveBeenCalledTimes(1);
      expect(mockContextManager.triggerContextChange).toHaveBeenCalledTimes(1);
    });

    it("replays safely after cancellation at each mutation/ack boundary", async () => {
      const boundaries = ["identity", "projection", "projection-state", "notification"] as const;
      for (const boundary of boundaries) {
        jest.clearAllMocks();
        let saved: any = { settingsSentinel: true };
        let linkPresent = false;
        const controller = new AbortController();
        mockPlugin.loadData.mockImplementation(async () => saved);
        mockPlugin.saveData.mockImplementation(async (data: any) => {
          saved = JSON.parse(JSON.stringify(data));
          const state = data.managedDocumentContextEffectsV1[effect.effectId];
          if (boundary === "identity" && !state.projectionMutated) controller.abort();
          if (boundary === "projection-state" && state.projectionMutated && !state.notificationAcknowledged) controller.abort();
        });
        (mockContextManager.hasContextFile as jest.Mock).mockImplementation(() => linkPresent);
        (mockContextManager.addToContextFiles as jest.Mock).mockImplementation(() => {
          linkPresent = true;
          if (boundary === "projection") controller.abort();
          return true;
        });
        (mockContextManager.triggerContextChange as jest.Mock).mockImplementation(async () => {
          if (boundary === "notification") controller.abort();
        });
        await expect(manager.applyDocumentConversionContextEffect({ ...effect, signal: controller.signal }, mockContextManager))
          .rejects.toMatchObject({ name: "AbortError" });

        const additionsBeforeReplay = (mockContextManager.addToContextFiles as jest.Mock).mock.calls.length;
        const notificationsBeforeReplay = (mockContextManager.triggerContextChange as jest.Mock).mock.calls.length;
        const replayContext = createMockContextManager();
        (replayContext.hasContextFile as jest.Mock).mockImplementation(() => linkPresent);
        (replayContext.addToContextFiles as jest.Mock).mockImplementation(() => { linkPresent = true; return true; });
        await expect(manager.applyDocumentConversionContextEffect(effect, replayContext)).resolves.toBe("repaired");
        expect((replayContext.addToContextFiles as jest.Mock).mock.calls.length + additionsBeforeReplay).toBe(linkPresent ? 1 : 0);
        expect(replayContext.triggerContextChange).toHaveBeenCalledTimes(boundary === "notification" ? 1 : 1);
        expect(notificationsBeforeReplay).toBe(boundary === "notification" ? 1 : 0);
      }
    });

    it("rejects effect ID reuse with different data", async () => {
      mockPlugin.loadData.mockResolvedValue({ managedDocumentContextEffectsV1: { [effect.effectId]: { ...record(true, true), outputPath: "different.md" } } });
      await expect(manager.applyDocumentConversionContextEffect(effect, mockContextManager)).rejects.toThrow("identity conflict");
      expect(mockContextManager.addToContextFiles).not.toHaveBeenCalled();
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

      it("does not save changes when saveChanges is false", async () => {
        const file = createMockFile();

        await manager.addFileToContext(file, mockContextManager, { saveChanges: false });

        expect(mockContextManager.triggerContextChange).not.toHaveBeenCalled();
      });
    });

    describe("document files", () => {
      it("processes PDF and adds extracted content to context", async () => {
        const file = createMockFile({ path: "test/doc.pdf", extension: "pdf", basename: "doc" });
        resolveDocument("Extractions/doc/doc.md");
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

      it("rejects unsupported Office files without managed processing or context routing", async () => {
        const file = createMockFile({ path: "test/doc.docx", extension: "docx", basename: "doc" });

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(false);
        expect(mockProcessDocument).not.toHaveBeenCalled();
        expect(mockContextManager.addToContextFiles).not.toHaveBeenCalled();
      });

      it("keeps images local when adding them to context", async () => {
        const file = createMockFile({ path: "images/diagram.png", extension: "png", basename: "diagram" });

        const result = await manager.addFileToContext(file, mockContextManager);

        expect(result).toBe(true);
        expect(mockProcessDocument).not.toHaveBeenCalled();
        expect(mockContextManager.addToContextFiles).toHaveBeenCalledWith("[[images/diagram.png]]");
      });

      it("handles document processing error", async () => {
        const file = createMockFile({ path: "test/doc.pdf", extension: "pdf" });
        mockProcessDocument.mockRejectedValueOnce(new Error("Processing failed"));

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
        resolveDocument("Extractions/doc/doc.md", ["Extractions/doc/images-123/image1.png"]);

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
