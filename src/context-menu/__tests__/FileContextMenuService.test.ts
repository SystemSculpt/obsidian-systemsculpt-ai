import { App, TFile } from "obsidian";
import { FileContextMenuService } from "../FileContextMenuService";
import { launchAudioTranscriptionPanel } from "../../modals/AudioTranscriptionPanel";

jest.mock("../../modals/AudioTranscriptionPanel", () => ({
  launchAudioTranscriptionPanel: jest.fn(),
}));

jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

describe("FileContextMenuService", () => {
  it("owns one conversion-scoped AbortController and suppresses late success after cancel", async () => {
    const app = new App() as any;
    app.workspace.layoutReady = true;
    app.workspace.on = jest.fn(() => ({ id: "evt-ref" }));
    const plugin = { settings: { licenseKey: "test", licenseValid: true }, register: jest.fn(), registerEvent: jest.fn(), getPluginLogger: jest.fn(() => null) } as any;
    let resolveProcessing!: (path: string) => void;
    const processDocument = jest.fn((_file, options) => new Promise<string>((resolve) => {
      resolveProcessing = resolve;
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }));
    let cancel!: () => void;
    const panel = { updateProgress: jest.fn(), markSuccess: jest.fn(), markFailure: jest.fn(), close: jest.fn() };
    const service = new FileContextMenuService({
      app, plugin, documentProcessor: { processDocument }, chatLauncher: { open: jest.fn() },
      launchProcessingPanel: jest.fn((options) => { cancel = options.onCancel!; return panel; }),
    });
    const file = new TFile({ path: "document.pdf", name: "document.pdf", extension: "pdf" });

    const pending = (service as any).handleDocumentConversion(file);
    const signal = processDocument.mock.calls[0][1].signal as AbortSignal;
    cancel();
    expect(signal.aborted).toBe(true);
    resolveProcessing("output.md");
    await pending;

    expect(panel.markSuccess).not.toHaveBeenCalled();
    expect(panel.markFailure).not.toHaveBeenCalled();
  });

  it("suppresses late progress and success when cancelled during success effects", async () => {
    const app = new App() as any;
    app.workspace.layoutReady = true;
    app.workspace.on = jest.fn(() => ({ id: "evt-ref" }));
    const plugin = { settings: { licenseKey: "test", licenseValid: true }, register: jest.fn(), registerEvent: jest.fn(), getPluginLogger: jest.fn(() => null) } as any;
    let processingOptions: any;
    const processDocument = jest.fn(async (_file, options) => { processingOptions = options; return "output.md"; });
    let cancel!: () => void;
    let finishSuccess!: () => void;
    const panel = { updateProgress: jest.fn(), markSuccess: jest.fn(), markFailure: jest.fn(), close: jest.fn() };
    const service = new FileContextMenuService({
      app, plugin, documentProcessor: { processDocument }, chatLauncher: { open: jest.fn() },
      launchProcessingPanel: jest.fn((options) => { cancel = options.onCancel!; return panel; }),
    });
    jest.spyOn(service as any, "handleDocumentSuccess").mockImplementation(() => new Promise<void>((resolve) => { finishSuccess = resolve; }));
    const file = new TFile({ path: "document.pdf", name: "document.pdf", extension: "pdf" });

    const pending = (service as any).handleDocumentConversion(file);
    await Promise.resolve();
    await Promise.resolve();
    cancel();
    processingOptions.onProgress({ stage: "processing", progress: 50, label: "late" });
    finishSuccess();
    await pending;

    expect(panel.updateProgress).not.toHaveBeenCalled();
    expect(panel.markSuccess).not.toHaveBeenCalled();
    expect(panel.markFailure).not.toHaveBeenCalled();
  });

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
      launchProcessingPanel: jest.fn() as any,
    });

    const audioFile = new TFile({
      path: "SystemSculpt/Recordings/test-audio.webm",
      name: "test-audio.webm",
      extension: "webm",
    });

    await (service as any).handleAudioConversion(audioFile);

    expect(launchAudioTranscriptionPanel).toHaveBeenCalledTimes(1);
    expect(launchAudioTranscriptionPanel).toHaveBeenCalledWith(
      app,
      expect.objectContaining({
        file: audioFile,
        timestamped: false,
        plugin,
      })
    );
  });
});
