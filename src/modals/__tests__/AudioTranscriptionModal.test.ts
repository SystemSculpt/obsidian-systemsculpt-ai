/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { AudioTranscriptionModal } from "../AudioTranscriptionModal";

const mockTranscribeFile = jest.fn();
const mockProcessTranscription = jest.fn(async (text: string) => text);
const mockTryCopyToClipboard = jest.fn(async () => true);

jest.mock("../../services/TranscriptionService", () => ({
  TranscriptionService: {
    getInstance: jest.fn(() => ({
      transcribeFile: mockTranscribeFile,
    })),
  },
}));

jest.mock("../../services/PostProcessingService", () => ({
  PostProcessingService: {
    getInstance: jest.fn(() => ({
      processTranscription: mockProcessTranscription,
    })),
  },
}));

jest.mock("../../services/transcription/TranscriptionTitleService", () => ({
  TranscriptionTitleService: {
    getInstance: jest.fn(() => ({
      buildFallbackBasename: jest.fn((name: string) => `${name}-transcription`),
      tryRenameTranscriptionFile: jest.fn(async (_app: any, file: any) => file.path),
    })),
  },
}));

jest.mock("../../utils/clipboard", () => ({
  tryCopyToClipboard: (...args: any[]) => mockTryCopyToClipboard(...args),
}));

describe("AudioTranscriptionModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mockTranscribeFile.mockReset();
    mockProcessTranscription.mockClear();
    mockTryCopyToClipboard.mockClear();
  });

  it("renders progress UI and writes timestamped transcriptions as .srt", async () => {
    const app = new App();
    const file = new TFile({
      path: "Recordings/test.wav",
      name: "test.wav",
      stat: { size: 1234 },
    });

    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(null);
    (app.vault.modify as jest.Mock).mockImplementation(async () => {});
    (app.vault.create as jest.Mock).mockImplementation(async (path: string) => {
      return new TFile({ path, name: path.split("/").pop() ?? path });
    });

    mockTranscribeFile.mockImplementation(async (_tFile: any, ctx: any) => {
      ctx?.onProgress?.(2, "Preparing upload...");
      ctx?.onProgress?.(50, "Uploading audio (1/2)...");
      ctx?.onProgress?.(75, "Chunking audio...");
      return "00:00:00,000 --> 00:00:01,000\nhello world";
    });

    const plugin = {
      app,
      settings: {
        postProcessingEnabled: true, // should be ignored for timestamped mode
        cleanTranscriptionOutput: false,
        keepRecordingsAfterTranscription: true,
        autoPasteTranscription: false,
      },
      register: jest.fn(),
    } as any;

    const modal = new AudioTranscriptionModal(app, {
      file,
      timestamped: true,
      isChat: false,
      plugin,
      onTranscriptionComplete: jest.fn(),
    });

    modal.open();

    expect(document.querySelector(".systemsculpt-progress-modal")).toBeTruthy();

    const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("Timed out waiting for condition");
    };

    await waitFor(() => {
      const statusText = document.querySelector(".systemsculpt-progress-status-text")?.textContent ?? "";
      return statusText.includes("Transcription complete");
    }, 1000);

    const statusText = document.querySelector(".systemsculpt-progress-status-text")?.textContent ?? "";
    expect(statusText).toContain("Transcription complete");

    expect(app.vault.create).toHaveBeenCalled();
    const createdPath = (app.vault.create as jest.Mock).mock.calls[0]?.[0];
    expect(String(createdPath)).toMatch(/\.srt$/);

    expect(mockProcessTranscription).not.toHaveBeenCalled();
  });
});
