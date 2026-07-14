/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { AudioTranscriptionPanel } from "../AudioTranscriptionPanel";

const start = jest.fn();
const abort = jest.fn();

jest.mock("../../services/transcription/TranscriptionCoordinator", () => ({
  TranscriptionCoordinator: jest.fn().mockImplementation(() => ({ start, abort })),
}));

jest.mock("../../utils/clipboard", () => ({ tryCopyToClipboard: jest.fn(async () => true) }));

function createPanel() {
  const app = new App();
  const file = new TFile({ path: "Recordings/test.wav", name: "test.wav", stat: { size: 1234 } });
  const plugin = { app, settings: {}, register: jest.fn() } as any;
  return { panel: new AudioTranscriptionPanel(app, { file, timestamped: true, isChat: false, plugin }), plugin };
}

describe("AudioTranscriptionPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();
    start.mockImplementation(async (request: any) => {
      request.onProgress?.(50, "Uploading audio (1/2)…");
      request.onOutput?.("Recordings/test.srt");
      request.onTranscriptionComplete?.("managed transcript");
      return "managed transcript";
    });
  });

  it("renders the managed operation and preserves the timestamped output path", async () => {
    const { panel } = createPanel();
    panel.open();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "Recordings/test.wav",
      timestamped: true,
    }));
    const statusTexts = document.querySelectorAll(".systemsculpt-progress-status-text");
    expect(statusTexts[statusTexts.length - 1]?.textContent).toContain("Transcription complete");
    expect(document.body.textContent).toContain("Saved to Recordings/test.srt");
  });

  it("treats Hide as presentation detachment, not cancellation", () => {
    const { panel } = createPanel();
    panel.open();
    const hide = [...document.querySelectorAll("button")].find((button) => button.textContent === "Hide") as HTMLButtonElement;
    hide.click();
    expect(abort).not.toHaveBeenCalled();
  });

  it("only explicit Cancel aborts the managed operation", () => {
    const { panel } = createPanel();
    panel.open();
    const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel") as HTMLButtonElement;
    cancel.click();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts before detaching when the plugin unloads", () => {
    const { panel, plugin } = createPanel();
    panel.open();
    const unload = plugin.register.mock.calls[0][0];
    unload();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".systemsculpt-progress-panel")).toBeNull();
  });
});
