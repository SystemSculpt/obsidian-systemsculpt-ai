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

  let pauseSpy: jest.SpyInstance;
  let loadSpy: jest.SpyInstance;
  let createObjectUrl: jest.Mock;
  let revokeObjectUrl: jest.Mock;

  beforeEach(() => {
    launchPanel.mockReset();
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
      '.ss-transcribe-audio__tab[role="tab"]',
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
      ".ss-transcribe-audio__file-input",
    );
    const label = modal.modalEl.querySelector<HTMLLabelElement>(
      ".ss-transcribe-audio__choose-file",
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
      '.ss-transcribe-audio__file[role="option"]',
    );
    expect(initialOptions).toHaveLength(50);
    expect(modal.modalEl.textContent).toContain("Showing the first 50 of 75");

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
      ".ss-transcribe-audio__file",
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
      `.ss-transcribe-audio__file[data-path="${file.path}"]`,
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
    modal.modalEl.querySelector<HTMLButtonElement>(".ss-transcribe-audio__file")!.click();
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
    await (modal as any).handleDeviceSelection(deviceFile);
    expect(modal.modalEl.querySelector("audio")?.src).toContain("blob:audio-preview");

    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation((path: string) =>
      path === "SystemSculpt/Recordings/1234_voice.m4a"
        ? audioFile(path, deviceFile.size)
        : null,
    );
    const created = audioFile("SystemSculpt/Recordings/1234_voice-2.m4a", deviceFile.size);
    (app.vault.createBinary as jest.Mock).mockResolvedValue(created);
    jest.spyOn(Date, "now").mockReturnValue(1234);

    await (modal as any).handleTranscribe();

    expect(ensureDirectoryByPath).toHaveBeenCalledWith("SystemSculpt/Recordings");
    expect(app.vault.createBinary).toHaveBeenCalledWith(
      "SystemSculpt/Recordings/1234_voice-2.m4a",
      deviceBytes,
    );
    expect(updateSettings).not.toHaveBeenCalled();
    expect(launchPanel).toHaveBeenCalledWith(app, expect.objectContaining({
      file: created,
      targetEditor: initiatingEditor,
      validateInsertionTarget: expect.any(Function),
    }));
    const launchedOptions = launchPanel.mock.calls[0][1];
    expect(launchedOptions.validateInsertionTarget?.()).toBe(false);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:audio-preview");
  });

  it("releases a device preview URL when the modal closes", async () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    await (modal as any).handleDeviceSelection(
      new File(["voice"], "voice.webm", { type: "audio/webm" }),
    );
    expect(createObjectUrl).toHaveBeenCalledTimes(1);

    modal.onClose();

    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:audio-preview");
  });

  it("applies the 32 MiB mobile cap before reading or staging a device file", async () => {
    Object.assign(Platform, { isDesktopApp: false, isMobileApp: true });
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);
    const deviceFile = {
      name: "too-large.m4a",
      type: "audio/mp4",
      size: 32 * 1024 * 1024 + 1,
      arrayBuffer: jest.fn(),
    } as unknown as File;
    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    await (modal as any).handleDeviceSelection(deviceFile);
    await (modal as any).handleTranscribe();

    expect(mockShowPrompt).toHaveBeenCalledWith(
      app,
      expect.stringContaining("32.0 MiB"),
      expect.objectContaining({ title: "Audio File Size Limit Exceeded" }),
    );
    expect(deviceFile.arrayBuffer).not.toHaveBeenCalled();
    expect(app.vault.createBinary).not.toHaveBeenCalled();
    expect(launchPanel).not.toHaveBeenCalled();
    Object.assign(Platform, { isDesktopApp: true, isMobileApp: false });
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
    await (modal as any).handleDeviceSelection(deviceFile);

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
    await (modal as any).handleDeviceSelection(deviceFile);

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
