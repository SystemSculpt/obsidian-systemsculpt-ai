/** @jest-environment jsdom */
import { App, Platform, TFile } from "obsidian";
import {
  ManagedTranscriptionRetryError,
  TranscriptionResumeRequiredError,
  type ManagedTranscriptionAdapter,
  type ManagedTranscriptionContext,
  type ManagedTranscriptionResult,
} from "../ManagedTranscriptionAdapter";
import { TranscriptionCoordinator } from "../TranscriptionCoordinator";
import { createLocalCommitReceipt, LocalCommitReceiptMismatchError } from "../LocalCommitReceipt";
import { createVaultFileSource } from "../../../platform/fileSource";
import type { ManagedFileSource } from "../../managed/ManagedFileSource";

jest.mock("../../../platform/fileSource", () => ({ createVaultFileSource: jest.fn() }));

const mockClipboardWrite = jest.fn(async () => undefined);
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: mockClipboardWrite },
});

const mockProcessTranscription = jest.fn(async (text: string) => ({ text: `processed:${text}` }));
jest.mock("../../PostProcessingService", () => ({
  PostProcessingService: {
    getInstance: jest.fn(() => ({ processTranscription: mockProcessTranscription })),
  },
}));

interface HarnessOverrides {
  autoPaste?: boolean;
  clean?: boolean;
  keep?: boolean;
  postProcess?: boolean;
}

function requiredOperationId(context: ManagedTranscriptionContext | undefined): string {
  if (!context?.operationId) throw new Error("Expected the coordinator to own an operation ID.");
  return context.operationId;
}

async function readAndReleaseSource(source: ManagedFileSource): Promise<void> {
  try {
    await source.fingerprint();
    const loaded = await source.load();
    await loaded.readSlice(0, Math.min(loaded.sizeBytes, 1024 * 1024));
  } finally {
    source.release?.();
  }
}

function harness(overrides: HarnessOverrides = {}) {
  const app = new App();
  const file = new TFile({
    path: "Recordings/demo.webm",
    name: "demo.webm",
    stat: { size: 4 },
  });
  const events: string[] = [];

  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
    (path: string) => path === file.path ? file : null,
  );
  (app.vault.getFiles as jest.Mock).mockReturnValue([]);
  (app.vault as unknown as { readBinary: jest.Mock }).readBinary = jest.fn(async () => {
    throw new Error("Whole-file audio reads are forbidden.");
  });
  const readSlice = jest.fn(async (start: number, end: number) => {
    if (start < 0 || end > file.stat.size || end < start || end - start > 1024 * 1024) {
      throw new Error("Expected a bounded audio slice.");
    }
    return Uint8Array.from({ length: end - start }, (_, index) => (start + index + 1) % 256).buffer;
  });
  const release = jest.fn();
  jest.mocked(createVaultFileSource).mockImplementation((_app, selected) => {
    let released = false;
    return {
      sizeBytes: selected.stat.size,
      readSlice: async (start, end) => {
        if (released) throw new Error("The vault file source was released.");
        return readSlice(start, end);
      },
      release: () => { released = true; release(); },
    };
  });
  (app.vault.create as jest.Mock).mockImplementation(async (path: string) => {
    events.push(`write:${path}`);
    return new TFile({ path, name: path.split("/").pop() });
  });
  (app.vault.modify as jest.Mock).mockImplementation(async () => undefined);
  (app.fileManager as unknown as { trashFile: jest.Mock }).trashFile = jest.fn(async () => {
    events.push("delete-source");
  });

  const adapter = {
    transcribe: jest.fn<ReturnType<ManagedTranscriptionAdapter["transcribe"]>, Parameters<ManagedTranscriptionAdapter["transcribe"]>>(async (source) => {
      events.push("remote");
      await readAndReleaseSource(source);
      return { kind: "transcript", operationId: "transcription-op-1", text: "managed transcript" };
    }),
    resume: jest.fn<ReturnType<ManagedTranscriptionAdapter["resume"]>, Parameters<ManagedTranscriptionAdapter["resume"]>>(async (operationId, source) => {
      await readAndReleaseSource(source);
      return { kind: "transcript", operationId, text: "managed transcript" };
    }),
    hasRecoveryOperation: jest.fn(async () => true),
    beginLocalCommit: jest.fn(async () => { events.push("commit:begin"); }),
    recordLocalCommitReceipt: jest.fn(async () => { events.push("commit:receipt"); }),
    completeLocalCommit: jest.fn(async () => { events.push("commit:complete"); }),
    acknowledgeCompleted: jest.fn(async () => undefined),
  };
  const plugin = {
    app,
    settings: {
      postProcessingEnabled: overrides.postProcess ?? false,
      autoPasteTranscription: overrides.autoPaste ?? false,
      keepRecordingsAfterTranscription: overrides.keep ?? true,
      cleanTranscriptionOutput: overrides.clean ?? true,
    },
  } as any;
  const coordinator = new TranscriptionCoordinator(app, plugin, adapter as any);
  return { adapter, app, coordinator, events, file, readSlice, release };
}

describe("TranscriptionCoordinator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(Platform, { isDesktopApp: true, isMobileApp: false });
    mockProcessTranscription.mockImplementation(async (text: string) => ({ text: `processed:${text}` }));
  });

  it("commits one Markdown output before optionally deleting the recoverable source", async () => {
    const { adapter, coordinator, events } = harness({ keep: false });

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "recorder-capture",
    });

    expect(events).toEqual([
      "remote",
      "commit:begin",
      "commit:receipt",
      "write:Recordings/demo.md",
      "commit:complete",
      "delete-source",
    ]);
    expect(result).toMatchObject({
      operationId: "transcription-op-1",
      outputPath: "Recordings/demo.md",
      sourceDisposition: "trashed",
    });
    expect(adapter.completeLocalCommit).toHaveBeenCalledWith("transcription-op-1");
    expect((coordinator as any).plugin.settings.cleanTranscriptionOutput).toBe(true);
  });

  it("never applies recorder cleanup to an existing user-selected vault file", async () => {
    const { app, coordinator } = harness({ keep: false });

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "user-file",
    });

    expect(result.sourceDisposition).toBe("kept");
    expect(app.fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("writes clean Markdown as the exact processed text without recovery metadata", async () => {
    const { app, coordinator } = harness({ clean: true, postProcess: true });

    await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
    });

    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo.md",
      "processed:managed transcript",
    );
    expect(app.vault.create).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("systemsculpt-transcription"),
    );
  });

  it("durably saves a raw cleanup fallback before deleting recorder-owned audio", async () => {
    const { app, coordinator, events } = harness({ clean: true, keep: false, postProcess: true });
    mockProcessTranscription.mockResolvedValueOnce({
      text: "managed transcript",
      warning: "Transcript cleanup was incomplete, so the raw transcript was saved instead.",
    } as any);

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "chat",
      sourceOwnership: "recorder-capture",
    });

    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo.md",
      "managed transcript",
    );
    expect(events).toEqual([
      "remote",
      "commit:begin",
      "commit:receipt",
      "write:Recordings/demo.md",
      "commit:complete",
      "delete-source",
    ]);
    expect(result).toMatchObject({
      text: "managed transcript",
      sourceDisposition: "trashed",
      warning: "Transcript cleanup was incomplete, so the raw transcript was saved instead.",
    });
  });

  it("writes one honest transcript section when rich-output cleanup falls back", async () => {
    const { app, coordinator } = harness({ clean: false, postProcess: true });
    mockProcessTranscription.mockResolvedValueOnce({
      text: "managed transcript",
      warning: "Transcript cleanup was incomplete, so the raw transcript was saved instead.",
    } as any);

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "user-file",
    });

    const written = (app.vault.create as jest.Mock).mock.calls[0]?.[1] as string;
    expect(written).toContain("## Transcript\nmanaged transcript");
    expect(written).not.toContain("## Raw transcript");
    expect(written).not.toContain("## Cleaned transcript");
    expect(result.warning).toBe(
      "Transcript cleanup was incomplete, so the raw transcript was saved instead.",
    );
  });

  it("preserves the source and pending recovery when the local output write fails", async () => {
    const { adapter, app, coordinator } = harness({ keep: false });
    (app.vault.create as jest.Mock).mockRejectedValue(new Error("disk full"));

    const failure = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TranscriptionResumeRequiredError);
    expect(failure).toMatchObject({
      operationId: "transcription-op-1",
      retryDisposition: "resume",
      message: "disk full",
    });
    expect(adapter.beginLocalCommit).toHaveBeenCalledTimes(1);
    expect(adapter.completeLocalCommit).not.toHaveBeenCalled();
    expect(app.fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("writes timestamped results as SRT without post-processing or note insertion", async () => {
    const { app, coordinator } = harness({ autoPaste: true, postProcess: true });
    const targetEditor = { replaceSelection: jest.fn() } as any;

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      targetEditor,
      timestamped: true,
    });

    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo.srt",
      "managed transcript",
    );
    expect(mockProcessTranscription).not.toHaveBeenCalled();
    expect(targetEditor.replaceSelection).not.toHaveBeenCalled();
    expect(result.insertedIntoOrigin).toBe(false);
  });

  it("fences every local write after explicit abort", async () => {
    const { adapter, app, coordinator } = harness();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    adapter.transcribe.mockImplementation(async (source: any) => {
      await source.load();
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return { kind: "transcript", operationId: "transcription-op-1", text: "late transcript" };
    });
    const running = coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
    });
    await waiting;

    coordinator.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.fileManager.trashFile).not.toHaveBeenCalled();
  });

  it("owns an operation ID before remote dispatch settles", async () => {
    const { adapter, coordinator, file } = harness();
    let acceptedOperationId = "";
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    adapter.transcribe.mockImplementation(async (source: any, context: any) => {
      await source.load();
      acceptedOperationId = context.operationId;
      entered();
      await delayed;
      return { kind: "transcript", operationId: context.operationId, text: "managed transcript" };
    });
    const running = coordinator.transcribeFile(
      file,
      { type: "note" },
      async (text) => text,
    );
    await waiting;

    expect(acceptedOperationId).toMatch(/^transcription-/);
    expect(coordinator.getActiveOperationId()).toBe(acceptedOperationId);
    coordinator.abort();
    release();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("wraps caller-owned durable output in the managed local-commit boundary", async () => {
    const { adapter, coordinator, events, file } = harness();
    const commit = jest.fn(async (text: string) => {
      events.push("caller:commit");
      expect(text).toBe("managed transcript");
      return "Extractions/audio/transcript.md";
    });

    await expect(coordinator.transcribeFile(file, { type: "note" }, commit))
      .resolves.toBe("Extractions/audio/transcript.md");

    expect(events).toEqual([
      "remote",
      "commit:begin",
      "caller:commit",
      "commit:complete",
    ]);
    expect(adapter.completeLocalCommit).toHaveBeenCalledWith("transcription-op-1");
    expect(adapter.acknowledgeCompleted).toHaveBeenCalledWith("transcription-op-1");
  });

  it("keeps local commit pending when a caller-owned durable write fails", async () => {
    const { adapter, coordinator, file } = harness();

    await expect(coordinator.transcribeFile(
      file,
      { type: "note" },
      async () => { throw new Error("context write failed"); },
    )).rejects.toThrow("context write failed");

    expect(adapter.beginLocalCommit).toHaveBeenCalledTimes(1);
    expect(adapter.completeLocalCommit).not.toHaveBeenCalled();
  });

  it("caches the exact source fingerprint and verifies upload slices without whole-file reads", async () => {
    const { adapter, app, coordinator, file, readSlice } = harness();
    adapter.transcribe.mockImplementation(async (source: ManagedFileSource) => {
      const fingerprints = await Promise.all([source.fingerprint(), source.fingerprint()]);
      expect(fingerprints).toEqual([
        "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      ]);
      expect(readSlice.mock.calls).toEqual([[0, 4]]);
      const loaded = await source.load();
      expect(loaded).toMatchObject({ filename: file.name, contentType: "audio/webm", sizeBytes: 4 });
      expect(loaded).not.toHaveProperty("bytes");
      expect(new Uint8Array(await loaded.readSlice(1, 3))).toEqual(new Uint8Array([2, 3]));
      return { kind: "transcript", operationId: "transcription-op-1", text: "managed transcript" };
    });

    await coordinator.transcribeFile(file, { type: "note" }, async (text) => text);

    expect(createVaultFileSource).toHaveBeenCalledTimes(1);
    expect(createVaultFileSource).toHaveBeenCalledWith(app, file);
    expect(readSlice.mock.calls).toEqual([[0, 4], [0, 4]]);
    expect(app.vault.readBinary).not.toHaveBeenCalled();
  });

  it("inserts only the processed body into the editor captured by the initiating surface", async () => {
    const { app, coordinator } = harness({
      autoPaste: true,
      clean: false,
      postProcess: true,
    });
    const originEditor = { replaceSelection: jest.fn() } as any;
    const laterEditor = { replaceSelection: jest.fn() } as any;
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue({ editor: laterEditor });

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      targetEditor: originEditor,
      validateInsertionTarget: () => true,
    });

    expect(originEditor.replaceSelection).toHaveBeenCalledWith("processed:managed transcript");
    expect(laterEditor.replaceSelection).not.toHaveBeenCalled();
    expect(mockClipboardWrite).not.toHaveBeenCalled();
    expect(result.insertedIntoOrigin).toBe(true);
    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo.md",
      expect.stringContaining("## Raw transcript\nmanaged transcript"),
    );
    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo.md",
      expect.stringContaining("## Cleaned transcript\nprocessed:managed transcript"),
    );
  });

  it("saves with a truthful warning instead of inserting after the origin note changes", async () => {
    const { coordinator } = harness({ autoPaste: true });
    const originEditor = { replaceSelection: jest.fn() } as any;

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      targetEditor: originEditor,
      validateInsertionTarget: () => false,
    });

    expect(originEditor.replaceSelection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outputPath: "Recordings/demo.md",
      insertedIntoOrigin: false,
      warning: expect.stringContaining("note where transcription started changed or closed"),
    });
  });

  it.each([
    [0, "empty"],
    [500 * 1024 * 1024 + 1, "too large"],
  ])("rejects %s-byte audio before opening its source", async (size, message) => {
    const { adapter, app, coordinator, file } = harness();
    file.stat.size = size;

    await expect(coordinator.start({
      filePath: file.path,
      destination: "note",
    })).rejects.toThrow(message);

    expect(createVaultFileSource).not.toHaveBeenCalled();
    expect(app.vault.readBinary).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(adapter.beginLocalCommit).not.toHaveBeenCalled();
  });

  it("rejects audio above 500 MiB on mobile before opening its source", async () => {
    Object.assign(Platform, { isDesktopApp: false, isMobileApp: true });
    const { adapter, app, coordinator, file } = harness();
    file.stat.size = 500 * 1024 * 1024 + 1;

    await expect(coordinator.start({
      filePath: file.path,
      destination: "note",
    })).rejects.toThrow("500.0 MiB");

    expect(createVaultFileSource).not.toHaveBeenCalled();
    expect(app.vault.readBinary).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it.each(["desktop", "mobile"])("admits the 500 MiB boundary on %s without a whole-file allocation", async (host) => {
    Object.assign(Platform, { isDesktopApp: host === "desktop", isMobileApp: host === "mobile" });
    const { adapter, app, coordinator, file, readSlice } = harness();
    file.stat.size = 500 * 1024 * 1024;
    adapter.transcribe.mockImplementationOnce(async (source: ManagedFileSource) => {
      const loaded = await source.load();
      expect(loaded.sizeBytes).toBe(file.stat.size);
      expect(loaded).not.toHaveProperty("bytes");
      // Admission and source construction do not eagerly hash or read the file.
      expect(readSlice).not.toHaveBeenCalled();
      return { kind: "transcript", operationId: "transcription-op-1", text: "managed transcript" };
    });

    await expect(coordinator.start({ filePath: file.path, destination: "note" }))
      .resolves.toMatchObject({ operationId: "transcription-op-1" });

    expect(adapter.transcribe).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      maxAudioBytes: 500 * 1024 * 1024,
    }));
    expect(createVaultFileSource).toHaveBeenCalledWith(app, file);
    expect(app.vault.readBinary).not.toHaveBeenCalled();
  });

  it("returns a durable success with a warning when source cleanup fails", async () => {
    const { adapter, app, coordinator } = harness({ keep: false });
    (app.fileManager.trashFile as jest.Mock).mockRejectedValue(new Error("sync adapter busy"));

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "recorder-capture",
    });

    expect(result).toMatchObject({
      sourceDisposition: "cleanup-failed",
      warning: expect.stringContaining("source audio could not be moved to trash"),
    });
    expect(adapter.completeLocalCommit).toHaveBeenCalledTimes(1);
  });

  it("does not write output when abort wins a delayed commit transition", async () => {
    const { adapter, app, coordinator } = harness();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    adapter.beginLocalCommit.mockImplementation(async () => {
      entered();
      await delayed;
    });
    const running = coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
    });
    await waiting;

    coordinator.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(adapter.completeLocalCommit).not.toHaveBeenCalled();
  });

  it("allocates a new Markdown path instead of modifying an unrelated transcript", async () => {
    const { app, coordinator, file } = harness();
    const existing = new TFile({ path: "Recordings/demo.md" });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue("unrelated notes");
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (path === file.path) return file;
      if (path === existing.path) return existing;
      return null;
    });

    const result = await coordinator.start({
      filePath: file.path,
      destination: "note",
    });

    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo (2).md",
      expect.stringContaining("managed transcript"),
    );
    expect(result.outputPath).toBe("Recordings/demo (2).md");
  });

  it.each([false, true])("allocates a collision suffix for a fresh identical-text output (SRT: %s)", async (timestamped) => {
    const { app, coordinator, file } = harness({ clean: true });
    const extension = timestamped ? "srt" : "md";
    const existing = new TFile({ path: `Recordings/demo.${extension}` });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue("managed transcript");
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (path === file.path) return file;
      return path === existing.path ? existing : null;
    });

    const result = await coordinator.start({ filePath: file.path, destination: "note", timestamped });

    expect(result.outputPath).toBe(`Recordings/demo (2).${extension}`);
    expect(app.vault.create).toHaveBeenCalledWith(result.outputPath, "managed transcript");
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not adopt an identical numbered output when the base path is free (SRT: %s)", async (timestamped) => {
    const { app, coordinator, file } = harness({ clean: true });
    const extension = timestamped ? "srt" : "md";
    const existing = new TFile({ path: `Recordings/demo (2).${extension}` });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue("managed transcript");

    const result = await coordinator.start({ filePath: file.path, destination: "note", timestamped });

    expect(result.outputPath).toBe(`Recordings/demo.${extension}`);
    expect(app.vault.create).toHaveBeenCalledWith(result.outputPath, "managed transcript");
  });

  it("uses the audio name in its existing folder, not the first words of the transcript", async () => {
    const { app, coordinator, file } = harness({ clean: false });
    file.path = "Custom recordings/Gull Point timetable review.m4a";
    file.name = "Gull Point timetable review.m4a";
    file.basename = "Gull Point timetable review";
    file.extension = "m4a";

    const result = await coordinator.start({ filePath: file.path, destination: "note" });

    expect(result.outputPath).toBe("Custom recordings/Gull Point timetable review.md");
    expect(app.vault.create).toHaveBeenCalledWith(result.outputPath, expect.stringContaining("managed transcript"));
  });

  it("does not mistake a similarly named clean note for an already committed output", async () => {
    const { app, coordinator, file } = harness({ clean: true });
    const unrelated = new TFile({ path: "Recordings/demo notes.md" });
    (unrelated as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([unrelated]);
    (app.vault.read as jest.Mock).mockResolvedValue("managed transcript");

    const result = await coordinator.start({ filePath: file.path, destination: "note" });

    expect(result.outputPath).toBe("Recordings/demo.md");
    expect(app.vault.create).toHaveBeenCalledTimes(1);
  });

  it("allocates a new SRT path instead of reusing or overwriting an unrelated subtitle", async () => {
    const { app, coordinator, file } = harness();
    const existing = new TFile({ path: "Recordings/demo.srt" });
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (path === file.path) return file;
      if (path === existing.path) return existing;
      return null;
    });

    const result = await coordinator.start({
      filePath: file.path,
      destination: "note",
      timestamped: true,
    });

    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo (2).srt",
      "managed transcript",
    );
    expect(result.outputPath).toBe("Recordings/demo (2).srt");
  });

  it("acknowledges local commit after a successful write even if cancellation arrived during it", async () => {
    const { adapter, app, coordinator } = harness();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    (app.vault.create as jest.Mock).mockImplementation(async (path: string) => {
      entered();
      await delayed;
      return new TFile({ path });
    });
    const running = coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
    });
    await waiting;

    coordinator.abort();
    release();

    await expect(running).resolves.toMatchObject({
      outputPath: "Recordings/demo.md",
    });
    expect(adapter.completeLocalCommit).toHaveBeenCalledWith("transcription-op-1");
  });

  it("reuses the same operation-owned Markdown output when resuming local commit", async () => {
    const { adapter, app, coordinator, file } = harness({ clean: false });
    const operationId = "transcription-resume-1";
    const existing = new TFile({ path: "Recordings/demo - transcript - Existing.md" });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue(
      `managed transcript\n\n<!-- systemsculpt-transcription:${operationId} -->\n`,
    );

    const result = await coordinator.start({
      filePath: file.path,
      destination: "note",
      resumeOperationId: operationId,
    });

    expect(adapter.resume).toHaveBeenCalledWith(operationId, expect.any(Object), expect.any(Object));
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(result.outputPath).toBe(existing.path);
    expect(adapter.completeLocalCommit).toHaveBeenCalledWith(operationId);
  });

  it.each(["demo.md", "demo - transcript - Existing.md"])("reuses exact clean Markdown %s on same-operation local-commit recovery", async (name) => {
    const { adapter, app, coordinator, file } = harness({ clean: true });
    const operationId = "transcription-clean-resume-1";
    const existing = new TFile({ path: `Recordings/${name}` });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue("managed transcript");

    const result = await coordinator.start({
      filePath: file.path,
      destination: "note",
      resumeOperationId: operationId,
    });

    expect(adapter.resume).toHaveBeenCalledWith(operationId, expect.any(Object), expect.any(Object));
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(result.outputPath).toBe(existing.path);
    expect(adapter.completeLocalCommit).toHaveBeenCalledWith(operationId);
  });

  it("recovers exact clean output after the adapter explicitly adopts a preserved operation", async () => {
    const { adapter, app, coordinator, file } = harness({ clean: true });
    const existing = new TFile({ path: "Recordings/demo.md" });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue("managed transcript");
    adapter.transcribe.mockImplementation(async (_source: unknown, context: any) => {
      await context.onOperationIdAdopted("preserved-operation");
      return { kind: "transcript", operationId: "preserved-operation", text: "managed transcript" };
    });

    const result = await coordinator.start({ filePath: file.path, destination: "note" });

    expect(result.outputPath).toBe(existing.path);
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("does not claim identical clean output when the requested recovery operation no longer exists", async () => {
    const { adapter, app, coordinator, file } = harness({ clean: true });
    const existing = new TFile({ path: "Recordings/demo.md" });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue("managed transcript");
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (path === file.path) return file;
      return path === existing.path ? existing : null;
    });
    adapter.hasRecoveryOperation.mockResolvedValue(false);

    const result = await coordinator.start({ filePath: file.path, destination: "note", resumeOperationId: "expired-operation" });

    expect(result.outputPath).toBe("Recordings/demo (2).md");
    expect(app.vault.create).toHaveBeenCalledWith(result.outputPath, "managed transcript");
  });

  it("reuses an exact SRT output on same-operation resume instead of creating a duplicate", async () => {
    const { adapter, app, coordinator, file } = harness();
    const operationId = "transcription-srt-resume-1";
    const existing = new TFile({ path: "Recordings/demo.srt" });
    (existing as any).parent = { path: "Recordings" };
    (app.vault.getFiles as jest.Mock).mockReturnValue([existing]);
    (app.vault.read as jest.Mock).mockResolvedValue("managed transcript");
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (path === file.path) return file;
      if (path === existing.path) return existing;
      return null;
    });

    const result = await coordinator.start({
      filePath: file.path,
      destination: "note",
      timestamped: true,
      resumeOperationId: operationId,
    });

    expect(adapter.resume).toHaveBeenCalledWith(operationId, expect.any(Object), expect.any(Object));
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(result.outputPath).toBe(existing.path);
    expect(adapter.completeLocalCommit).toHaveBeenCalledWith(operationId);
  });

  describe.each(["start", "transcribeFile"] as const)("%s source ownership", (entrypoint) => {
    it.each(["completed mismatch", "pending receipt", "expired pending receipt"] as const)(
      "opens a fresh source for each adapter invocation after a %s",
      async (scenario) => {
        const { adapter, app, coordinator, file, release } = harness();
        const operationId = "retained-receipt-operation";
        const receipt: ManagedTranscriptionResult = {
          kind: "local_receipt",
          operationId,
          recoveryPhase: scenario === "completed mismatch" ? "completed" : "local_commit_pending",
          receipt: createLocalCommitReceipt("Recordings/missing.md", "original transcript"),
        };
        const sources: ManagedFileSource[] = [];
        const consume = async (source: ManagedFileSource) => {
          sources.push(source);
          await readAndReleaseSource(source);
        };
        adapter.transcribe.mockImplementation(async (source: ManagedFileSource, context?: ManagedTranscriptionContext) => {
          await consume(source);
          if (entrypoint === "transcribeFile" && sources.length === 1) return receipt;
          return { kind: "transcript", operationId: requiredOperationId(context), text: "recovered transcript" };
        });
        adapter.resume.mockImplementation(async (resumedOperationId, source) => {
          await consume(source);
          if (entrypoint === "start" && sources.length === 1) return receipt;
          if (scenario === "expired pending receipt") {
            throw new ManagedTranscriptionRetryError(operationId, "restart", "local_commit_pending", new Error("expired"));
          }
          return { kind: "transcript", operationId: resumedOperationId, text: "recovered transcript" };
        });

        if (entrypoint === "start") {
          await expect(coordinator.start({ filePath: file.path, destination: "note", resumeOperationId: operationId }))
            .resolves.toMatchObject({ text: "recovered transcript" });
        } else {
          await expect(coordinator.transcribeFile(file, {
            type: "note",
            recoverLocalCommit: async () => { throw new LocalCommitReceiptMismatchError("Saved output is missing."); },
          }, async (text) => text)).resolves.toBe("recovered transcript");
        }

        const expectedCalls = scenario === "expired pending receipt" ? 3 : 2;
        expect(sources).toHaveLength(expectedCalls);
        expect(new Set(sources).size).toBe(expectedCalls);
        expect(new Set(sources.map((source) => source.identity)).size).toBe(1);
        expect(createVaultFileSource).toHaveBeenCalledTimes(expectedCalls);
        expect(release).toHaveBeenCalledTimes(expectedCalls);
        expect(app.vault.readBinary).not.toHaveBeenCalled();
        for (const source of sources) {
          await expect(source.load()).rejects.toThrow("released");
        }
      },
    );
  });

  it.each([
    ["edited", "user-edited transcript"],
    ["missing", null],
  ])("preserves a %s completed output and starts a fresh managed operation", async (_case, currentContent) => {
    const { adapter, app, coordinator, file } = harness();
    const oldOperationId = "transcription-completed-old";
    const oldOutput = new TFile({ path: "Recordings/previous transcript.md" });
    const receipt = createLocalCommitReceipt(oldOutput.path, "original transcript");
    const order: string[] = [];
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => {
      if (path === file.path) return file;
      if (path === oldOutput.path && currentContent !== null) return oldOutput;
      return null;
    });
    (app.vault.read as jest.Mock).mockResolvedValue(currentContent);
    adapter.resume.mockImplementation(async (_operationId, source) => {
      await readAndReleaseSource(source);
      return {
        kind: "local_receipt",
        operationId: oldOperationId,
        recoveryPhase: "completed",
        receipt,
      };
    });
    adapter.acknowledgeCompleted.mockImplementation(async () => {
      order.push("ack-old");
    });
    adapter.transcribe.mockImplementation(async (source: ManagedFileSource, context?: ManagedTranscriptionContext) => {
      await readAndReleaseSource(source);
      return { kind: "transcript", operationId: requiredOperationId(context), text: "fresh transcript" };
    });
    const onOperationIdChange = jest.fn(async (operationId: string) => {
      order.push(`persist:${operationId}`);
    });

    const result = await coordinator.start({
      filePath: file.path,
      destination: "note",
      sourceOwnership: "recorder-capture",
      resumeOperationId: oldOperationId,
      onOperationIdChange,
    });

    expect(onOperationIdChange).toHaveBeenCalledTimes(2);
    const replacementOperationId = onOperationIdChange.mock.calls[1]?.[0];
    expect(order).toEqual([
      `persist:${oldOperationId}`,
      `persist:${replacementOperationId}`,
      "ack-old",
    ]);
    expect(onOperationIdChange).toHaveBeenCalledWith(expect.stringMatching(/^transcription-/));
    expect(adapter.transcribe).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ operationId: replacementOperationId }),
    );
    expect(result).toMatchObject({
      operationId: replacementOperationId,
      warning: expect.stringContaining("previous transcript was changed or removed"),
    });
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("persists a replacement ID before restarting expired local-commit recovery", async () => {
    const { adapter, coordinator } = harness();
    const oldOperationId = "expired-local-commit";
    adapter.resume
      .mockImplementationOnce(async (_operationId, source) => {
        await readAndReleaseSource(source);
        return {
          kind: "local_receipt",
          operationId: oldOperationId,
          recoveryPhase: "local_commit_pending",
          receipt: createLocalCommitReceipt("Recordings/missing.md", "missing"),
        };
      })
      .mockImplementationOnce(async (_operationId, source) => {
        await readAndReleaseSource(source);
        throw new ManagedTranscriptionRetryError(oldOperationId, "restart", "local_commit_pending", new Error("expired"));
      });
    adapter.transcribe.mockImplementation(async (source: ManagedFileSource, context?: ManagedTranscriptionContext) => {
      await readAndReleaseSource(source);
      return { kind: "transcript", operationId: requiredOperationId(context), text: "fresh transcript" };
    });
    const persisted: string[] = [];

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      resumeOperationId: oldOperationId,
      onOperationIdChange: async (operationId) => { persisted.push(operationId); },
    });

    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toBe(oldOperationId);
    const replacementOperationId = persisted[1];
    expect(adapter.transcribe).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ operationId: replacementOperationId }),
    );
    expect(result).toMatchObject({
      operationId: replacementOperationId,
      warning: expect.stringContaining("server result expired"),
    });
  });

  it("replaces a persisted operation ID whose recovery record was never created", async () => {
    const { adapter, coordinator } = harness();
    adapter.hasRecoveryOperation.mockResolvedValue(false);
    adapter.transcribe.mockImplementation(async (source: ManagedFileSource, context?: ManagedTranscriptionContext) => {
      await readAndReleaseSource(source);
      return { kind: "transcript", operationId: requiredOperationId(context), text: "fresh transcript" };
    });
    const onOperationIdChange = jest.fn(async (_operationId: string) => undefined);

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      resumeOperationId: "persisted-before-record",
      onOperationIdChange,
    });

    expect(adapter.resume).not.toHaveBeenCalled();
    expect(onOperationIdChange).toHaveBeenNthCalledWith(1, "persisted-before-record");
    expect(onOperationIdChange).toHaveBeenCalledWith(expect.stringMatching(/^transcription-/));
    expect(result.operationId).toBe(onOperationIdChange.mock.calls[1]?.[0]);
  });

  it("does not dispatch or discard a resumed operation when its initial persistence fails", async () => {
    const { adapter, coordinator } = harness();
    const persistenceError = new Error("settings storage unavailable");

    const failure = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      resumeOperationId: "persisted-resume-operation",
      onOperationIdChange: async () => { throw persistenceError; },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TranscriptionResumeRequiredError);
    expect(failure).toMatchObject({
      operationId: "persisted-resume-operation",
      originalError: persistenceError,
    });
    expect(adapter.hasRecoveryOperation).not.toHaveBeenCalled();
    expect(adapter.resume).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ["lookup", "hasRecoveryOperation"],
    ["read", "resume"],
  ] as const)("preserves a resumed operation when its recovery %s fails", async (_case, failingMethod) => {
    const { adapter, coordinator } = harness();
    const recoveryError = new Error("recovery storage unavailable");
    if (failingMethod === "hasRecoveryOperation") {
      adapter.hasRecoveryOperation.mockRejectedValueOnce(recoveryError);
    } else {
      adapter.resume.mockRejectedValueOnce(recoveryError);
    }

    const failure = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      resumeOperationId: "persisted-resume-operation",
      onOperationIdChange: async () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TranscriptionResumeRequiredError);
    expect(failure).toMatchObject({
      operationId: "persisted-resume-operation",
      originalError: recoveryError,
    });
    expect(adapter.transcribe).not.toHaveBeenCalled();
  });

  it("persists an exact-source operation adopted during a fresh transcription", async () => {
    const { adapter, coordinator, events } = harness();
    adapter.transcribe.mockImplementation(async () => {
      events.push("remote");
      return {
        kind: "transcript",
        operationId: "preserved-exact-source-operation",
        text: "managed transcript",
      };
    });
    const onOperationIdChange = jest.fn(async (operationId: string) => {
      events.push(`persist:${operationId}`);
    });

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "recorder-capture",
      onOperationIdChange,
    });

    expect(onOperationIdChange).toHaveBeenCalledWith("preserved-exact-source-operation");
    const initialOperationId = onOperationIdChange.mock.calls[0]?.[0];
    expect(events).toEqual([
      `persist:${initialOperationId}`,
      "remote",
      "persist:preserved-exact-source-operation",
      "commit:begin",
      "commit:receipt",
      "write:Recordings/demo.md",
      "commit:complete",
    ]);
    expect(result.operationId).toBe("preserved-exact-source-operation");
  });

  it("keeps recorder completion acknowledgment caller-owned and idempotent", async () => {
    const { adapter, coordinator } = harness();

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "recorder-capture",
    });

    expect(adapter.acknowledgeCompleted).not.toHaveBeenCalled();
    await result.acknowledgeCompletion?.();
    await result.acknowledgeCompletion?.();
    expect(adapter.acknowledgeCompleted).toHaveBeenCalledTimes(1);
    expect(adapter.acknowledgeCompleted).toHaveBeenCalledWith("transcription-op-1");
  });

  it("acknowledges user-file completion after all durable side effects", async () => {
    const { adapter, coordinator } = harness();

    const result = await coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "user-file",
    });

    expect(result.acknowledgeCompletion).toBeUndefined();
    expect(adapter.acknowledgeCompleted).toHaveBeenCalledWith("transcription-op-1");
  });

  it("uses the output and retention policy captured before remote work", async () => {
    const { adapter, app, coordinator } = harness({
      autoPaste: true,
      clean: false,
      keep: false,
      postProcess: true,
    });
    const originEditor = { replaceSelection: jest.fn() } as any;
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    adapter.transcribe.mockImplementation(async (_source: unknown, context?: ManagedTranscriptionContext) => {
      entered();
      await delayed;
      return { kind: "transcript", operationId: requiredOperationId(context), text: "managed transcript" };
    });
    const running = coordinator.start({
      filePath: "Recordings/demo.webm",
      destination: "note",
      sourceOwnership: "recorder-capture",
      targetEditor: originEditor,
      validateInsertionTarget: () => true,
    });
    await waiting;
    Object.assign((coordinator as any).plugin.settings, {
      postProcessingEnabled: false,
      autoPasteTranscription: false,
      keepRecordingsAfterTranscription: true,
      cleanTranscriptionOutput: true,
    });
    release();

    const result = await running;

    expect(mockProcessTranscription).toHaveBeenCalledTimes(1);
    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo.md",
      expect.stringContaining("## Cleaned transcript\nprocessed:managed transcript"),
    );
    expect(originEditor.replaceSelection).toHaveBeenCalledWith("processed:managed transcript");
    expect(result.sourceDisposition).toBe("trashed");
  });

  it("gives every transcription task the plugin's one recovery store", () => {
    const app = new App();
    const recovery = { initialize: jest.fn() };
    const plugin = {
      app,
      settings: {},
      getManagedCapabilityGraph: jest.fn(() => ({ admission: {}, transport: {}, recovery })),
    } as any;

    const first = (new TranscriptionCoordinator(app, plugin) as any).adapter();
    const second = (new TranscriptionCoordinator(app, plugin) as any).adapter();

    expect(first).not.toBe(second);
    expect(first.dependencies.recovery).toBe(recovery);
    expect(second.dependencies.recovery).toBe(recovery);
  });
});

