/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { WorkflowEngineService } from "../WorkflowEngineService";

const mockTranscribeFile = jest.fn();
jest.mock("../../TranscriptionService", () => ({
  TranscriptionService: {
    getInstance: jest.fn(() => ({
      transcribeFile: mockTranscribeFile,
    })),
  },
}));

jest.mock("../../../modals/BulkTranscriptionConfirmModal", () => ({
  BulkTranscriptionConfirmModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
  BulkTranscriptionProgressWidget: jest.fn().mockImplementation(() => ({
    updateStatus: jest.fn(),
    showCurrentBatch: jest.fn(),
    markBatchItemComplete: jest.fn(),
    markBatchItemError: jest.fn(),
    markBatchItemSkipped: jest.fn(),
    updateProgress: jest.fn(),
    markComplete: jest.fn(),
    markFailed: jest.fn(),
    markStopped: jest.fn(),
    close: jest.fn(),
  })),
}));

describe("WorkflowEngineService", () => {
  let mockApp: App;
  let mockPlugin: any;
  let service: WorkflowEngineService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTranscribeFile.mockReset().mockImplementation(async (
      _file: TFile,
      _context: unknown,
      commit: (transcript: string, operationId: string) => Promise<void>,
    ) => commit("Transcribed text", "workflow-transcription-op-1"));

    mockApp = new App();
    (mockApp.vault.getFiles as jest.Mock).mockReturnValue([]);
    (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

    mockPlugin = {
      app: mockApp,
      settings: {
        workflowEngine: {
          enabled: false,
          inboxRoutingEnabled: true,
          autoTranscribeInboxNotes: false,
          inboxFolder: "Inbox",
          processedNotesFolder: "",
          skippedFiles: {},
        },
      },
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      }),
      registerEvent: jest.fn(),
      saveSettings: jest.fn().mockResolvedValue(undefined),
    };

    service = new WorkflowEngineService(mockPlugin);
  });

  afterEach(() => {
    service.destroy();
  });

  describe("lifecycle", () => {
    it("registers create and rename listeners", () => {
      service.initialize();

      expect(mockPlugin.registerEvent).toHaveBeenCalledTimes(2);
    });

    it("clears pending work, timers, and progress on destroy", () => {
      const close = jest.fn();
      (service as any).pendingFiles = [{ file: new TFile({ path: "Inbox/audio.mp3" }) }];
      (service as any).debounceTimer = window.setTimeout(() => {}, 1000);
      (service as any).progressWidget = { close, updateStatus: jest.fn() };

      service.destroy();

      expect((service as any).disposed).toBe(true);
      expect((service as any).pendingFiles).toEqual([]);
      expect((service as any).debounceTimer).toBeNull();
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe("inbox transcription commit", () => {
    it("persists exactly one workflow note inside the managed local-commit callback", async () => {
      const file = new TFile({ path: "Inbox/audio.mp3" });
      (file as any).parent = { path: "Inbox" };
      (mockApp.vault.create as jest.Mock).mockImplementation(
        async (path: string) => new TFile({ path }),
      );

      await (service as any).processTranscription(file, undefined, false);

      expect(mockTranscribeFile).toHaveBeenCalledWith(
        file,
        expect.objectContaining({
          type: "note",
          callerScope: "workflow-engine/auto-transcription",
          recoveryVariant: "workflow-inbox-transcription-v2",
          signal: undefined,
        }),
        expect.any(Function),
      );
      expect(mockApp.vault.create).toHaveBeenCalledTimes(1);
      expect(mockApp.vault.create).toHaveBeenCalledWith(
        "Inbox/audio.md",
        expect.stringContaining("## Transcript\nTranscribed text"),
      );
    });

    it("fences the workflow write when cancellation wins before local commit", async () => {
      const file = new TFile({ path: "Inbox/audio.mp3" });
      const controller = new AbortController();
      mockTranscribeFile.mockImplementationOnce(async (
        _file: TFile,
        context: { signal?: AbortSignal },
        commit: (transcript: string, operationId: string) => Promise<void>,
      ) => {
        expect(context.signal).toBe(controller.signal);
        controller.abort();
        await commit("late transcript", "workflow-transcription-op-2");
      });

      await expect((service as any).processTranscription(
        file,
        controller.signal,
        false,
      )).rejects.toMatchObject({ name: "AbortError" });

      expect(mockApp.vault.create).not.toHaveBeenCalled();
    });

    it("reuses an existing workflow transcription note during local-commit retry", async () => {
      const file = new TFile({ path: "Inbox/audio.mp3" });
      (file as any).parent = { path: "Inbox" };
      const existing = new TFile({ path: "Inbox/audio.md" });
      (existing as any).parent = { path: "Inbox" };
      (mockApp.vault.getFiles as jest.Mock).mockReturnValue([existing]);
      (mockApp.vault.read as jest.Mock).mockResolvedValue(
        "---\nworkflow: inbox-transcription\nmanaged_operation: workflow-transcription-op-1\n---\n\n## Transcript\nTranscribed text\n",
      );

      await (service as any).processTranscription(file, undefined, false);

      expect(mockApp.vault.create).not.toHaveBeenCalled();
    });
  });

  describe("classification", () => {
    const supportedExtensions = ["wav", "m4a", "mp4", "mp3", "webm", "ogg", "flac"];

    it.each(supportedExtensions)("recognizes .%s inbox audio", (extension) => {
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      const file = new TFile({ path: `Inbox/audio.${extension}` });

      expect((service as any).classifyFile(file, mockPlugin.settings.workflowEngine)).toEqual({ file });
    });

    it("ignores unsupported files and audio outside the inbox", () => {
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;

      expect((service as any).classifyFile(
        new TFile({ path: "Inbox/audio.aac" }),
        mockPlugin.settings.workflowEngine,
      )).toBeNull();
      expect((service as any).classifyFile(
        new TFile({ path: "Elsewhere/audio.mp3" }),
        mockPlugin.settings.workflowEngine,
      )).toBeNull();
      expect((service as any).classifyFile(
        new TFile({ path: "Inbox/note.md" }),
        mockPlugin.settings.workflowEngine,
      )).toBeNull();
    });

    it("does not classify a skipped transcription", () => {
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      mockPlugin.settings.workflowEngine.skippedFiles = {
        "transcription::default::Inbox/audio.mp3": {
          path: "Inbox/audio.mp3",
          type: "transcription",
          skippedAt: "2026-07-18T00:00:00.000Z",
        },
      };

      const result = (service as any).classifyFile(
        new TFile({ path: "Inbox/audio.mp3" }),
        mockPlugin.settings.workflowEngine,
      );

      expect(result).toBeNull();
    });
  });

  describe("event queue", () => {
    it("queues a supported file only once", async () => {
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      const file = new TFile({ path: "Inbox/audio.mp3" });

      await (service as any).handleFileEvent(file);
      await (service as any).handleFileEvent(file);

      expect((service as any).pendingFiles).toEqual([{ file }]);
    });

    it("does not queue files when inbox transcription is inactive", async () => {
      await (service as any).handleFileEvent(new TFile({ path: "Inbox/audio.mp3" }));

      expect((service as any).pendingFiles).toEqual([]);
    });
  });

  describe("bulk processing", () => {
    function createWidget() {
      return {
        updateStatus: jest.fn(),
        showCurrentBatch: jest.fn(),
        markBatchItemComplete: jest.fn(),
        markBatchItemError: jest.fn(),
        markBatchItemSkipped: jest.fn(),
        updateProgress: jest.fn(),
        markComplete: jest.fn(),
        markFailed: jest.fn(),
        markStopped: jest.fn(),
      };
    }

    it("stops after the first failure and skips remaining audio", async () => {
      const widget = createWidget();
      const files = ["A", "B", "C", "D"].map((name) => ({
        file: new TFile({ path: `Inbox/${name}.mp3` }),
      }));
      const spy = jest.spyOn(service as any, "processSingleFile")
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Boom"));

      await (service as any).processFilesInBatches(files, widget, new AbortController());

      expect(spy).toHaveBeenCalledTimes(2);
      expect(widget.markFailed).toHaveBeenCalledWith(expect.objectContaining({
        status: "Stopped after an error",
      }));
      expect(widget.markBatchItemSkipped).toHaveBeenCalled();
    });

    it("marks the batch stopped when the user cancels before processing", async () => {
      const widget = createWidget();
      const files = [
        { file: new TFile({ path: "Inbox/A.mp3" }) },
        { file: new TFile({ path: "Inbox/B.mp3" }) },
      ];
      (service as any).requestStop({ type: "user" });
      const spy = jest.spyOn(service as any, "processSingleFile").mockResolvedValue(undefined);

      await (service as any).processFilesInBatches(files, widget, new AbortController());

      expect(spy).not.toHaveBeenCalled();
      expect(widget.markStopped).toHaveBeenCalled();
    });
  });

  describe("skip persistence", () => {
    it("uses the stable transcription skip key", () => {
      expect((service as any).buildSkipKey("Inbox/audio.mp3"))
        .toBe("transcription::default::Inbox/audio.mp3");
    });

    it("persists skipped audio without automation metadata", async () => {
      const file = new TFile({ path: "Inbox/audio.mp3" });

      await expect((service as any).persistSkippedFiles([{ file }], "user_skip"))
        .resolves.toBe(1);

      expect(mockPlugin.settings.workflowEngine.skippedFiles).toEqual({
        "transcription::default::Inbox/audio.mp3": expect.objectContaining({
          path: "Inbox/audio.mp3",
          type: "transcription",
          reason: "user_skip",
        }),
      });
      expect(mockPlugin.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("does not write an existing skip twice", async () => {
      const file = new TFile({ path: "Inbox/audio.mp3" });
      mockPlugin.settings.workflowEngine.skippedFiles = {
        "transcription::default::Inbox/audio.mp3": {
          path: file.path,
          type: "transcription",
          skippedAt: "2026-07-18T00:00:00.000Z",
        },
      };

      await expect((service as any).persistSkippedFiles([{ file }], "user_skip"))
        .resolves.toBe(0);
      expect(mockPlugin.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe("workflow helpers", () => {
    it("only reports the engine active for its core switches", () => {
      expect((service as any).isEngineActive(mockPlugin.settings.workflowEngine)).toBe(false);

      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      expect((service as any).isEngineActive(mockPlugin.settings.workflowEngine)).toBe(true);

      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = false;
      mockPlugin.settings.workflowEngine.enabled = true;
      expect((service as any).isEngineActive(mockPlugin.settings.workflowEngine)).toBe(true);
    });

    it("matches only exact folders and their descendants", () => {
      expect((service as any).isFileInFolder("Inbox", "Inbox")).toBe(true);
      expect((service as any).isFileInFolder("Inbox/audio.mp3", "Inbox")).toBe(true);
      expect((service as any).isFileInFolder("Inbox-old/audio.mp3", "Inbox")).toBe(false);
      expect((service as any).isFileInFolder("Inbox/audio.mp3", undefined)).toBe(false);
    });

    it("finds an available note path", async () => {
      (mockApp.vault.getAbstractFileByPath as jest.Mock)
        .mockReturnValueOnce(new TFile({ path: "Inbox/audio.md" }))
        .mockReturnValueOnce(null);

      await expect((service as any).getAvailableNotePath("Inbox", "audio"))
        .resolves.toBe("Inbox/audio (1).md");
    });

    it("builds a durable transcription note without automation configuration", () => {
      const note = (service as any).buildTranscriptionNote(
        "Inbox/audio.mp3",
        "Hello world",
        "Inbox/audio.md",
        "workflow-transcription-op-1",
      );

      expect(note).toContain("workflow: inbox-transcription");
      expect(note).toContain("managed_operation: workflow-transcription-op-1");
      expect(note).toContain("source: [[Inbox/audio.mp3]]");
      expect(note).toContain("## Transcript\nHello world");
    });

    it("creates wiki links for note and non-note paths", () => {
      expect((service as any).createWikiLink("folder/note.md")).toBe("[[folder/note]]");
      expect((service as any).createWikiLink("folder/audio.mp3")).toBe("[[folder/audio.mp3]]");
      expect((service as any).createWikiLink(undefined)).toBeUndefined();
    });
  });

  describe("stop and error state", () => {
    it("aborts the active controller and preserves the first stop reason", () => {
      const controller = new AbortController();
      (service as any).abortController = controller;

      (service as any).requestStop({ type: "user" });
      (service as any).requestStop({ type: "error", error: new Error("late") });

      expect(controller.signal.aborted).toBe(true);
      expect((service as any).stopReason).toEqual({ type: "user" });
    });

    it("builds bounded batch failure details", () => {
      const result = (service as any).buildBatchErrorDetails(new Error("Provider unavailable"), 2);

      expect(result).toEqual({
        status: "Stopped after an error",
        detailLines: ["Provider unavailable", "Skipped 2 remaining files."],
        copyText: "Provider unavailable\nSkipped: 2",
      });
    });

    it("recognizes DOM and conventional abort failures", () => {
      expect((service as any).isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
      const error = new Error("cancelled");
      error.name = "AbortError";
      expect((service as any).isAbortError(error)).toBe(true);
      expect((service as any).isAbortError(new Error("other"))).toBe(false);
    });
  });
});
