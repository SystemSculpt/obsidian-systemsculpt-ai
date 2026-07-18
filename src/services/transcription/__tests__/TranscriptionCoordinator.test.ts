/** @jest-environment jsdom */
import { App, Platform, TFile } from "obsidian";
import {
  ManagedTranscriptionRetryError,
  TranscriptionResumeRequiredError,
} from "../ManagedTranscriptionAdapter";
import { TranscriptionCoordinator } from "../TranscriptionCoordinator";
import { createLocalCommitReceipt } from "../LocalCommitReceipt";

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

const mockTryRename = jest.fn(async (_app: unknown, file: TFile) => file.path);
jest.mock("../TranscriptionTitleService", () => ({
  TranscriptionTitleService: {
    getInstance: jest.fn(() => ({
      buildFallbackBasename: (name: string) => `${name} - transcript`,
      buildTitledBasename: (prefix: string, title: string) => `${prefix} - transcript - ${title}`,
      tryGenerateTitle: jest.fn(async () => null),
      tryRenameTranscriptionFile: mockTryRename,
    })),
  },
}));

interface HarnessOverrides {
  autoPaste?: boolean;
  clean?: boolean;
  keep?: boolean;
  postProcess?: boolean;
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
  (app.vault as unknown as { readBinary: jest.Mock }).readBinary = jest.fn(
    async () => new Uint8Array([1, 2, 3, 4]).buffer,
  );
  (app.vault.create as jest.Mock).mockImplementation(async (path: string) => {
    events.push(`write:${path}`);
    return new TFile({ path, name: path.split("/").pop() });
  });
  (app.vault.modify as jest.Mock).mockImplementation(async () => undefined);
  (app.fileManager as unknown as { trashFile: jest.Mock }).trashFile = jest.fn(async () => {
    events.push("delete-source");
  });

  const adapter = {
    transcribe: jest.fn(async (source: {
      fingerprint(): Promise<string>;
      load(): Promise<{ bytes: ArrayBuffer }>;
    }) => {
      events.push("remote");
      await source.fingerprint();
      await source.load();
      return { kind: "transcript", operationId: "transcription-op-1", text: "managed transcript" };
    }),
    resume: jest.fn(async (operationId: string) => ({ kind: "transcript", operationId, text: "managed transcript" })),
    resumeOrStart: jest.fn(async (operationId: string) => ({ kind: "transcript", operationId, text: "managed transcript" })),
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
  return { adapter, app, coordinator, events, file };
}

describe("TranscriptionCoordinator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(Platform, { isDesktopApp: true, isMobileApp: false });
    mockProcessTranscription.mockImplementation(async (text: string) => ({ text: `processed:${text}` }));
    mockTryRename.mockImplementation(async (_app: unknown, file: TFile) => file.path);
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
      "write:Recordings/demo - transcript.md",
      "commit:complete",
      "delete-source",
    ]);
    expect(result).toMatchObject({
      operationId: "transcription-op-1",
      outputPath: "Recordings/demo - transcript.md",
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
      "Recordings/demo - transcript.md",
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
      "Recordings/demo - transcript.md",
      "managed transcript",
    );
    expect(events).toEqual([
      "remote",
      "commit:begin",
      "commit:receipt",
      "write:Recordings/demo - transcript.md",
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
      return { operationId: "transcription-op-1", text: "late transcript" };
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
      return { operationId: context.operationId, text: "managed transcript" };
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

  it("hashes the source bytes once and reuses those bytes for upload", async () => {
    const { adapter, app, coordinator, file } = harness();
    let fingerprint = "";
    adapter.transcribe.mockImplementation(async (source: any) => {
      fingerprint = await source.fingerprint();
      await source.load();
      return { operationId: "transcription-op-1", text: "managed transcript" };
    });

    await coordinator.transcribeFile(file, { type: "note" }, async (text) => text);

    expect(fingerprint).toBe(
      "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    );
    expect(app.vault.readBinary).toHaveBeenCalledTimes(1);
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
      "Recordings/demo - transcript.md",
      expect.stringContaining("## Raw transcript\nmanaged transcript"),
    );
    expect(app.vault.create).toHaveBeenCalledWith(
      "Recordings/demo - transcript.md",
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
      outputPath: "Recordings/demo - transcript.md",
      insertedIntoOrigin: false,
      warning: expect.stringContaining("note where transcription started changed or closed"),
    });
  });

  it.each([
    [0, "empty"],
    [128 * 1024 * 1024 + 1, "too large"],
  ])("rejects %s-byte audio before reading it into memory", async (size, message) => {
    const { adapter, app, coordinator, file } = harness();
    file.stat.size = size;

    await expect(coordinator.start({
      filePath: file.path,
      destination: "note",
    })).rejects.toThrow(message);

    expect(app.vault.readBinary).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
    expect(adapter.beginLocalCommit).not.toHaveBeenCalled();
  });

  it("rejects audio above 32 MiB on mobile before allocating the file body", async () => {
    Object.assign(Platform, { isDesktopApp: false, isMobileApp: true });
    const { adapter, app, coordinator, file } = harness();
    file.stat.size = 32 * 1024 * 1024 + 1;

    await expect(coordinator.start({
      filePath: file.path,
      destination: "note",
    })).rejects.toThrow("mobile transcription limit is 32.0 MiB");

    expect(app.vault.readBinary).not.toHaveBeenCalled();
    expect(adapter.transcribe).not.toHaveBeenCalled();
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
    const existing = new TFile({ path: "Recordings/demo - transcript.md" });
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
      "Recordings/demo - transcript (2).md",
      expect.stringContaining("managed transcript"),
    );
    expect(result.outputPath).toBe("Recordings/demo - transcript (2).md");
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
      outputPath: "Recordings/demo - transcript.md",
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

  it("reuses exact clean Markdown on same-operation local-commit recovery", async () => {
    const { adapter, app, coordinator, file } = harness({ clean: true });
    const operationId = "transcription-clean-resume-1";
    const existing = new TFile({ path: "Recordings/demo - transcript.md" });
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
    adapter.resume.mockResolvedValue({
      kind: "local_receipt",
      operationId: oldOperationId,
      recoveryPhase: "completed",
      receipt,
    });
    adapter.acknowledgeCompleted.mockImplementation(async () => {
      order.push("ack-old");
    });
    adapter.transcribe.mockImplementation(async (_source: unknown, context: { operationId: string }) => ({
      kind: "transcript",
      operationId: context.operationId,
      text: "fresh transcript",
    }));
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
      .mockResolvedValueOnce({
        kind: "local_receipt",
        operationId: oldOperationId,
        recoveryPhase: "local_commit_pending",
        receipt: createLocalCommitReceipt("Recordings/missing.md", "missing"),
      })
      .mockRejectedValueOnce(new ManagedTranscriptionRetryError(
        oldOperationId,
        "restart",
        "local_commit_pending",
        new Error("expired"),
      ));
    adapter.transcribe.mockImplementation(async (_source: unknown, context: { operationId: string }) => ({
      kind: "transcript",
      operationId: context.operationId,
      text: "fresh transcript",
    }));
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
    adapter.transcribe.mockImplementation(async (_source: unknown, context: { operationId: string }) => ({
      kind: "transcript",
      operationId: context.operationId,
      text: "fresh transcript",
    }));
    const onOperationIdChange = jest.fn(async () => undefined);

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
      "write:Recordings/demo - transcript.md",
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
    adapter.transcribe.mockImplementation(async (_source: unknown, context: { operationId: string }) => {
      entered();
      await delayed;
      return { kind: "transcript", operationId: context.operationId, text: "managed transcript" };
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
      "Recordings/demo - transcript.md",
      expect.stringContaining("## Cleaned transcript\nprocessed:managed transcript"),
    );
    expect(originEditor.replaceSelection).toHaveBeenCalledWith("processed:managed transcript");
    expect(result.sourceDisposition).toBe("trashed");
  });
});
