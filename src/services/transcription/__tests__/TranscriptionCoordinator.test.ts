/** @jest-environment jsdom */
import { App, TFile } from "obsidian";
import { TranscriptionCoordinator } from "../TranscriptionCoordinator";

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: jest.fn(async () => undefined) },
});

jest.mock("../../PostProcessingService", () => ({
  PostProcessingService: { getInstance: jest.fn(() => ({ processTranscription: jest.fn(async (text: string) => `processed:${text}`) })) },
}));

jest.mock("../TranscriptionTitleService", () => ({
  TranscriptionTitleService: { getInstance: jest.fn(() => ({
    buildFallbackBasename: (name: string) => `${name} - transcript`,
    tryRenameTranscriptionFile: jest.fn(async (_app: any, file: any) => file.path),
  })) },
}));

function harness(overrides: { keep?: boolean; timestamped?: boolean } = {}) {
  const app = new App();
  const file = new TFile({ path: "Recordings/demo.webm", name: "demo.webm", stat: { size: 4 } });
  (app.vault as any).readBinary = jest.fn();
  (app.vault as any).delete = jest.fn();
  (app.vault as any).modify = jest.fn();
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => path === file.path ? file : null);
  (app.vault.readBinary as jest.Mock).mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);
  (app.vault.create as jest.Mock).mockImplementation(async (path: string) => new TFile({ path, name: path.split("/").pop() }));
  const events: string[] = [];
  const adapter = {
    transcribe: jest.fn(async (source: any) => {
      events.push("remote");
      await source.load();
      return { operationId: "transcription-op-1", text: "managed transcript" };
    }),
    beginLocalCommit: jest.fn(async () => { events.push("commit:begin"); }),
    completeLocalCommit: jest.fn(async () => { events.push("commit:complete"); }),
  };
  (app.vault.create as jest.Mock).mockImplementation(async (path: string) => {
    events.push(`write:${path}`);
    return new TFile({ path, name: path.split("/").pop() });
  });
  (app.vault.delete as jest.Mock).mockImplementation(async () => { events.push("delete-source"); });
  const plugin = {
    app,
    settings: {
      postProcessingEnabled: false,
      autoPasteTranscription: false,
      keepRecordingsAfterTranscription: overrides.keep ?? true,
      cleanTranscriptionOutput: true,
    },
  } as any;
  const coordinator = new TranscriptionCoordinator(app, plugin, { isMobile: () => false } as any, adapter as any);
  return { adapter, app, coordinator, events, file };
}

describe("TranscriptionCoordinator", () => {
  it("commits one Markdown output before optionally deleting the recoverable source", async () => {
    const { adapter, coordinator, events } = harness({ keep: false });
    await coordinator.start({ filePath: "Recordings/demo.webm", useModal: false, onTranscriptionComplete: jest.fn() });

    expect(events).toEqual([
      "remote",
      "commit:begin",
      "write:Recordings/demo - transcript.md",
      "commit:complete",
      "delete-source",
    ]);
    expect(adapter.completeLocalCommit).toHaveBeenCalledWith("transcription-op-1", expect.any(AbortSignal));
  });

  it("preserves the source and pending recovery when the local output write fails", async () => {
    const { adapter, app, coordinator } = harness({ keep: false });
    (app.vault.create as jest.Mock).mockRejectedValue(new Error("disk full"));

    await expect(coordinator.start({ filePath: "Recordings/demo.webm", useModal: false, onTranscriptionComplete: jest.fn() })).rejects.toThrow("disk full");

    expect(adapter.beginLocalCommit).toHaveBeenCalled();
    expect(adapter.completeLocalCommit).not.toHaveBeenCalled();
    expect(app.vault.delete).not.toHaveBeenCalled();
  });

  it("writes timestamped results as SRT without post-processing", async () => {
    const { app, coordinator } = harness();
    await coordinator.start({ filePath: "Recordings/demo.webm", useModal: false, timestamped: true, onTranscriptionComplete: jest.fn() });
    expect(app.vault.create).toHaveBeenCalledWith("Recordings/demo.srt", "managed transcript");
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
    const running = coordinator.start({ filePath: "Recordings/demo.webm", useModal: false, onTranscriptionComplete: jest.fn() });
    await waiting;
    coordinator.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.vault.delete).not.toHaveBeenCalled();
  });

  it("owns an active operation ID before remote dispatch settles", async () => {
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
    const running = coordinator.transcribeFile(file, { type: "note" });
    await waiting;

    expect(acceptedOperationId).toMatch(/^transcription-/);
    expect(coordinator.getActiveOperationId()).toBe(acceptedOperationId);
    coordinator.abort();
    release();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps raw result handoffs resumable instead of falsely completing a durable commit", async () => {
    const { adapter, coordinator, file } = harness();
    await expect(coordinator.transcribeFile(file, { type: "note" })).resolves.toBe("managed transcript");
    expect(adapter.beginLocalCommit).not.toHaveBeenCalled();
    expect(adapter.completeLocalCommit).not.toHaveBeenCalled();
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
    const running = coordinator.start({ filePath: "Recordings/demo.webm", useModal: false, onTranscriptionComplete: jest.fn() });
    await waiting;
    coordinator.abort();
    release();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(adapter.completeLocalCommit).not.toHaveBeenCalled();
  });
});
