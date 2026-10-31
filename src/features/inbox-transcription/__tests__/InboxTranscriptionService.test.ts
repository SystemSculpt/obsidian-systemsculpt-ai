/** @jest-environment jsdom */
import { App, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../../../main";
import {
  BulkTranscriptionConfirmModal,
  BulkTranscriptionProgressWidget,
} from "../../../modals/BulkTranscriptionConfirmModal";
import { InboxTranscriptionService } from "../InboxTranscriptionService";

jest.mock("obsidian", () => ({ ...jest.requireActual("obsidian"), Notice: jest.fn() }));
const mockTranscribeFile = jest.fn();
jest.mock("../../../services/TranscriptionService", () => ({
  TranscriptionService: { getInstance: () => ({ transcribeFile: mockTranscribeFile }) },
}));
jest.mock("../../../modals/BulkTranscriptionConfirmModal", () => ({
  BulkTranscriptionConfirmModal: jest.fn().mockImplementation(() => ({ open: jest.fn() })),
  BulkTranscriptionProgressWidget: jest.fn().mockImplementation(() => ({
    updateStatus: jest.fn(), showCurrentBatch: jest.fn(), markBatchItemComplete: jest.fn(),
    markBatchItemError: jest.fn(), markBatchItemSkipped: jest.fn(), updateProgress: jest.fn(),
    markComplete: jest.fn(), markFailed: jest.fn(), markStopped: jest.fn(), close: jest.fn(),
  })),
}));

function audio(path = "Inbox/audio.mp3"): TFile {
  return Object.assign(new TFile({ path }), { parent: { path: path.split("/").slice(0, -1).join("/") } });
}

// Drive the same vault events and modal callbacks as Obsidian. No test reaches
// through the workflow's private queue, controller, classifier, or persistence.
describe("InboxTranscriptionService through its host interface", () => {
  let app: App;
  let plugin: ReturnType<typeof createPlugin>;
  let service: InboxTranscriptionService;
  const confirmations = jest.mocked(BulkTranscriptionConfirmModal);
  const widgets = jest.mocked(BulkTranscriptionProgressWidget);

  function createPlugin() {
    return {
      app,
      settings: { workflowEngine: {
        enabled: false, inboxRoutingEnabled: true, autoTranscribeInboxNotes: true,
        inboxFolder: "Inbox", processedNotesFolder: "", skippedFiles: {},
      } },
      getLogger: jest.fn(() => ({ info: jest.fn(), debug: jest.fn(), error: jest.fn(), warn: jest.fn() })),
      registerEvent: jest.fn(),
      addCommand: jest.fn(),
      saveSettings: jest.fn().mockResolvedValue(undefined),
    };
  }

  function emit(event: "create" | "rename", file: TFile, oldPath = "Elsewhere/audio.mp3") {
    const registration = (app.vault.on as jest.Mock).mock.calls.find(([name]) => name === event);
    expect(registration).toBeDefined();
    registration![1](file, oldPath);
  }

  async function settle() { await jest.advanceTimersByTimeAsync(0); }
  async function flushInbox() { await jest.advanceTimersByTimeAsync(800); }
  function confirmation() { return confirmations.mock.calls.at(-1)![0]; }
  function widget() { return widgets.mock.results.at(-1)!.value; }
  function stop() {
    const onStop = widgets.mock.calls.at(-1)![0].onStop;
    expect(onStop).toEqual(expect.any(Function));
    onStop?.();
  }

  async function queueBulk(count = 4) {
    const files = Array.from({ length: count }, (_, i) => audio(`Inbox/${i + 1}.mp3`));
    files.forEach(file => emit("create", file));
    await flushInbox();
    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(confirmation().pendingFiles.map(p => p.file)).toEqual(files);
    return files;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockTranscribeFile.mockReset().mockImplementation(async (
      file: TFile, _context: unknown,
      commit: (transcript: string, operationId: string) => Promise<unknown>,
    ) => commit("Transcribed text", `operation-${file.basename}`));
    app = new App();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.create as jest.Mock).mockImplementation(async (path: string) => new TFile({ path }));
    plugin = createPlugin();
    service = new InboxTranscriptionService(plugin as unknown as SystemSculptPlugin);
    service.initialize();
  });

  afterEach(() => {
    service.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("registers both vault event subscriptions without registering commands", () => {
    expect((app.vault.on as jest.Mock).mock.calls.map(([name]) => name)).toEqual(["create", "rename"]);
    expect(plugin.registerEvent).toHaveBeenCalledTimes(2);
    expect(plugin.addCommand).not.toHaveBeenCalled();
  });

  it.each(["wav", "m4a", "mp4", "mp3", "webm", "ogg", "flac"])("transcribes created .%s inbox audio after debouncing", async extension => {
    const file = audio(`Inbox/audio.${extension}`);
    emit("create", file);
    expect(mockTranscribeFile).not.toHaveBeenCalled();
    await flushInbox();
    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    expect(mockTranscribeFile).toHaveBeenCalledWith(file, expect.objectContaining({
      type: "note", callerScope: "workflow-engine/auto-transcription",
      recoveryVariant: "workflow-inbox-transcription-v2", signal: expect.any(AbortSignal),
    }), expect.any(Function));
    expect(app.vault.create).toHaveBeenCalledWith("Inbox/audio.md", expect.stringContaining("## Transcript\nTranscribed text"));
    // The new transcript note is the receipt.
    expect(Notice).not.toHaveBeenCalled();
  });

  it("deduplicates create and rename notifications for the same queued file", async () => {
    const file = audio();
    emit("create", file);
    emit("rename", file);
    await flushInbox();
    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    expect(app.vault.create).toHaveBeenCalledTimes(1);
  });

  it("transcribes files moved into a nested inbox and preserves source links", async () => {
    emit("rename", audio("Inbox/Nested/recording.mp3"));
    await flushInbox();
    expect(app.vault.create).toHaveBeenCalledWith("Inbox/Nested/recording.md", expect.stringContaining("source: [[Inbox/Nested/recording.mp3]]"));
  });

  it.each(["Inbox/audio.aac", "Inbox/note.md", "Elsewhere/audio.mp3", "Inbox-old/audio.mp3"])("ignores %s", async path => {
    emit("create", audio(path));
    await flushInbox();
    expect(mockTranscribeFile).not.toHaveBeenCalled();
    expect(confirmations).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not transcribe with the transcription switch off (engine enabled: %s)", async enabled => {
    plugin.settings.workflowEngine.enabled = enabled;
    plugin.settings.workflowEngine.autoTranscribeInboxNotes = false;
    emit("create", audio());
    await flushInbox();
    expect(mockTranscribeFile).not.toHaveBeenCalled();
  });

  it("ignores audio when no inbox is configured", async () => {
    plugin.settings.workflowEngine.inboxFolder = "";
    emit("create", audio());
    await flushInbox();
    expect(mockTranscribeFile).not.toHaveBeenCalled();
  });

  it("writes the durable operation marker and chooses a non-overwriting note path", async () => {
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValueOnce(audio("Inbox/audio.md")).mockReturnValue(null);
    emit("create", audio());
    await flushInbox();
    expect(app.vault.create).toHaveBeenCalledTimes(1);
    const [path, text] = (app.vault.create as jest.Mock).mock.calls[0];
    expect(path).toBe("Inbox/audio (1).md");
    expect(text).toContain("workflow: inbox-transcription");
    expect(text).toContain("managed_operation: operation-audio");
    expect(text).toContain("workflow_processed_note: [[Inbox/audio (1)]]");
  });

  it("reuses an existing note with the same managed operation during delivery retry", async () => {
    (app.vault.getFiles as jest.Mock).mockReturnValue([audio("Inbox/audio.md")]);
    (app.vault.read as jest.Mock).mockResolvedValue("---\nmanaged_operation: operation-audio\n---\n## Transcript\nTranscribed text\n");
    emit("create", audio());
    await flushInbox();
    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("requests confirmation before processing a bulk arrival and processes only selected files", async () => {
    const files = await queueBulk();
    expect(mockTranscribeFile).not.toHaveBeenCalled();
    confirmation().onConfirm([{ file: files[1] }, { file: files[3] }]);
    await settle();
    expect(mockTranscribeFile.mock.calls.map(([file]) => file)).toEqual([files[1], files[3]]);
    expect(widget().markComplete).toHaveBeenCalledTimes(1);
    expect(widget().updateProgress).toHaveBeenLastCalledWith(2, 0, 0);
  });

  it("processes all batches and reports completion", async () => {
    const files = await queueBulk();
    confirmation().onConfirm(files.map(file => ({ file })));
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockTranscribeFile.mock.calls.map(([file]) => file)).toEqual(files);
    expect(app.vault.create).toHaveBeenCalledTimes(4);
    expect(widget().markComplete).toHaveBeenCalledTimes(1);
    expect(widget().updateProgress).toHaveBeenLastCalledWith(4, 0, 0);
  });

  it("stops after the first failed transcription and reports all remaining files skipped", async () => {
    const files = await queueBulk();
    mockTranscribeFile.mockImplementationOnce(async () => undefined).mockRejectedValueOnce(new Error("Provider unavailable\nprivate details"));
    confirmation().onConfirm(files.map(file => ({ file })));
    await settle();
    expect(mockTranscribeFile).toHaveBeenCalledTimes(2);
    expect(widget().markBatchItemError).toHaveBeenCalledWith(files[1], "Provider unavailable\nprivate details");
    expect(widget().markFailed).toHaveBeenCalledWith({
      status: "Stopped after an error", detailLines: ["Provider unavailable", "Skipped 2 remaining files."],
      copyText: "Provider unavailable\nSkipped: 2",
    });
    expect(widget().markComplete).not.toHaveBeenCalled();
    expect(widget().updateProgress).toHaveBeenLastCalledWith(1, 1, 2);
  });

  it("user Stop aborts active work, fences a late delivery, and keeps the user outcome", async () => {
    const files = await queueBulk();
    mockTranscribeFile.mockImplementationOnce(async (_file, context, commit) => {
      stop();
      expect(context.signal.aborted).toBe(true);
      await expect(commit("late transcript", "late-operation")).rejects.toMatchObject({ name: "AbortError" });
      throw new Error("late transport error");
    });
    confirmation().onConfirm(files.map(file => ({ file })));
    await settle();
    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(widget().markStopped).toHaveBeenCalledWith({ status: "Stopped by you", detailLines: ["Skipped 4 remaining files."] });
    expect(widget().markFailed).not.toHaveBeenCalled();
  });

  it("Not now or closing uploads nothing, records no skip, and does not reopen the dialog", async () => {
    const files = await queueBulk(3);
    expect(service.canResumeDeferredFiles()).toBe(false);
    confirmation().onDefer();
    await settle();

    expect(mockTranscribeFile).not.toHaveBeenCalled();
    expect(plugin.settings.workflowEngine.skippedFiles).toEqual({});
    expect(plugin.saveSettings).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
    expect(service.canResumeDeferredFiles()).toBe(true);

    // The next arrival is handled on its own; the waiting files do not reopen the dialog.
    const next = audio("Inbox/next.mp3");
    emit("create", next);
    await flushInbox();
    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(mockTranscribeFile.mock.calls.map(([file]) => file)).toEqual([next]);
    expect(files.every((file) => !mockTranscribeFile.mock.calls.some(([sent]) => sent === file))).toBe(true);
  });

  it("Resume inbox transcription sends the waiting files once, without asking again", async () => {
    const files = await queueBulk(3);
    const vaultFiles = new Map(files.map((file) => [file.path, file]));
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => vaultFiles.get(path) ?? null);
    confirmation().onDefer();
    await settle();

    void service.resumeDeferredFiles();
    await jest.advanceTimersByTimeAsync(1000);

    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(mockTranscribeFile.mock.calls.map(([file]) => file)).toEqual(files);
    expect(app.vault.create).toHaveBeenCalledTimes(3);
    expect(widget().markComplete).toHaveBeenCalledTimes(1);
    expect(service.canResumeDeferredFiles()).toBe(false);
    void service.resumeDeferredFiles();
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockTranscribeFile).toHaveBeenCalledTimes(3);
  });

  it("drains inbox arrivals whose debounce expires during a resumed batch", async () => {
    const files = await queueBulk(3);
    const vaultFiles = new Map(files.map(file => [file.path, file]));
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => vaultFiles.get(path) ?? null);
    confirmation().onDefer();
    await settle();
    let finish!: () => void;
    mockTranscribeFile.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const resumed = service.resumeDeferredFiles();
    await settle();
    const next = audio("Inbox/during-resume.mp3");
    emit("create", next);
    await flushInbox();
    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    finish();
    await resumed;
    expect(mockTranscribeFile.mock.calls.map(([file]) => file)).toEqual([...files, next]);
    expect(confirmations).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting files untouched while another bulk confirmation is active", async () => {
    const waiting = await queueBulk(3);
    confirmation().onDefer();
    await settle();
    expect(service.canResumeDeferredFiles()).toBe(true);

    const arriving = [4, 5, 6].map((index) => audio(`Inbox/${index}.mp3`));
    const files = [...waiting, ...arriving];
    const vaultFiles = new Map(files.map((file) => [file.path, file]));
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => vaultFiles.get(path) ?? null);
    arriving.forEach((file) => emit("create", file));
    await flushInbox();
    expect(service.canResumeDeferredFiles()).toBe(false);
    await service.resumeDeferredFiles();
    expect(mockTranscribeFile).not.toHaveBeenCalled();

    confirmation().onDefer();
    await settle();
    void service.resumeDeferredFiles();
    await jest.advanceTimersByTimeAsync(1000);
    expect(mockTranscribeFile.mock.calls.map(([file]) => file)).toEqual(files);
  });

  it("cannot resume deferred work after destruction", async () => {
    await queueBulk(3);
    confirmation().onDefer();
    await settle();
    expect(service.canResumeDeferredFiles()).toBe(true);

    service.destroy();
    expect(service.canResumeDeferredFiles()).toBe(false);
    await service.resumeDeferredFiles();
    expect(mockTranscribeFile).not.toHaveBeenCalled();
  });

  it("Resume leaves waiting files alone once they are deleted, moved, or already skipped", async () => {
    plugin.settings.workflowEngine.skippedFiles = {
      "transcription::default::Inbox/3.mp3": { path: "Inbox/3.mp3", type: "transcription", skippedAt: "2026-10-01T00:00:00.000Z" },
    };
    const files = [1, 2, 3, 4].map((index) => audio(`Inbox/${index}.mp3`));
    files.forEach((file) => emit("create", file));
    await flushInbox();
    // An earlier skip keeps its file out of the batch.
    expect(confirmation().pendingFiles.map((pending) => pending.file)).toEqual([files[0], files[1], files[3]]);
    const vaultFiles = new Map([[files[0].path, files[0]], [files[3].path, files[3]]]);
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => vaultFiles.get(path) ?? null);
    confirmation().onDefer();
    await settle();
    vaultFiles.delete(files[0].path);

    void service.resumeDeferredFiles();
    await jest.advanceTimersByTimeAsync(1000);

    expect(mockTranscribeFile.mock.calls.map(([file]) => file)).toEqual([files[3]]);
    expect(Object.keys(plugin.settings.workflowEngine.skippedFiles)).toEqual(["transcription::default::Inbox/3.mp3"]);
  });

  it("destroy cancels the pending debounce and ignores later vault events", async () => {
    emit("create", audio());
    service.destroy();
    emit("rename", audio("Inbox/later.mp3"));
    await flushInbox();
    expect(mockTranscribeFile).not.toHaveBeenCalled();
    expect(confirmations).not.toHaveBeenCalled();
  });

  it("destroy aborts active bulk work, closes progress, and prevents delayed note writes", async () => {
    const files = await queueBulk(3);
    mockTranscribeFile.mockImplementationOnce(async (_file, context, commit) => {
      service.destroy();
      expect(context.signal.aborted).toBe(true);
      await expect(commit("late transcript", "late-operation")).rejects.toMatchObject({ name: "AbortError" });
      throw new DOMException("Aborted", "AbortError");
    });
    confirmation().onConfirm(files.map(file => ({ file })));
    await settle();
    expect(widget().close).toHaveBeenCalledTimes(1);
    expect(mockTranscribeFile).toHaveBeenCalledTimes(1);
    expect(app.vault.create).not.toHaveBeenCalled();
  });
});
