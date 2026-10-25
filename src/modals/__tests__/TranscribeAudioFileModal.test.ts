/**
 * @jest-environment jsdom
 */
import { App, Platform, TFile } from "obsidian";
import { showPrompt } from "../../core/ui/modals/PromptModal";
import { launchAudioTranscriptionPanel } from "../AudioTranscriptionPanel";
import { TranscribeAudioFileModal } from "../TranscribeAudioFileModal";

jest.mock("../../core/ui/modals/PromptModal", () => ({
  showPrompt: jest.fn(async () => ({ confirmed: true })),
}));

const mockShowPrompt = showPrompt as jest.MockedFunction<typeof showPrompt>;

jest.mock("../AudioTranscriptionPanel", () => ({
  launchAudioTranscriptionPanel: jest.fn(),
}));

describe("TranscribeAudioFileModal", () => {
  const launchPanel = launchAudioTranscriptionPanel as jest.MockedFunction<
    typeof launchAudioTranscriptionPanel
  >;

  const audioFile = (
    path = "SystemSculpt/Recordings/session.mp3",
    size = 1_200,
    mtime = Date.now(),
  ): TFile => new (TFile as any)({
    path,
    name: path.split("/").pop(),
    extension: path.split(".").pop(),
    stat: { mtime, ctime: mtime, size },
  }) as TFile;

  const createPlugin = (settingsOverrides: Record<string, unknown> = {}) => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const ensureDirectoryByPath = jest.fn().mockResolvedValue(undefined);
    const settings = {
      recordingsDirectory: "SystemSculpt/Recordings",
      transcriptionOutputFormat: "markdown",
      ...settingsOverrides,
    };

    (app.vault as any).getResourcePath = jest.fn(
      (file: TFile) => `app://${file.path}`,
    );
    (app.vault as any).createBinary = jest.fn();
    (app.fileManager as any).trashFile = jest.fn().mockResolvedValue(undefined);

    const plugin = {
      app,
      settings,
      directoryManager: { ensureDirectoryByPath },
      getSettingsManager: () => ({ updateSettings }),
      vaultFileCache: null,
    } as any;

    return { app, plugin, settings, updateSettings, ensureDirectoryByPath };
  };

  const slicedImport = (size = 33 * 1024 * 1024 + 3) => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    const files = new Map<string, TFile>();
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) => files.get(path) ?? null);
    (app.vault.createBinary as jest.Mock).mockImplementation(async (path: string, bytes: ArrayBuffer) => {
      const file = audioFile(path, bytes.byteLength);
      files.set(path, file);
      return file;
    });
    const append = jest.fn(async (file: TFile, bytes: ArrayBuffer) => { file.stat.size += bytes.byteLength; });
    const rename = jest.fn(async (file: TFile, path: string) => {
      expect(file.stat.size).toBe(size);
      files.delete(file.path);
      file.path = path;
      files.set(path, file);
    });
    Object.assign(app.vault, { appendBinary: append, rename });
    (app.fileManager.trashFile as jest.Mock).mockImplementation(async (file: TFile) => { files.delete(file.path); });
    const wholeRead = jest.fn(async (): Promise<ArrayBuffer> => { throw new Error("Whole-file reads are forbidden"); });
    const slice = jest.fn((start: number, end: number) => ({
      arrayBuffer: async () => {
        const bytes = new Uint8Array(end - start);
        bytes[0] = start / (1024 * 1024);
        return bytes.buffer;
      },
    }));
    const deviceFile = { name: "long-recording.m4a", type: "audio/mp4", size, arrayBuffer: wholeRead, slice } as unknown as File;
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    return { app, modal, files, append, rename, wholeRead, slice, deviceFile };
  };

  let pauseSpy: jest.SpyInstance;
  let loadSpy: jest.SpyInstance;
  let createObjectUrl: jest.Mock;
  let revokeObjectUrl: jest.Mock;

  beforeEach(() => {
    launchPanel.mockReset();
    mockShowPrompt.mockClear();
    pauseSpy = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    loadSpy = jest.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    createObjectUrl = jest.fn(() => "blob:audio-preview");
    revokeObjectUrl = jest.fn();
    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: createObjectUrl,
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectUrl,
    });
  });

  afterEach(() => {
    pauseSpy.mockRestore();
    loadSpy.mockRestore();
    document.body.empty();
    jest.restoreAllMocks();
  });

  it("uses keyboard-ready Vault and Device tabs with a native file input", () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    const tabs = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      '.ss-audio-source__tab[role="tab"]',
    );
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain("Vault");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].textContent).toContain("Device");

    tabs[0].dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
    }));
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");

    const input = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-audio-source__file-input",
    );
    const label = modal.modalEl.querySelector<HTMLLabelElement>(
      ".ss-audio-source__choose-file",
    );
    expect(input).toBeTruthy();
    expect(input?.type).toBe("file");
    expect(input?.accept).toContain(".m4a");
    expect(input?.accept).toContain(".flac");
    expect(input?.accept).toContain(".mp4");
    expect(label?.htmlFor).toBe(input?.id);
    expect(modal.modalEl.textContent).toContain("You can also drop a file here.");
  });

  it("bounds the vault list, searches it, and moves selection with arrow keys", () => {
    const { app, plugin } = createPlugin();
    const files = Array.from({ length: 75 }, (_, index) =>
      audioFile(`Audio/clip-${index}.mp3`, index + 1, index + 1),
    );
    (app.vault.getFiles as jest.Mock).mockReturnValue(files);

    const modal = new TranscribeAudioFileModal(plugin);
    document.body.appendChild(modal.modalEl);
    modal.onOpen();

    const initialOptions = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      '.ss-audio-source__file[role="option"]',
    );
    expect(initialOptions).toHaveLength(50);
    expect(modal.modalEl.textContent).toContain("Showing 50 of 75");

    initialOptions[0].focus();
    initialOptions[0].dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
    }));
    expect(initialOptions[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(initialOptions[1]);

    const search = modal.modalEl.querySelector<HTMLInputElement>(
      '.ss-search-field input[type="search"]',
    )!;
    search.value = "clip-7.mp3";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const filteredOptions = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      ".ss-audio-source__file",
    );
    expect(filteredOptions).toHaveLength(1);
    expect(filteredOptions[0].dataset.path).toBe("Audio/clip-7.mp3");
  });

  it("always shows Markdown and SRT, but keeps a one-off choice local", async () => {
    const file = audioFile();
    const { app, plugin, updateSettings } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([file]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    const outputOptions = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      '.ss-transcribe-audio__output-option[role="radio"]',
    );
    expect(outputOptions).toHaveLength(2);
    expect(outputOptions[0].getAttribute("aria-checked")).toBe("true");

    outputOptions[1].click();
    await Promise.resolve();
    modal.modalEl.querySelector<HTMLButtonElement>(
      `.ss-audio-source__file[data-path="${file.path}"]`,
    )!.click();
    await (modal as any).handleTranscribe();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(launchPanel).toHaveBeenCalledWith(app, expect.objectContaining({
      file,
      timestamped: true,
      plugin,
    }));
  });

  it("saves the format only when Remember this format is checked", async () => {
    const file = audioFile();
    const { app, plugin, updateSettings } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([file]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    const outputOptions = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      ".ss-transcribe-audio__output-option",
    );
    outputOptions[1].click();
    await Promise.resolve();

    const remember = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-transcribe-audio__remember-checkbox",
    )!;
    remember.checked = true;
    remember.dispatchEvent(new Event("change", { bubbles: true }));
    modal.modalEl.querySelector<HTMLButtonElement>(".ss-audio-source__file")!.click();
    await (modal as any).handleTranscribe();

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ transcriptionOutputFormat: "srt" });
  });

  it("imports device audio with createBinary and keeps the initiating editor", async () => {
    const initiatingEditor = { replaceSelection: jest.fn() };
    const originNote = audioFile("Notes/origin.md");
    const laterNote = audioFile("Notes/later.md");
    const originView = { editor: initiatingEditor, file: originNote };
    const originLeaf = { view: originView };
    const { app, plugin, updateSettings, ensureDirectoryByPath } = createPlugin();
    (app.workspace as any).activeLeaf = originLeaf;
    (app.workspace.getActiveViewOfType as jest.Mock).mockReturnValue(originView);
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    originView.file = laterNote;

    const deviceBytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const deviceFile = {
      name: "voice.m4a",
      type: "audio/mp4",
      size: deviceBytes.byteLength,
      arrayBuffer: jest.fn().mockResolvedValue(deviceBytes),
    } as unknown as File;
    await (modal as any).picker.selectDeviceFile(deviceFile);
    expect(modal.modalEl.querySelector("audio")?.src).toContain("blob:audio-preview");

    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) =>
      path === "SystemSculpt/Recordings/voice.m4a"
        ? audioFile(path, deviceFile.size)
        : null,
    );
    const created = audioFile("SystemSculpt/Recordings/voice-2.m4a", deviceFile.size);
    (app.vault.createBinary as jest.Mock).mockResolvedValue(created);
    const append = jest.fn();
    Object.assign(app.vault, { appendBinary: append });
    jest.spyOn(Date, "now").mockReturnValue(1234);

    await (modal as any).handleTranscribe();

    expect(ensureDirectoryByPath).toHaveBeenCalledWith("SystemSculpt/Recordings");
    expect(app.vault.createBinary).toHaveBeenCalledWith(
      "SystemSculpt/Recordings/voice-2.m4a",
      deviceBytes,
    );
    expect(updateSettings).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(launchPanel).toHaveBeenCalledWith(app, expect.objectContaining({
      file: created,
      targetEditor: initiatingEditor,
      validateInsertionTarget: expect.any(Function),
    }));
    const launchedOptions = launchPanel.mock.calls[0][1];
    expect(launchedOptions.validateInsertionTarget?.()).toBe(false);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:audio-preview");
  });

  it("keeps the readable device filename in the configured recordings folder", async () => {
    const { app, plugin, ensureDirectoryByPath } = createPlugin({ recordingsDirectory: "My recordings" });
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.createBinary as jest.Mock).mockImplementation(async (path: string) => audioFile(path));
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const deviceFile = {
      name: "Gull Point timetable review.m4a", type: "audio/mp4", size: bytes.byteLength,
      arrayBuffer: jest.fn().mockResolvedValue(bytes),
    } as unknown as File;
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    await (modal as any).picker.selectDeviceFile(deviceFile);

    await (modal as any).handleTranscribe();

    expect(ensureDirectoryByPath).toHaveBeenCalledWith("My recordings");
    expect(app.vault.createBinary).toHaveBeenCalledWith("My recordings/Gull Point timetable review.m4a", bytes);
    expect(launchPanel).toHaveBeenCalledWith(app, expect.objectContaining({
      file: expect.objectContaining({ path: "My recordings/Gull Point timetable review.m4a" }),
      timestamped: false,
    }));
  });

  it("imports large mobile device audio in bounded parts and publishes a unique path only when complete", async () => {
    Object.assign(Platform, { isDesktopApp: false, isMobileApp: true });
    jest.spyOn(Date, "now").mockReturnValue(1234);
    const h = slicedImport();
    const occupiedPath = "SystemSculpt/Recordings/long-recording.m4a";
    const occupied = audioFile(occupiedPath);
    h.files.set(occupiedPath, occupied);
    await (h.modal as any).picker.selectDeviceFile(h.deviceFile);
    try {
      await (h.modal as any).handleTranscribe();
      expect(h.wholeRead).not.toHaveBeenCalled();
      expect(h.slice).toHaveBeenCalled();
      let offset = 0;
      h.slice.mock.calls.forEach(([start, end], index) => {
        expect(start).toBe(offset);
        expect(end - start).toBeGreaterThan(0);
        expect(end - start).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(h.append.mock.calls[index][1].byteLength).toBe(end - start);
        expect(new Uint8Array(h.append.mock.calls[index][1])[0]).toBe(start / (1024 * 1024));
        offset = end;
      });
      expect(offset).toBe(h.deviceFile.size);
      expect(h.append).toHaveBeenCalledTimes(h.slice.mock.calls.length);
      expect(h.app.vault.createBinary).toHaveBeenCalledTimes(1);
      expect((h.app.vault.createBinary as jest.Mock).mock.calls[0][0]).toMatch(/\.partial$/);
      expect((h.app.vault.createBinary as jest.Mock).mock.calls[0][1].byteLength).toBe(0);
      const completed = h.files.get("SystemSculpt/Recordings/long-recording-2.m4a");
      expect(completed?.stat.size).toBe(h.deviceFile.size);
      expect(h.files.get(occupiedPath)).toBe(occupied);
      expect([...h.files.keys()].some(path => path.endsWith(".partial"))).toBe(false);
      expect(h.rename.mock.invocationCallOrder[0]).toBeGreaterThan(h.append.mock.invocationCallOrder.at(-1)!);
      expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
      expect(launchPanel).toHaveBeenCalledWith(h.app, expect.objectContaining({ file: completed }));
    } finally {
      Object.assign(Platform, { isDesktopApp: true, isMobileApp: false });
    }
  });

  it("keeps the legacy single-write import on hosts without portable append", async () => {
    const h = slicedImport(4 * 1024 * 1024 + 1);
    Object.assign(h.app.vault, { appendBinary: undefined });
    const bytes = new ArrayBuffer(h.deviceFile.size);
    h.wholeRead.mockResolvedValueOnce(bytes);
    await (h.modal as any).picker.selectDeviceFile(h.deviceFile);
    await (h.modal as any).handleTranscribe();
    expect(h.wholeRead).toHaveBeenCalledTimes(1);
    expect(h.slice).not.toHaveBeenCalled();
    expect(h.app.vault.createBinary).toHaveBeenCalledWith(expect.stringMatching(/long-recording\.m4a$/), bytes);
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
    expect(launchPanel).toHaveBeenCalledTimes(1);
  });

  it("retries final-path collisions without rereading the device file", async () => {
    jest.spyOn(Date, "now").mockReturnValue(1234);
    const h = slicedImport(4 * 1024 * 1024 + 1);
    h.rename.mockImplementationOnce(async (_file, path) => {
      h.files.set(path, audioFile(path));
      throw new Error("File already exists");
    });
    await (h.modal as any).picker.selectDeviceFile(h.deviceFile);
    await (h.modal as any).handleTranscribe();
    expect(h.rename).toHaveBeenCalledTimes(2);
    expect(h.rename.mock.calls.map(([, path]) => path)).toEqual([
      "SystemSculpt/Recordings/long-recording.m4a",
      "SystemSculpt/Recordings/long-recording-2.m4a",
    ]);
    expect(h.slice).toHaveBeenCalledTimes(2);
    expect(h.app.vault.createBinary).toHaveBeenCalledTimes(1);
    expect(h.app.fileManager.trashFile).not.toHaveBeenCalled();
    expect(launchPanel).toHaveBeenCalledTimes(1);
  });

  it.each(["read", "append", "rename"])("cleans a partial device import when closing during %s", async (phase) => {
    const h = slicedImport(4 * 1024 * 1024 + 1);
    let finish!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    if (phase === "read") {
      h.slice.mockImplementationOnce((start, end) => ({ arrayBuffer: async () => {
        entered();
        await pending;
        return new ArrayBuffer(end - start);
      } }));
    } else if (phase === "append") {
      h.append.mockImplementationOnce(async () => { entered(); await pending; });
    } else {
      h.rename.mockImplementationOnce(async () => { entered(); await pending; });
    }
    await (h.modal as any).picker.selectDeviceFile(h.deviceFile);
    const running = (h.modal as any).handleTranscribe();
    // A missing slice implementation must fail instead of hanging this test.
    await Promise.race([started, running]);
    expect(phase === "read" ? h.slice : phase === "append" ? h.append : h.rename).toHaveBeenCalled();
    h.modal.onClose();
    finish();
    await running;
    expect(h.wholeRead).not.toHaveBeenCalled();
    expect(h.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
    expect(h.files.size).toBe(0);
    expect(launchPanel).not.toHaveBeenCalled();
    if (phase === "read") expect(h.append).not.toHaveBeenCalled();
    if (phase !== "rename") expect(h.rename).not.toHaveBeenCalled();
  });

  it("removes an incomplete device import after a failed append", async () => {
    const notice = jest.spyOn(console, "log").mockImplementation(() => {});
    const h = slicedImport(4 * 1024 * 1024 + 1);
    h.append.mockRejectedValueOnce(new Error("Storage unavailable"));
    await (h.modal as any).picker.selectDeviceFile(h.deviceFile);
    await (h.modal as any).handleTranscribe();
    expect(h.wholeRead).not.toHaveBeenCalled();
    expect(h.slice).toHaveBeenCalledTimes(1);
    expect(h.app.fileManager.trashFile).toHaveBeenCalledTimes(1);
    expect(h.files.size).toBe(0);
    expect(h.rename).not.toHaveBeenCalled();
    expect(launchPanel).not.toHaveBeenCalled();
    expect(h.modal.modalEl.querySelector<HTMLButtonElement>(".ss-transcribe-audio__transcribe-btn")?.disabled).toBe(false);
    expect(notice).toHaveBeenCalledWith("Notice: Could not start transcription: Storage unavailable");
  });

  it("releases a device preview URL when the modal closes", async () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    await (modal as any).picker.selectDeviceFile(
      new File(["voice"], "voice.webm", { type: "audio/webm" }),
    );
    expect(createObjectUrl).toHaveBeenCalledTimes(1);

    modal.onClose();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:audio-preview");
  });

  it("applies the 500 MiB mobile cap before reading or staging a device file", async () => {
    Object.assign(Platform, { isDesktopApp: false, isMobileApp: true });
    const { app, plugin } = createPlugin();
    Object.assign(app.vault, { appendBinary: jest.fn() });
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    const deviceFile = {
      name: "too-large.m4a",
      type: "audio/mp4",
      size: 500 * 1024 * 1024 + 1,
      arrayBuffer: jest.fn(),
    } as unknown as File;
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    await (modal as any).picker.selectDeviceFile(deviceFile);
    await (modal as any).handleTranscribe();

    expect(mockShowPrompt).toHaveBeenCalledWith(
      app,
      expect.stringContaining("500.0 MiB"),
      expect.objectContaining({ title: "Audio File Size Limit Exceeded" }),
    );
    expect(deviceFile.arrayBuffer).not.toHaveBeenCalled();
    expect(app.vault.createBinary).not.toHaveBeenCalled();
    expect(launchPanel).not.toHaveBeenCalled();
    Object.assign(Platform, { isDesktopApp: true, isMobileApp: false });
  });

  it.each([
    { mobile: true, size: 128 * 1024 * 1024, limitLabel: "32.0 MiB" },
    { mobile: false, size: 128 * 1024 * 1024 + 1, limitLabel: "128.0 MiB" },
  ])("preserves the legacy $limitLabel device limit before allocating bytes", async ({ mobile, size, limitLabel }) => {
    Object.assign(Platform, { isDesktopApp: !mobile, isMobileApp: mobile });
    const { app, plugin, ensureDirectoryByPath } = createPlugin();
    Object.assign(app.vault, { appendBinary: undefined });
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    const file = { name: "large.m4a", type: "audio/mp4", size, arrayBuffer: jest.fn(), slice: jest.fn() } as unknown as File;
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    try {
      await (modal as any).picker.selectDeviceFile(file);
      await (modal as any).handleTranscribe();
      expect(mockShowPrompt).toHaveBeenCalledTimes(1);
      expect(mockShowPrompt).toHaveBeenCalledWith(app, expect.stringContaining(limitLabel), expect.objectContaining({ title: "Audio File Size Limit Exceeded" }));
      expect(file.arrayBuffer).not.toHaveBeenCalled();
      expect(file.slice).not.toHaveBeenCalled();
      expect(ensureDirectoryByPath).not.toHaveBeenCalled();
      expect(app.vault.createBinary).not.toHaveBeenCalled();
      expect(launchPanel).not.toHaveBeenCalled();
    } finally {
      Object.assign(Platform, { isDesktopApp: true, isMobileApp: false });
    }
  });

  it("does not import or launch after the modal closes during a device read", async () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    let resolveBytes!: (bytes: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>((resolve) => { resolveBytes = resolve; });
    const deviceFile = {
      name: "long-recording.m4a",
      type: "audio/mp4",
      size: 4,
      arrayBuffer: jest.fn(() => bytes),
    } as unknown as File;
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    await (modal as any).picker.selectDeviceFile(deviceFile);

    const running = (modal as any).handleTranscribe();
    await Promise.resolve();
    await Promise.resolve();
    modal.onClose();
    resolveBytes(new Uint8Array([1, 2, 3, 4]).buffer);
    await running;

    expect(app.vault.createBinary).not.toHaveBeenCalled();
    expect(app.fileManager.trashFile).not.toHaveBeenCalled();
    expect(launchPanel).not.toHaveBeenCalled();
  });

  it("removes a staged device copy and does not launch when closing during its vault write", async () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    const deviceBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const deviceFile = {
      name: "long-recording.m4a",
      type: "audio/mp4",
      size: deviceBytes.byteLength,
      arrayBuffer: jest.fn().mockResolvedValue(deviceBytes),
    } as unknown as File;
    let resolveCreate!: (file: TFile) => void;
    (app.vault.createBinary as jest.Mock).mockImplementation(
      () => new Promise<TFile>((resolve) => { resolveCreate = resolve; }),
    );
    const staged = audioFile("SystemSculpt/Recordings/staged.m4a", deviceBytes.byteLength);
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();
    await (modal as any).picker.selectDeviceFile(deviceFile);

    const running = (modal as any).handleTranscribe();
    for (let attempt = 0; attempt < 10 && !resolveCreate; attempt += 1) {
      await Promise.resolve();
    }
    expect(resolveCreate).toBeDefined();
    modal.onClose();
    resolveCreate(staged);
    await running;

    expect(app.fileManager.trashFile).toHaveBeenCalledWith(staged);
    expect(launchPanel).not.toHaveBeenCalled();
  });
});
