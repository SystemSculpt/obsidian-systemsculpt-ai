/**
 * @jest-environment jsdom
 */
import { App, TFile, normalizePath } from "obsidian";
import { WorkflowEngineService } from "../WorkflowEngineService";

// Mock the TranscriptionService
jest.mock("../../TranscriptionService", () => ({
  TranscriptionService: {
    getInstance: jest.fn().mockReturnValue({
      transcribeFile: jest.fn().mockResolvedValue("Transcribed text"),
    }),
  },
}));

// Mock BulkAutomationConfirmModal
jest.mock("../../../modals/BulkAutomationConfirmModal", () => ({
  BulkAutomationConfirmModal: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
  })),
  BulkProgressWidget: jest.fn().mockImplementation(() => ({
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

    mockApp = new App();
    (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue([]);

    mockPlugin = {
      app: mockApp,
      settings: {
        workflowEngine: {
          enabled: false,
          autoTranscribeInboxNotes: false,
          inboxFolder: "Inbox",
          templates: {},
        },
      },
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
      }),
      registerEvent: jest.fn(),
      createDirectoryOnce: jest.fn().mockResolvedValue(undefined),
      aiService: {
        streamMessage: jest.fn().mockReturnValue((async function* () {
          yield { type: "content", text: "Generated content" };
        })()),
      },
    };

    service = new WorkflowEngineService(mockPlugin);
  });

  afterEach(() => {
    service.destroy();
  });

  describe("constructor", () => {
    it("creates service with plugin reference", () => {
      expect(service).toBeDefined();
    });
  });

  describe("initialize", () => {
    it("registers vault create event", () => {
      service.initialize();

      expect(mockPlugin.registerEvent).toHaveBeenCalled();
    });

    it("registers vault rename event", () => {
      service.initialize();

      // Should register both create and rename events
      expect(mockPlugin.registerEvent).toHaveBeenCalledTimes(3);
    });

    it("registers settings update event", () => {
      service.initialize();

      expect(mockPlugin.registerEvent).toHaveBeenCalledTimes(3);
    });
  });

  describe("destroy", () => {
    it("clears pending files", () => {
      service.initialize();
      service.destroy();

      // Service should be disposed
      expect((service as any).disposed).toBe(true);
    });

    it("clears debounce timer", () => {
      service.initialize();
      (service as any).debounceTimer = setTimeout(() => {}, 1000);
      service.destroy();

      expect((service as any).debounceTimer).toBeNull();
    });
  });

  describe("getAutomationBacklog", () => {
    it("returns empty array when no templates configured", async () => {
      const backlog = await service.getAutomationBacklog();

      expect(backlog).toEqual([]);
    });

    it("returns empty array when templates is undefined", async () => {
      mockPlugin.settings.workflowEngine.templates = undefined;

      const backlog = await service.getAutomationBacklog();

      expect(backlog).toEqual([]);
    });

    it("filters out processed files", async () => {
      const mockFile = new TFile({ path: "Transcripts/file.md" });
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue([mockFile]);
      (mockApp.metadataCache.getFileCache as jest.Mock).mockReturnValue({
        frontmatter: { workflow_status: "processed" },
      });

      mockPlugin.settings.workflowEngine.templates = {
        "meeting-transcript": {
          enabled: true,
          sourceFolder: "Transcripts",
          destinationFolder: "Meetings",
        },
      };

      const backlog = await service.getAutomationBacklog();

      expect(backlog).toEqual([]);
    });

    it("includes unprocessed files in source folder", async () => {
      const mockFile = new TFile({ path: "Transcripts/file.md" });
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue([mockFile]);
      (mockApp.metadataCache.getFileCache as jest.Mock).mockReturnValue({});

      mockPlugin.settings.workflowEngine.templates = {
        "meeting-transcript": {
          enabled: true,
          sourceFolder: "Transcripts",
          destinationFolder: "Meetings",
        },
      };

      const backlog = await service.getAutomationBacklog();

      expect(backlog.length).toBe(1);
      expect(backlog[0].file).toBe(mockFile);
      expect(backlog[0].automationId).toBe("meeting-transcript");
    });

    it("excludes files not in source folder", async () => {
      const mockFile = new TFile({ path: "OtherFolder/file.md" });
      (mockApp.vault.getMarkdownFiles as jest.Mock).mockReturnValue([mockFile]);

      mockPlugin.settings.workflowEngine.templates = {
        "meeting-transcript": {
          enabled: true,
          sourceFolder: "Transcripts",
          destinationFolder: "Meetings",
        },
      };

      const backlog = await service.getAutomationBacklog();

      expect(backlog).toEqual([]);
    });
  });

  describe("runAutomationOnFile", () => {
    it("throws when automation is missing", async () => {
      const mockFile = new TFile({ path: "test.md" });

      await expect(
        service.runAutomationOnFile("non-existent", mockFile)
      ).rejects.toThrow("Automation is missing");
    });

    it("throws for non-markdown files", async () => {
      mockPlugin.settings.workflowEngine.templates = {
        "test-automation": {
          enabled: true,
          sourceFolder: "Source",
          destinationFolder: "Dest",
        },
      };

      const mockFile = new TFile({ path: "audio.mp3" });

      await expect(
        service.runAutomationOnFile("test-automation", mockFile)
      ).rejects.toThrow("markdown");
    });
  });

  describe("bulk processing flow", () => {
    it("stops after the first failure and skips remaining batches", async () => {
      const widget = {
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

      const files = [
        { file: new TFile({ path: "A.md" }), type: "automation", automationId: "auto1" },
        { file: new TFile({ path: "B.md" }), type: "automation", automationId: "auto1" },
        { file: new TFile({ path: "C.md" }), type: "automation", automationId: "auto1" },
        { file: new TFile({ path: "D.md" }), type: "automation", automationId: "auto1" },
      ];

      const spy = jest.spyOn(service as any, "processSingleFile")
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Boom"))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      await (service as any).processFilesInBatches(files, widget as any, new AbortController());

      expect(spy).toHaveBeenCalledTimes(2);
      expect(widget.markFailed).toHaveBeenCalled();
    });

    it("marks stopped when the user cancels before processing", async () => {
      const widget = {
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

      const files = [
        { file: new TFile({ path: "A.md" }), type: "automation", automationId: "auto1" },
        { file: new TFile({ path: "B.md" }), type: "automation", automationId: "auto1" },
      ];

      (service as any).requestStop({ type: "user" });

      const spy = jest.spyOn(service as any, "processSingleFile").mockResolvedValue(undefined);

      await (service as any).processFilesInBatches(files, widget as any, new AbortController());

      expect(spy).not.toHaveBeenCalled();
      expect(widget.markStopped).toHaveBeenCalled();
    });
  });

  describe("isFileInFolder (private)", () => {
    it("returns false for undefined folder", () => {
      const result = (service as any).isFileInFolder("file.md", undefined);
      expect(result).toBe(false);
    });

    it("returns true for exact match", () => {
      const result = (service as any).isFileInFolder("Folder", "Folder");
      expect(result).toBe(true);
    });

    it("returns true for file in folder", () => {
      const result = (service as any).isFileInFolder("Folder/file.md", "Folder");
      expect(result).toBe(true);
    });

    it("returns false for file in different folder", () => {
      const result = (service as any).isFileInFolder("Other/file.md", "Folder");
      expect(result).toBe(false);
    });

    it("returns false for folder with similar prefix", () => {
      const result = (service as any).isFileInFolder("FolderExtra/file.md", "Folder");
      expect(result).toBe(false);
    });
  });

  describe("createWikiLink (private)", () => {
    it("returns undefined for undefined path", () => {
      const result = (service as any).createWikiLink(undefined);
      expect(result).toBeUndefined();
    });

    it("creates wiki link from path", () => {
      const result = (service as any).createWikiLink("folder/note.md");
      expect(result).toBe("[[folder/note]]");
    });

    it("removes .md extension", () => {
      const result = (service as any).createWikiLink("note.md");
      expect(result).toBe("[[note]]");
    });

    it("handles path without extension", () => {
      const result = (service as any).createWikiLink("folder/note");
      expect(result).toBe("[[folder/note]]");
    });
  });

  describe("mergeFrontmatter (private)", () => {
    it("adds frontmatter to content without existing frontmatter", () => {
      const content = "# Note content";
      const entries = { workflow_status: "processed" };

      const result = (service as any).mergeFrontmatter(content, entries);

      expect(result).toContain("---");
      expect(result).toContain("workflow_status: processed");
      expect(result).toContain("# Note content");
    });

    it("merges with existing frontmatter", () => {
      const content = "---\ntitle: Test\n---\n# Note content";
      const entries = { workflow_status: "processed" };

      const result = (service as any).mergeFrontmatter(content, entries);

      expect(result).toContain("title: Test");
      expect(result).toContain("workflow_status: processed");
    });

    it("handles empty entries", () => {
      const content = "# Note content";
      const entries = {};

      const result = (service as any).mergeFrontmatter(content, entries);

      expect(result).toContain("---");
      expect(result).toContain("# Note content");
    });

    it("filters out null and undefined values", () => {
      const content = "# Note content";
      const entries = { valid: "value", empty: "" };

      const result = (service as any).mergeFrontmatter(content, entries);

      expect(result).toContain("valid: value");
      expect(result).not.toContain("empty:");
    });
  });

  describe("isEngineActive (private)", () => {
    it("returns true when enabled", () => {
      mockPlugin.settings.workflowEngine.enabled = true;
      const result = (service as any).isEngineActive(mockPlugin.settings.workflowEngine);
      expect(result).toBe(true);
    });

    it("returns true when autoTranscribeInboxNotes is enabled", () => {
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      const result = (service as any).isEngineActive(mockPlugin.settings.workflowEngine);
      expect(result).toBe(true);
    });

    it("returns true when any template is enabled", () => {
      mockPlugin.settings.workflowEngine.templates = {
        "test-automation": { enabled: true },
      };
      const result = (service as any).isEngineActive(mockPlugin.settings.workflowEngine);
      expect(result).toBe(true);
    });

    it("returns false when nothing is enabled", () => {
      mockPlugin.settings.workflowEngine = {
        enabled: false,
        autoTranscribeInboxNotes: false,
        templates: {},
      };
      const result = (service as any).isEngineActive(mockPlugin.settings.workflowEngine);
      expect(result).toBe(false);
    });

    it("returns false when templates are undefined", () => {
      mockPlugin.settings.workflowEngine = {
        enabled: false,
        autoTranscribeInboxNotes: false,
        templates: undefined,
      };
      const result = (service as any).isEngineActive(mockPlugin.settings.workflowEngine);
      expect(result).toBe(false);
    });
  });

  describe("classifyFile (private)", () => {
    it("returns transcription for audio files in inbox", () => {
      const mockFile = new TFile({ path: "Inbox/audio.mp3" });
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      mockPlugin.settings.workflowEngine.inboxFolder = "Inbox";

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).not.toBeNull();
      expect(result.type).toBe("transcription");
    });

    it("returns null for audio outside inbox", () => {
      const mockFile = new TFile({ path: "OtherFolder/audio.mp3" });
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      mockPlugin.settings.workflowEngine.inboxFolder = "Inbox";

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).toBeNull();
    });

    it("returns null for non-audio, non-md files", () => {
      const mockFile = new TFile({ path: "Inbox/image.png" });
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      mockPlugin.settings.workflowEngine.inboxFolder = "Inbox";

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).toBeNull();
    });

    it("returns automation for md file in source folder", () => {
      const mockFile = new TFile({ path: "Transcripts/note.md" });
      mockPlugin.settings.workflowEngine.templates = {
        "meeting-transcript": {
          enabled: true,
          sourceFolder: "Transcripts",
          destinationFolder: "Meetings",
        },
      };
      (mockApp.metadataCache.getFileCache as jest.Mock).mockReturnValue({});

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).not.toBeNull();
      expect(result.type).toBe("automation");
      expect(result.automationId).toBe("meeting-transcript");
    });

    it("returns null for processed md file", () => {
      const mockFile = new TFile({ path: "Transcripts/note.md" });
      mockPlugin.settings.workflowEngine.templates = {
        "meeting-transcript": {
          enabled: true,
          sourceFolder: "Transcripts",
          destinationFolder: "Meetings",
        },
      };
      (mockApp.metadataCache.getFileCache as jest.Mock).mockReturnValue({
        frontmatter: { workflow_status: "processed" },
      });

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).toBeNull();
    });

    it("returns null for disabled automation", () => {
      const mockFile = new TFile({ path: "Transcripts/note.md" });
      mockPlugin.settings.workflowEngine.templates = {
        "meeting-transcript": {
          enabled: false,
          sourceFolder: "Transcripts",
          destinationFolder: "Meetings",
        },
      };

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).toBeNull();
    });
  });

  describe("getAvailableNotePath (private)", () => {
    it("returns path with no suffix when available", async () => {
      (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await (service as any).getAvailableNotePath("folder", "note");

      expect(result).toBe("folder/note.md");
    });

    it("adds suffix when path exists", async () => {
      (mockApp.vault.getAbstractFileByPath as jest.Mock)
        .mockReturnValueOnce({}) // First path exists
        .mockReturnValueOnce(null); // Second path available

      const result = await (service as any).getAvailableNotePath("folder", "note");

      expect(result).toBe("folder/note (1).md");
    });

    it("handles empty folder path", async () => {
      (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await (service as any).getAvailableNotePath("", "note");

      expect(result).toBe("note.md");
    });

    it("uses default name for empty baseName", async () => {
      (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await (service as any).getAvailableNotePath("folder", "");

      expect(result).toBe("folder/transcript.md");
    });
  });

  describe("getUniqueRoutePath (private)", () => {
    it("returns path with no suffix when available", async () => {
      const mockFile = new TFile({ path: "Source/note.md" });
      (mockApp.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);

      const result = await (service as any).getUniqueRoutePath(mockFile, "Destination");

      expect(result).toBe("Destination/note.md");
    });

    it("adds suffix when path exists", async () => {
      const mockFile = new TFile({ path: "Source/note.md" });
      (mockApp.vault.getAbstractFileByPath as jest.Mock)
        .mockReturnValueOnce({}) // First path exists
        .mockReturnValueOnce(null); // Second path available

      const result = await (service as any).getUniqueRoutePath(mockFile, "Destination");

      expect(result).toBe("Destination/note (1).md");
    });
  });

  describe("buildTranscriptionNote (private)", () => {
    it("builds note with transcript and metadata", () => {
      const result = (service as any).buildTranscriptionNote(
        "Inbox/audio.mp3",
        "This is the transcript",
        "Inbox/audio.md"
      );

      expect(result).toContain("---");
      expect(result).toContain("workflow: inbox-transcription");
      expect(result).toContain("workflow_status: processed");
      expect(result).toContain("## Transcript");
      expect(result).toContain("This is the transcript");
    });

    it("creates wiki links for source and note paths", () => {
      const result = (service as any).buildTranscriptionNote(
        "Inbox/audio.mp3",
        "Transcript",
        "Inbox/audio.md"
      );

      expect(result).toContain("[[Inbox/audio.mp3]]");
      expect(result).toContain("[[Inbox/audio]]");
    });
  });

  describe("delay (private)", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("resolves after specified delay", async () => {
      const promise = (service as any).delay(100);
      jest.advanceTimersByTime(100);
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe("getWorkflowSettings (private)", () => {
    it("returns workflow engine settings", () => {
      const result = (service as any).getWorkflowSettings();
      expect(result).toBe(mockPlugin.settings.workflowEngine);
    });

    it("returns defaults when workflowEngine is undefined", () => {
      mockPlugin.settings.workflowEngine = undefined;
      const result = (service as any).getWorkflowSettings();

      expect(result).toBeDefined();
      expect(result.enabled).toBeDefined();
    });
  });

  describe("clearDebounceTimer (private)", () => {
    it("clears existing timer", () => {
      (service as any).debounceTimer = setTimeout(() => {}, 1000);
      (service as any).clearDebounceTimer();

      expect((service as any).debounceTimer).toBeNull();
    });

    it("handles null timer gracefully", () => {
      (service as any).debounceTimer = null;
      expect(() => (service as any).clearDebounceTimer()).not.toThrow();
    });
  });

  describe("handleFileEvent (private)", () => {
    beforeEach(() => {
      service.initialize();
      mockPlugin.settings.workflowEngine.enabled = true;
    });

    it("ignores non-TFile events", async () => {
      await (service as any).handleFileEvent({ path: "folder" });

      expect((service as any).pendingFiles).toHaveLength(0);
    });

    it("ignores when disposed", async () => {
      service.destroy();
      const mockFile = new TFile({ path: "Inbox/audio.mp3" });

      await (service as any).handleFileEvent(mockFile);

      expect((service as any).pendingFiles).toHaveLength(0);
    });

    it("ignores when engine is inactive", async () => {
      mockPlugin.settings.workflowEngine = {
        enabled: false,
        autoTranscribeInboxNotes: false,
        templates: {},
      };
      const mockFile = new TFile({ path: "Inbox/audio.mp3" });

      await (service as any).handleFileEvent(mockFile);

      expect((service as any).pendingFiles).toHaveLength(0);
    });

    it("ignores duplicate file events", async () => {
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      mockPlugin.settings.workflowEngine.inboxFolder = "Inbox";
      const mockFile = new TFile({ path: "Inbox/audio.mp3" });

      await (service as any).handleFileEvent(mockFile);
      await (service as any).handleFileEvent(mockFile);

      expect((service as any).pendingFiles).toHaveLength(1);
    });
  });

  describe("audio extension support", () => {
    const supportedExtensions = ["wav", "m4a", "mp3", "webm", "ogg"];

    supportedExtensions.forEach((ext) => {
      it(`recognizes .${ext} as audio`, () => {
        mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
        mockPlugin.settings.workflowEngine.inboxFolder = "Inbox";
        const mockFile = new TFile({ path: `Inbox/audio.${ext}` });

        const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

        expect(result).not.toBeNull();
        expect(result.type).toBe("transcription");
      });
    });

    it("does not recognize unsupported audio extensions", () => {
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      mockPlugin.settings.workflowEngine.inboxFolder = "Inbox";
      const mockFile = new TFile({ path: "Inbox/audio.flac" });

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).toBeNull();
    });
  });

  describe("buildSkipKey (private)", () => {
    it("builds key with automationId", () => {
      const result = (service as any).buildSkipKey("path/to/file.md", "automation", "auto-1");
      expect(result).toBe("automation::auto-1::path/to/file.md");
    });

    it("uses default when automationId is undefined", () => {
      const result = (service as any).buildSkipKey("path/to/file.md", "transcription", undefined);
      expect(result).toBe("transcription::default::path/to/file.md");
    });
  });

  describe("getSkipMap (private)", () => {
    it("returns skippedFiles from settings", () => {
      const skipMap = { "key1": { path: "test.md", type: "automation" } };
      mockPlugin.settings.workflowEngine.skippedFiles = skipMap;

      const result = (service as any).getSkipMap(mockPlugin.settings.workflowEngine);
      expect(result).toEqual(skipMap);
    });

    it("returns empty object when skippedFiles is undefined", () => {
      mockPlugin.settings.workflowEngine.skippedFiles = undefined;

      const result = (service as any).getSkipMap(mockPlugin.settings.workflowEngine);
      expect(result).toEqual({});
    });
  });

  describe("isFileSkipped (private)", () => {
    it("returns true when file is in skip map", () => {
      const mockFile = new TFile({ path: "test.md" });
      mockPlugin.settings.workflowEngine.skippedFiles = {
        "automation::auto-1::test.md": { path: "test.md", type: "automation" }
      };

      const result = (service as any).isFileSkipped(mockFile, "automation", "auto-1", mockPlugin.settings.workflowEngine);
      expect(result).toBe(true);
    });

    it("returns false when file is not in skip map", () => {
      const mockFile = new TFile({ path: "test.md" });
      mockPlugin.settings.workflowEngine.skippedFiles = {};

      const result = (service as any).isFileSkipped(mockFile, "automation", "auto-1", mockPlugin.settings.workflowEngine);
      expect(result).toBe(false);
    });

    it("returns true when md file has workflow_status: skipped in frontmatter", () => {
      const mockFile = new TFile({ path: "test.md" });
      mockPlugin.settings.workflowEngine.skippedFiles = {};
      (mockApp.metadataCache.getFileCache as jest.Mock).mockReturnValue({
        frontmatter: { workflow_status: "skipped" }
      });

      const result = (service as any).isFileSkipped(mockFile, "automation", "auto-1", mockPlugin.settings.workflowEngine);
      expect(result).toBe(true);
    });
  });

  describe("resetStopState (private)", () => {
    it("resets stop flags", () => {
      (service as any).stopRequested = true;
      (service as any).stopReason = { type: "user" };

      (service as any).resetStopState();

      expect((service as any).stopRequested).toBe(false);
      expect((service as any).stopReason).toBeNull();
    });
  });

  describe("requestStop (private)", () => {
    it("sets stop flags on first call", () => {
      (service as any).requestStop({ type: "user" });

      expect((service as any).stopRequested).toBe(true);
      expect((service as any).stopReason).toEqual({ type: "user" });
    });

    it("ignores subsequent calls", () => {
      (service as any).requestStop({ type: "user" });
      (service as any).requestStop({ type: "error", error: new Error("test") });

      expect((service as any).stopReason.type).toBe("user");
    });

    it("aborts controller when present", () => {
      const controller = new AbortController();
      const abortSpy = jest.spyOn(controller, "abort");
      (service as any).abortController = controller;

      (service as any).requestStop({ type: "user" });

      expect(abortSpy).toHaveBeenCalled();
    });
  });

  describe("isAbortError (private)", () => {
    it("returns true for DOMException AbortError", () => {
      const error = new DOMException("Aborted", "AbortError");
      expect((service as any).isAbortError(error)).toBe(true);
    });

    it("returns true for Error with AbortError name", () => {
      const error = new Error("Aborted");
      error.name = "AbortError";
      expect((service as any).isAbortError(error)).toBe(true);
    });

    it("returns true for error message containing abort", () => {
      const error = new Error("Operation was aborted");
      expect((service as any).isAbortError(error)).toBe(true);
    });

    it("returns false for null", () => {
      expect((service as any).isAbortError(null)).toBe(false);
    });

    it("returns false for regular error", () => {
      const error = new Error("Some other error");
      expect((service as any).isAbortError(error)).toBe(false);
    });
  });

  describe("buildAutomationFailureNotice (private)", () => {
    it("handles MODEL_UNAVAILABLE error", () => {
      const { SystemSculptError, ERROR_CODES } = require("../../../utils/errors");
      const error = new SystemSculptError("Model not found", ERROR_CODES.MODEL_UNAVAILABLE);

      const result = (service as any).buildAutomationFailureNotice(error);

      expect(result).toContain("model is unavailable");
    });

    it("handles INVALID_LICENSE error", () => {
      const { SystemSculptError, ERROR_CODES } = require("../../../utils/errors");
      const error = new SystemSculptError("Invalid key", ERROR_CODES.INVALID_LICENSE);

      const result = (service as any).buildAutomationFailureNotice(error);

      expect(result).toContain("invalid API key");
    });

    it("handles QUOTA_EXCEEDED error", () => {
      const { SystemSculptError, ERROR_CODES } = require("../../../utils/errors");
      const error = new SystemSculptError("Rate limited", ERROR_CODES.QUOTA_EXCEEDED);

      const result = (service as any).buildAutomationFailureNotice(error);

      expect(result).toContain("rate limit");
    });

    it("includes error message for regular Error", () => {
      const error = new Error("Something went wrong");

      const result = (service as any).buildAutomationFailureNotice(error);

      expect(result).toContain("Something went wrong");
    });

    it("returns default message for empty error", () => {
      const result = (service as any).buildAutomationFailureNotice(undefined);

      expect(result).toContain("Check the SystemSculpt console");
    });
  });

  describe("buildStopDetails (private)", () => {
    it("returns status with no skipped files", () => {
      const result = (service as any).buildStopDetails(0);

      expect(result.status).toBe("Stopped by you");
      expect(result.detailLines).toEqual([]);
    });

    it("includes skipped count in detail lines", () => {
      const result = (service as any).buildStopDetails(5);

      expect(result.detailLines).toContain("Skipped 5 remaining files.");
    });

    it("uses singular for one file", () => {
      const result = (service as any).buildStopDetails(1);

      expect(result.detailLines).toContain("Skipped 1 remaining file.");
    });
  });

  describe("buildAutomationErrorDetails (private)", () => {
    it("returns status and detail lines for basic error", () => {
      const error = new Error("Something failed");

      const result = (service as any).buildAutomationErrorDetails(error, 0);

      expect(result.status).toBe("Stopped after an error");
      expect(result.detailLines).toContain("Something failed");
    });

    it("includes skipped count", () => {
      const error = new Error("Failed");

      const result = (service as any).buildAutomationErrorDetails(error, 3);

      expect(result.detailLines).toContain("Skipped 3 remaining files.");
    });

    it("returns valid structure for SystemSculptError", () => {
      const { SystemSculptError, ERROR_CODES } = require("../../../utils/errors");
      const error = new SystemSculptError("Failed", ERROR_CODES.HTTP_ERROR, {
        provider: "openai",
        model: "gpt-4"
      });

      const result = (service as any).buildAutomationErrorDetails(error, 0);

      expect(result.status).toBe("Stopped after an error");
      expect(Array.isArray(result.detailLines)).toBe(true);
      expect(result.detailLines.length).toBeGreaterThan(0);
    });

    it("handles non-Error values", () => {
      const result = (service as any).buildAutomationErrorDetails("string error", 0);

      expect(result.status).toBe("Stopped after an error");
      expect(result.detailLines).toContain("string error");
    });
  });

  describe("persistSkippedFiles (private)", () => {
    it("returns 0 for empty files array", async () => {
      const result = await (service as any).persistSkippedFiles([], "user_skip");
      expect(result).toBe(0);
    });

    it("adds files to skip map and saves settings", async () => {
      mockPlugin.settings.workflowEngine.skippedFiles = {};
      mockPlugin.saveSettings = jest.fn().mockResolvedValue(undefined);

      const files = [
        { file: new TFile({ path: "test.md" }), type: "automation", automationId: "auto-1" }
      ];

      const result = await (service as any).persistSkippedFiles(files, "user_skip");

      expect(result).toBe(1);
      expect(mockPlugin.saveSettings).toHaveBeenCalled();
    });

    it("skips already existing entries", async () => {
      mockPlugin.settings.workflowEngine.skippedFiles = {
        "automation::auto-1::test.md": { path: "test.md", type: "automation" }
      };
      mockPlugin.saveSettings = jest.fn().mockResolvedValue(undefined);

      const files = [
        { file: new TFile({ path: "test.md" }), type: "automation", automationId: "auto-1" }
      ];

      const result = await (service as any).persistSkippedFiles(files, "user_skip");

      expect(result).toBe(0);
      expect(mockPlugin.saveSettings).not.toHaveBeenCalled();
    });
  });

  describe("classifyFile skipped files", () => {
    it("returns null for skipped transcription file", () => {
      const mockFile = new TFile({ path: "Inbox/audio.mp3" });
      mockPlugin.settings.workflowEngine.autoTranscribeInboxNotes = true;
      mockPlugin.settings.workflowEngine.inboxFolder = "Inbox";
      mockPlugin.settings.workflowEngine.skippedFiles = {
        "transcription::default::Inbox/audio.mp3": { path: "Inbox/audio.mp3", type: "transcription" }
      };

      const result = (service as any).classifyFile(mockFile, mockPlugin.settings.workflowEngine);

      expect(result).toBeNull();
    });
  });

  describe("flushPendingFiles (private)", () => {
    it("does nothing when disposed", async () => {
      service.destroy();
      (service as any).pendingFiles = [{ file: new TFile({ path: "test.md" }), type: "automation" }];

      await (service as any).flushPendingFiles();

      // Should not throw
    });

    it("does nothing when already processing bulk", async () => {
      (service as any).isProcessingBulk = true;
      (service as any).pendingFiles = [{ file: new TFile({ path: "test.md" }), type: "automation" }];

      await (service as any).flushPendingFiles();

      expect((service as any).pendingFiles).toHaveLength(1);
    });

    it("does nothing when no pending files", async () => {
      (service as any).pendingFiles = [];

      await (service as any).flushPendingFiles();
      // Should complete without error
    });
  });
});
