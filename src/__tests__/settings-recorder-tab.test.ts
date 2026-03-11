/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayRecorderTabContent } from "../settings/RecorderTabContent";

jest.mock("../services/PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      isMobile: jest.fn(() => false),
    })),
  },
}));

describe("Recorder settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(global.navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: jest.fn().mockResolvedValue([]),
        getUserMedia: jest.fn().mockResolvedValue({
          getTracks: () => [{ stop: jest.fn() }],
        }),
      },
    });
  });

  it("locks transcription to SystemSculpt without custom-provider controls", async () => {
    const app = new App();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const plugin: any = {
      app,
      settings: {
        autoTranscribeRecordings: false,
        autoPasteTranscription: false,
        keepRecordingsAfterTranscription: true,
        cleanTranscriptionOutput: true,
        autoSubmitAfterTranscription: false,
        postProcessingEnabled: false,
        transcriptionProvider: "custom",
        transcriptionOutputFormat: "markdown",
        showTranscriptionFormatChooserInModal: true,
        enableAutoAudioResampling: true,
        preferredMicrophoneId: "default",
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings,
      })),
    };

    const container = document.createElement("div");
    const tab: any = {
      app,
      plugin,
      display: jest.fn(),
    };

    await displayRecorderTabContent(container, tab);

    const text = container.textContent || "";
    const names = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );

    expect(text).toContain("transcribe through SystemSculpt");
    expect(names).toContain("Transcription execution");
    expect(text).toContain("SystemSculpt clean-up");
    expect(text).not.toContain("post-processing prompt");
    expect(names).not.toContain("Transcription provider");
    expect(text).not.toContain("Custom endpoint URL");
    expect(text).not.toContain("API key");
    expect(text).not.toContain("Model name");
    expect(text).not.toContain("Groq");
    expect(text).not.toContain("OpenAI");
    expect(text).not.toContain("Local");
    expect(names).toContain("Automatic audio format conversion");
  });
});
