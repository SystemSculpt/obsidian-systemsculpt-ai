/**
 * @jest-environment jsdom
 */
import { App, MarkdownView, TFile } from "obsidian";
import { ManagedTranscriptionInterruptedError } from "../../services/transcription/ManagedTranscriptionAdapter";
import { AudioTranscriptionPanel } from "../AudioTranscriptionPanel";

const mockStart = jest.fn();
jest.mock("../../services/TranscriptionService", () => ({
  TranscriptionService: {
    getInstance: jest.fn(() => ({ start: mockStart })),
  },
}));

jest.mock("../../utils/clipboard", () => ({
  tryCopyToClipboard: jest.fn(async () => true),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const completedResult = {
  operationId: "transcription-op-1",
  text: "managed transcript",
  outputPath: "Recordings/test.srt",
  insertedIntoOrigin: false,
  sourceDisposition: "kept" as const,
};

const panelOwners = new Set<any>();

function createPanel(options: { openOnComplete?: boolean; targetEditor?: any; plugin?: any } = {}) {
  const app = new App();
  const file = new TFile({
    path: "Recordings/test.wav",
    name: "test.wav",
    stat: { size: 1234 },
  });
  const output = new TFile({
    path: completedResult.outputPath,
    name: "test.srt",
  });
  const activeEditor = {
    replaceSelection: jest.fn(),
    getCursor: jest.fn((which?: "from" | "to") => (which === "to"
      ? { line: 0, ch: 0 }
      : { line: 0, ch: 0 })),
    getSelection: jest.fn(() => ""),
  };
  const activeFile = new TFile({ path: "Notes/origin.md" });
  const activeView = new MarkdownView() as MarkdownView & {
    editor: typeof activeEditor;
    file: TFile | null;
  };
  activeView.editor = activeEditor;
  activeView.file = activeFile;
  const activeLeaf = { view: activeView };
  const leaf = { openFile: jest.fn(async () => undefined) };
  (app.workspace as any).activeLeaf = activeLeaf;
  (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(activeView);
  (app.workspace as any).getLeaf = jest.fn(() => leaf);
  (app.workspace as any).setActiveLeaf = jest.fn();
  (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
    (path: string) => path === output.path ? output : null,
  );
  const plugin = options.plugin ?? { app, settings: {} } as any;
  panelOwners.add(plugin);
  const panel = new AudioTranscriptionPanel(app, {
    file,
    timestamped: true,
    ...options,
    plugin,
  });
  return { activeEditor, activeFile, activeLeaf, activeView, app, file, leaf, output, panel, plugin };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AudioTranscriptionPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
    mockStart.mockReset().mockImplementation((request: any) => {
      request.onProgress?.({
        phase: "uploading",
        progress: 50,
        message: "Uploading audio…",
      });
      return {
        promise: Promise.resolve(completedResult),
        cancel: jest.fn(),
      };
    });
  });

  afterEach(() => {
    for (const owner of panelOwners) AudioTranscriptionPanel.disposeOwnedBy(owner);
    panelOwners.clear();
    jest.restoreAllMocks();
  });

  it("starts one managed note task and preserves its timestamped output path", async () => {
    const targetEditor = { replaceSelection: jest.fn() };
    const { panel } = createPanel({ targetEditor });
    panel.open();

    await flushPromises();

    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "Recordings/test.wav",
      destination: "note",
      targetEditor,
      timestamped: true,
    }));
    const statusTexts = document.querySelectorAll(".systemsculpt-progress-status-text");
    expect(statusTexts[statusTexts.length - 1]?.textContent).toContain("Transcript saved");
    expect(document.body.textContent).toContain("Recordings/test.srt");
  });

  it("captures the initiating editor when the caller does not provide one", () => {
    const { activeEditor, panel } = createPanel();
    panel.open();

    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({
      targetEditor: activeEditor,
      validateInsertionTarget: expect.any(Function),
    }));
  });

  it("passes a validator that rejects same-leaf navigation to another note", () => {
    const { activeView, panel } = createPanel();
    panel.open();
    const request = mockStart.mock.calls[0][0];
    expect(request.validateInsertionTarget()).toBe(true);

    activeView.file = new TFile({ path: "Notes/later.md" });

    expect(request.validateInsertionTarget()).toBe(false);
  });

  it("preserves an explicit save-only target instead of falling back to the active editor", () => {
    const { panel } = createPanel({ targetEditor: null });
    panel.open();

    expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({
      targetEditor: null,
    }));
  });

  it("treats Hide and close as presentation detachment, not cancellation", () => {
    const running = deferred<typeof completedResult>();
    const cancel = jest.fn();
    mockStart.mockReturnValue({ promise: running.promise, cancel });
    const { panel } = createPanel();
    panel.open();

    const hide = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Hide") as HTMLButtonElement;
    hide.click();
    panel.close();

    expect(cancel).not.toHaveBeenCalled();
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
  });

  it("Stop waiting cancels locally and reports safe cancellation immediately", () => {
    const running = deferred<typeof completedResult>();
    const cancel = jest.fn();
    mockStart.mockReturnValue({ promise: running.promise, cancel });
    const { panel } = createPanel();
    panel.open();

    const stopWaiting = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Stop waiting") as HTMLButtonElement;
    stopWaiting.click();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".systemsculpt-progress-panel")).not.toBeNull();
    expect(document.body.textContent).toContain("Stopped waiting locally; finishing safe cancellation");
    expect(document.body.textContent).not.toContain("Transcription is continuing");
  });

  it("offers same-operation Resume after Stop waiting preserves server processing", async () => {
    const first = deferred<typeof completedResult>();
    const second = deferred<typeof completedResult>();
    const cancel = jest.fn();
    mockStart
      .mockReturnValueOnce({ operationId: "preserved-panel-op", promise: first.promise, cancel })
      .mockReturnValueOnce({ operationId: "preserved-panel-op", promise: second.promise, cancel: jest.fn() });
    const { panel } = createPanel();
    panel.open();

    ([...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Stop waiting") as HTMLButtonElement).click();
    ([...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Hide") as HTMLButtonElement).click();
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
    first.reject(new ManagedTranscriptionInterruptedError(
      "preserved-panel-op",
      true,
      "processing",
      "resume",
    ));
    await flushPromises();

    expect(document.querySelector(".systemsculpt-progress-panel")).not.toBeNull();
    expect(document.body.textContent).toContain("server transcription is preserved");
    const resume = [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Resume") as HTMLButtonElement;
    expect(resume).toBeTruthy();
    resume.click();

    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(mockStart.mock.calls[1][0]).toEqual(expect.objectContaining({
      resumeOperationId: "preserved-panel-op",
    }));
    second.resolve(completedResult);
    await flushPromises();
  });

  it("opens the coordinator-owned output without creating a second transcript", async () => {
    const { app, leaf, output, panel } = createPanel({ openOnComplete: true });
    panel.open();

    await flushPromises();

    expect(leaf.openFile).toHaveBeenCalledWith(output);
    expect(app.workspace.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    expect(app.vault.create).not.toHaveBeenCalled();
    expect(app.vault.modify).not.toHaveBeenCalled();
  });

  it("keeps the saved result actionable when automatic opening fails", async () => {
    const { leaf, panel } = createPanel({ openOnComplete: true });
    leaf.openFile.mockRejectedValueOnce(new Error("leaf unavailable"));

    panel.open();
    await flushPromises();

    expect(document.body.textContent).toContain("Transcript saved");
    expect([...document.querySelectorAll("button")]
      .some((button) => button.textContent === "Open transcript")).toBe(true);
  });

  it("keeps a completed output actionable when cleanup returns a warning", async () => {
    mockStart.mockReturnValue({
      promise: Promise.resolve({
        ...completedResult,
        sourceDisposition: "cleanup-failed",
        warning: "The source audio could not be moved to trash.",
      }),
      cancel: jest.fn(),
    });
    const { panel } = createPanel();
    panel.open();

    await flushPromises();

    expect(document.body.textContent).toContain("Transcript saved with a warning");
    expect(document.body.textContent).toContain(completedResult.outputPath);
  });

  it("shows a task failure without deleting or rewriting the source", async () => {
    const failed = deferred<typeof completedResult>();
    mockStart.mockReturnValue({
      promise: failed.promise,
      cancel: jest.fn(),
    });
    const { app, panel } = createPanel();
    panel.open();
    failed.reject(new Error("managed job failed"));

    await flushPromises();

    expect(document.body.textContent).toContain("Transcription failed");
    expect(document.body.textContent).toContain("managed job failed");
    expect(app.vault.create).not.toHaveBeenCalled();
    expect((app.fileManager as any).trashFile).toBeUndefined();
  });

  it("disposes only the unloading plugin's panels and suppresses late abort recovery UI", async () => {
    const oldTask = deferred<typeof completedResult>();
    const reloadedTask = deferred<typeof completedResult>();
    const oldCancel = jest.fn();
    const reloadedCancel = jest.fn();
    mockStart
      .mockReturnValueOnce({ promise: oldTask.promise, cancel: oldCancel })
      .mockReturnValueOnce({ promise: reloadedTask.promise, cancel: reloadedCancel });

    const old = createPanel();
    old.panel.open();
    const reloaded = createPanel();
    reloaded.panel.open();
    expect(document.querySelectorAll(".systemsculpt-progress-panel")).toHaveLength(2);

    const noticeLog = jest.spyOn(console, "log").mockImplementation(() => undefined);
    AudioTranscriptionPanel.disposeOwnedBy(old.plugin);

    expect(oldCancel).toHaveBeenCalledTimes(1);
    expect(reloadedCancel).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".systemsculpt-progress-panel")).toHaveLength(1);

    oldTask.reject(new ManagedTranscriptionInterruptedError(
      "old-plugin-operation",
      true,
      "processing",
      "resume",
    ));
    await flushPromises();

    expect(document.querySelectorAll(".systemsculpt-progress-panel")).toHaveLength(1);
    expect(document.body.textContent).not.toContain("server transcription is preserved");
    expect([...document.querySelectorAll("button")]
      .some((button) => button.textContent === "Resume")).toBe(false);
    expect(noticeLog.mock.calls.some(([message]) => String(message).startsWith("Notice:"))).toBe(false);
  });

  it("suppresses completion UI and refocus after disposal during automatic opening", async () => {
    const opening = deferred<void>();
    const { app, leaf, panel, plugin } = createPanel({ openOnComplete: true });
    leaf.openFile.mockReturnValue(opening.promise);
    const noticeLog = jest.spyOn(console, "log").mockImplementation(() => undefined);

    panel.open();
    await flushPromises();
    expect(leaf.openFile).toHaveBeenCalledTimes(1);

    AudioTranscriptionPanel.disposeOwnedBy(plugin);
    opening.resolve();
    await flushPromises();

    expect(app.workspace.setActiveLeaf).not.toHaveBeenCalled();
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
    expect(noticeLog.mock.calls.some(([message]) => String(message).startsWith("Notice:"))).toBe(false);
  });
});
