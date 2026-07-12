/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { AudioTranscriptionModal } from "../AudioTranscriptionModal";

const start = jest.fn();
const abort = jest.fn();

jest.mock("../../services/transcription/TranscriptionCoordinator", () => ({
  TranscriptionCoordinator: jest.fn().mockImplementation(() => ({ start, abort })),
}));

jest.mock("../../utils/clipboard", () => ({ tryCopyToClipboard: jest.fn(async () => true) }));

function createModal() {
  const app = new App();
  const file = new TFile({ path: "Recordings/test.wav", name: "test.wav", stat: { size: 1234 } });
  const plugin = { app, settings: {}, register: jest.fn() } as any;
  return { modal: new AudioTranscriptionModal(app, { file, timestamped: true, isChat: false, plugin }), plugin };
}

describe("AudioTranscriptionModal", () => {
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
    const { modal } = createModal();
    modal.open();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "Recordings/test.wav",
      timestamped: true,
      useModal: false,
    }));
    expect(document.querySelector(".systemsculpt-progress-status-text")?.textContent).toContain("Transcription complete");
    expect(document.body.textContent).toContain("Saved to Recordings/test.srt");
  });

  it("treats Hide as presentation detachment, not cancellation", () => {
    const { modal } = createModal();
    modal.open();
    const hide = [...document.querySelectorAll("button")].find((button) => button.textContent === "Hide") as HTMLButtonElement;
    hide.click();
    expect(abort).not.toHaveBeenCalled();
  });

  it("only explicit Cancel aborts the managed operation", () => {
    const { modal } = createModal();
    modal.open();
    const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent === "Cancel") as HTMLButtonElement;
    cancel.click();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("aborts before detaching when the plugin unloads", () => {
    const { modal, plugin } = createModal();
    modal.open();
    const unload = plugin.register.mock.calls[0][0];
    unload();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".systemsculpt-progress-modal")).toBeNull();
  });
});
