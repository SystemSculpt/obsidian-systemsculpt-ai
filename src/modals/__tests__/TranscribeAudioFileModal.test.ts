/**
 * @jest-environment jsdom
 */
import { App } from "obsidian";
import { TranscribeAudioFileModal } from "../TranscribeAudioFileModal";
import { showAudioTranscriptionModal } from "../AudioTranscriptionModal";

jest.mock("../AudioTranscriptionModal", () => ({
  showAudioTranscriptionModal: jest.fn(),
}));

describe("TranscribeAudioFileModal", () => {
  const mockedShowAudioTranscriptionModal =
    showAudioTranscriptionModal as jest.MockedFunction<
      typeof showAudioTranscriptionModal
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
    mockedShowAudioTranscriptionModal.mockReset();
  });

  it("provides an Open file button that triggers the system file picker input", () => {
    const { app, plugin } = createPlugin();
    (app.vault.getFiles as jest.Mock).mockReturnValue([]);

    const modal = new TranscribeAudioFileModal(plugin);
    modal.onOpen();

    const openFileButton = modal.modalEl.querySelector(
      ".ss-transcribe-audio__open-file-btn"
    ) as HTMLButtonElement | null;
    expect(openFileButton).toBeTruthy();

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
    expect(mockedShowAudioTranscriptionModal).toHaveBeenCalledWith(
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
      "Settings > Audio & Transcription"
    );

    (modal as any).selected = { kind: "vault", file: audioFile };
    await (modal as any).handleTranscribe();

    expect(updateSettings).not.toHaveBeenCalled();
    expect(mockedShowAudioTranscriptionModal).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        file: audioFile,
        timestamped: true,
        plugin,
      })
    );
  });
});
