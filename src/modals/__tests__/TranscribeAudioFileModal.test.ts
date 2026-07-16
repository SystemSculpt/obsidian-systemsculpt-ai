/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { TranscribeAudioFileModal } from "../TranscribeAudioFileModal";
import { launchAudioTranscriptionPanel } from "../AudioTranscriptionPanel";

jest.mock("../AudioTranscriptionPanel", () => ({
  launchAudioTranscriptionPanel: jest.fn(),
}));

describe("TranscribeAudioFileModal", () => {
  const mockedLaunchAudioTranscriptionPanel =
    launchAudioTranscriptionPanel as jest.MockedFunction<
      typeof launchAudioTranscriptionPanel
    >;

  const createAudioFile = () =>
    ({
      path: "SystemSculpt/Recordings/session.mp3",
      name: "session.mp3",
      basename: "session",
      extension: "mp3",
      stat: {
        mtime: Date.now(),
        ctime: Date.now(),
        size: 1200,
      },
    }) as any;

  const createPlugin = (settingsOverrides: Record<string, unknown> = {}) => {
    const app = new App();
    (app.vault as any).getResourcePath = jest.fn((file: { path: string }) => `app://${file.path}`);
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const settings = {
      recordingsDirectory: "SystemSculpt/Recordings",
      transcriptionOutputFormat: "markdown",
      showTranscriptionFormatChooserInModal: true,
      ...settingsOverrides,
    };

    const plugin = {
      app,
      settings,
      getSettingsManager: () => ({
        updateSettings,
      }),
      register: jest.fn(),
      vaultFileCache: null,
    } as any;

    return { app, plugin, updateSettings };
  };

  beforeEach(() => {
    mockedLaunchAudioTranscriptionPanel.mockReset();
  });

  afterEach(() => {
    document.body.empty();
  });

  it("uses the shared search and empty-state interfaces for vault audio", () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    const search = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-search-field input[type='search']"
    );
    const state = modal.modalEl.querySelector<HTMLElement>(
      ".ss-transcribe-audio__list > .ss-ui-state.is-empty"
    );
    expect(search?.type).toBe("search");
    expect(search?.getAttribute("aria-label")).toBe("Search vault audio files");
    expect(state?.textContent).toContain("No audio files");
    expect(state?.getAttribute("role")).toBe("status");
    expect(modal.modalEl.querySelector(".ss-transcribe-audio__search-input")).toBeNull();
  });

  it("filters native file actions and exposes the selected state", () => {
    const first = createAudioFile();
    const second = {
      ...createAudioFile(),
      path: "Audio/interview.wav",
      name: "interview.wav",
      basename: "interview",
      extension: "wav",
    };
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([first, second]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    const search = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-search-field input[type='search']"
    )!;
    search.value = "interview";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    const fileActions = modal.modalEl.querySelectorAll<HTMLButtonElement>(
      ".ss-transcribe-audio__file"
    );
    expect(fileActions).toHaveLength(1);
    expect(fileActions[0].tagName).toBe("BUTTON");
    expect(fileActions[0].getAttribute("aria-pressed")).toBe("false");

    fileActions[0].click();
    expect(fileActions[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("provides a device-neutral file button that triggers the system picker", () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    expect(modal.modalEl.textContent).toContain(
      "choose one from this device"
    );
    expect(modal.modalEl.textContent).not.toContain("Finder");

    const openFileButton = modal.modalEl.querySelector(
      ".ss-transcribe-audio__open-file-btn"
    ) as HTMLButtonElement | null;
    expect(openFileButton).toBeTruthy();
    expect(openFileButton?.textContent).toContain("Choose audio file");

    const fileInputEl = (modal as any).fileInputEl as HTMLInputElement;
    expect(fileInputEl).toBeTruthy();
    const clickSpy = jest.spyOn(fileInputEl, "click").mockImplementation(() => {});

    openFileButton!.click();

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("uses SRT when selected and can hide the chooser for next time", async () => {
    const audioFile = createAudioFile();
    const { app, plugin, updateSettings } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([audioFile]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    const srtRadio = modal.modalEl.querySelector<HTMLInputElement>(
      'input[name="ss-transcribe-output-format"][value="srt"]'
    );
    expect(srtRadio).toBeTruthy();
    srtRadio!.checked = true;
    srtRadio!.dispatchEvent(new Event("change"));

    const hideCheckbox = modal.modalEl.querySelector<HTMLInputElement>(
      ".ss-transcribe-audio__output-hide-checkbox"
    );
    expect(hideCheckbox).toBeTruthy();
    hideCheckbox!.checked = true;
    hideCheckbox!.dispatchEvent(new Event("change"));

    (modal as any).selected = { kind: "vault", file: audioFile };
    await (modal as any).handleTranscribe();

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptionOutputFormat: "srt",
        showTranscriptionFormatChooserInModal: false,
      })
    );
    expect(mockedLaunchAudioTranscriptionPanel).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        file: audioFile,
        timestamped: true,
        plugin,
      })
    );
  });

  it("uses settings default when chooser is hidden and reminds user about settings", async () => {
    const audioFile = createAudioFile();
    const { app, plugin, updateSettings } = createPlugin({
      transcriptionOutputFormat: "srt",
      showTranscriptionFormatChooserInModal: false,
    });
    (app.vault.getFiles as jest.Mock).mockReturnValue([audioFile]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    const outputRadio = modal.modalEl.querySelector<HTMLInputElement>(
      'input[name="ss-transcribe-output-format"]'
    );
    expect(outputRadio).toBeNull();
    expect(modal.modalEl.textContent).toContain(
      "Settings > Workflow"
    );
    expect(modal.modalEl.textContent).not.toContain(
      "Settings > Audio & Transcription"
    );

    (modal as any).selected = { kind: "vault", file: audioFile };
    await (modal as any).handleTranscribe();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(mockedLaunchAudioTranscriptionPanel).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        file: audioFile,
        timestamped: true,
        plugin,
      })
    );
  });
});
