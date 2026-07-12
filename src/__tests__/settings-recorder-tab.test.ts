/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayRecorderTabContent } from "../settings/RecorderTabContent";

jest.mock("../services/PlatformContext", () => ({
  PlatformContext: { get: jest.fn(() => ({ isMobile: jest.fn(() => false) })) },
}));

describe("Recorder settings tab", () => {
  it("offers local recorder/output controls without provider, endpoint, key, or model configuration", async () => {
    Object.defineProperty(global.navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: jest.fn().mockResolvedValue([]),
        getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop: jest.fn() }] }),
      },
    });
    const app = new App();
    const plugin = {
      app,
      settings: {
        autoTranscribeRecordings: false,
        autoPasteTranscription: false,
        keepRecordingsAfterTranscription: true,
        cleanTranscriptionOutput: true,
        autoSubmitAfterTranscription: false,
        postProcessingEnabled: false,
        postProcessingPrompt: "Clean it up",
        transcriptionOutputFormat: "markdown",
        showTranscriptionFormatChooserInModal: true,
        enableAutoAudioResampling: true,
        preferredMicrophoneId: "default",
      },
      getSettingsManager: jest.fn(() => ({ updateSettings: jest.fn() })),
    } as any;
    const container = document.createElement("div");

    await displayRecorderTabContent(container, { app, plugin } as any);

    const names = [...container.querySelectorAll(".setting-item-name")].map((element) => element.textContent?.trim());
    expect(names).toContain("Auto-transcribe recordings");
    expect(names).toContain("Default transcription output format");
    expect(names).not.toContain("Transcription provider");
    expect(names).not.toContain("Custom endpoint URL");
    expect(names).not.toContain("API key");
    expect(names).not.toContain("Model name");
    expect(names).not.toContain("Post-processing model");
  });
});
