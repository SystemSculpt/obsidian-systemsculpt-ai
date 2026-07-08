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

function createPlugin(settingsOverrides: Record<string, unknown> = {}) {
  const app = new App();
  let plugin: any;
  // Merge patches into plugin.settings so a re-render reflects the change,
  // mirroring the real SettingsManager.
  const updateSettings = jest.fn(async (patch: Record<string, unknown>) => {
    Object.assign(plugin.settings, patch ?? {});
  });
  plugin = {
    app,
    settings: {
      autoTranscribeRecordings: false,
      autoPasteTranscription: false,
      keepRecordingsAfterTranscription: true,
      cleanTranscriptionOutput: true,
      autoSubmitAfterTranscription: false,
      postProcessingEnabled: false,
      postProcessingPrompt: "Custom cleanup instructions",
      transcriptionProvider: "systemsculpt",
      customTranscriptionEndpoint: "",
      customTranscriptionApiKey: "",
      customTranscriptionModel: "",
      transcriptionOutputFormat: "markdown",
      showTranscriptionFormatChooserInModal: true,
      enableAutoAudioResampling: true,
      preferredMicrophoneId: "default",
      ...settingsOverrides,
    },
    getSettingsManager: jest.fn(() => ({ updateSettings })),
  };
  return { app, plugin, updateSettings };
}

function render(plugin: any) {
  const container = document.createElement("div");
  const tab: any = { app: plugin.app, plugin, display: jest.fn() };
  return { container, tab };
}

describe("Recorder settings tab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(global.navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: jest.fn().mockResolvedValue([]),
        getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop: jest.fn() }] }),
      },
    });
  });

  it("offers a transcription provider choice and hides custom controls on SystemSculpt", async () => {
    const { plugin } = createPlugin({ transcriptionProvider: "systemsculpt" });
    const { container, tab } = render(plugin);

    await displayRecorderTabContent(container, tab);

    const names = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );
    // The provider is now configurable...
    expect(names).toContain("Transcription provider");
    // ...but custom-endpoint controls stay hidden until "custom" is chosen.
    expect(names).not.toContain("Custom endpoint URL");
    expect(names).not.toContain("API key");
    expect(names).not.toContain("Model name");
    // Unrelated recorder settings remain.
    expect(names).toContain("Transcription clean-up prompt");
    expect(names).toContain("Automatic audio format conversion");
  });

  it("reveals the self-hosted Whisper controls + validation when provider is custom", async () => {
    const { plugin } = createPlugin({
      transcriptionProvider: "custom",
      customTranscriptionEndpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      customTranscriptionApiKey: "gsk_test",
      customTranscriptionModel: "whisper-large-v3",
    });
    const { container, tab } = render(plugin);

    await displayRecorderTabContent(container, tab);

    const text = container.textContent || "";
    const names = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );
    expect(names).toContain("Transcription provider");
    expect(names).toContain("Custom endpoint URL");
    expect(names).toContain("API key");
    expect(names).toContain("Model name");
    // The documented contract is surfaced to the user.
    expect(text).toContain("multipart/form-data");
    // A fully-configured endpoint validates as compatible.
    expect(text).toContain("Endpoint looks compatible");
  });

  it("surfaces a config-time error when the custom endpoint is missing", async () => {
    const { plugin } = createPlugin({
      transcriptionProvider: "custom",
      customTranscriptionEndpoint: "",
    });
    const { container, tab } = render(plugin);

    await displayRecorderTabContent(container, tab);

    const errorNote = container.querySelector(".ss-inline-note--error")?.textContent || "";
    expect(errorNote).toMatch(/required/i);
  });

  it("switches to custom and reveals the controls when the provider dropdown changes", async () => {
    const { plugin, updateSettings } = createPlugin({ transcriptionProvider: "systemsculpt" });
    const { container, tab } = render(plugin);

    await displayRecorderTabContent(container, tab);

    const namesBefore = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );
    expect(namesBefore).not.toContain("Custom endpoint URL");

    // The provider <select> is the only one carrying a "systemsculpt" option.
    const providerSelect = Array.from(container.querySelectorAll("select")).find((select) =>
      Array.from(select.querySelectorAll("option")).some(
        (opt) => (opt as HTMLOptionElement).value === "systemsculpt"
      )
    ) as HTMLSelectElement | undefined;
    expect(providerSelect).toBeTruthy();

    providerSelect!.value = "custom";
    providerSelect!.dispatchEvent(new Event("change"));

    // Drain the async onChange (persist + re-render + mic enumerate).
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updateSettings).toHaveBeenCalledWith({ transcriptionProvider: "custom" });
    const namesAfter = Array.from(container.querySelectorAll(".setting-item-name")).map((el) =>
      el.textContent?.trim()
    );
    expect(namesAfter).toContain("Custom endpoint URL");
    expect(namesAfter).toContain("Model name");
  });
});
