import { App, TFile } from "obsidian";
import { FileContextMenuService } from "../FileContextMenuService";
import { showAudioTranscriptionModal } from "../../modals/AudioTranscriptionModal";

jest.mock("../../modals/AudioTranscriptionModal", () => ({
  showAudioTranscriptionModal: jest.fn(),
}));

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe("FileContextMenuService", () => {
  it("uses markdown mode for Convert Audio to Markdown flow", async () => {
    const app = new App() as any;
    app.workspace.layoutReady = true;
    app.workspace.on = jest.fn(() => ({ id: "evt-ref" }));

    const plugin = {
      settings: {
        licenseKey: "test-license",
        licenseValid: true,
      },
      register: jest.fn(),
      registerEvent: jest.fn(),
      getPluginLogger: jest.fn(() => null),
    } as any;

    const service = new FileContextMenuService({
      app,
      plugin,
      documentProcessor: {
        processDocument: jest.fn(),
      },
      chatLauncher: {
        open: jest.fn(),
      },
      launchProcessingModal: jest.fn() as any,
    });

    const audioFile = new TFile({
      path: "SystemSculpt/Recordings/test-audio.webm",
      name: "test-audio.webm",
      extension: "webm",
    });

    await (service as any).handleAudioConversion(audioFile);

    expect(showAudioTranscriptionModal).toHaveBeenCalledTimes(1);
    expect(showAudioTranscriptionModal).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        file: audioFile,
        timestamped: false,
        plugin,
      })
    );
  });
});
