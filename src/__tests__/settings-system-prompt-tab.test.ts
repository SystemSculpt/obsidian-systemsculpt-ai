/** @jest-environment jsdom */

import { displaySystemPromptSettingsTabContent } from "../settings/SystemPromptSettingsTabContent";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App } from "obsidian";

const createPluginStub = () => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  return {
    manifest: { version: "1.0.0" },
    settings: {
      settingsMode: "standard",
      systemPromptType: "general-use",
      systemPromptPath: "",
      systemPrompt: "",
      titleGenerationPromptType: "precise",
      titleGenerationPromptPath: "",
      postProcessingPromptType: "preset",
      postProcessingPromptFilePath: "",
      postProcessingPromptPresetId: "default",
      systemPromptsDirectory: "SystemSculpt/System Prompts",
    },
    getSettingsManager: jest.fn(() => settingsManager),
    emitter: {
      emit: jest.fn(),
    },
  } as any;
};

describe("System prompt tab native layout", () => {
  let app: App;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    app = new App();
  });

  it("renders prompt controls without legacy cards", async () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    await displaySystemPromptSettingsTabContent(container, tab);

    expect(container.querySelectorAll('.setting-item').length).toBeGreaterThan(0);
    expect(container.querySelector('.systemsculpt-model-card')).toBeNull();
    expect(container.querySelector("button")).not.toBeNull();
  });
});
