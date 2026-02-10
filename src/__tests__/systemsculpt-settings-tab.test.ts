/** @jest-environment jsdom */

import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App } from "obsidian";

jest.mock("../settings/SettingsTabRegistry", () => ({
  buildSettingsTabConfigs: jest.fn(() => [
    {
      id: "overview",
      label: "Overview",
      sections: [
        (parent: HTMLElement) => {
          parent.createDiv({ cls: "setting-item" });
        },
      ],
    },
  ]),
}));

jest.mock("../core/ui", () => ({
  showPopup: jest.fn(),
}));

const createPluginStub = () => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  const versionChecker = {
    checkVersion: jest.fn().mockResolvedValue({ latestVersion: "1.2.3", isUpToDate: true }),
  };

  return {
    manifest: { version: "1.2.3" },
    settings: {
      settingsMode: "standard",
      licenseValid: false,
      customProviders: [],
      activeProvider: null,
      selectedProvider: "",
      selectedModelId: "",
      selectedModelProviders: [],
      systemPromptType: "general-use",
      systemPromptPath: "",
      systemPrompt: "",
      titleGenerationPromptType: "precise",
      titleGenerationPromptPath: "",
      postProcessingPromptType: "summary",
      postProcessingPromptFilePath: "",
      embeddingsEnabled: false,
      enableSystemSculptProvider: false,
      useSystemSculptAsFallback: false,
      chatsDirectory: "",
      savedChatsDirectory: "",
      attachmentsDirectory: "",
      extractionsDirectory: "",
      systemPromptsDirectory: "",
      showUpdateNotifications: true,
      debugMode: false,
      useLatestModelEverywhere: true,
      useLatestSystemPromptForNewChats: true,
      licenseKey: "",
      subscriptionStatus: "",
    },
    getSettingsManager: jest.fn(() => settingsManager),
    getVersionCheckerService: jest.fn(() => versionChecker),
    getSettingsManagerInstance: settingsManager,
    getVersionCheckerInstance: versionChecker,
    emitter: {
      on: jest.fn(),
      off: jest.fn(),
      emit: jest.fn(),
    },
    modelService: {
      getModels: jest.fn().mockResolvedValue([]),
      refreshModels: jest.fn(),
    },
    customProviderService: {
      clearCache: jest.fn(),
    },
    getVersionChecker() {
      return versionChecker;
    },
  } as any;
};

describe("SystemSculptSettingTab native layout", () => {
  let app: App;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    app = new App();
  });

  const renderTab = async () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    await tab.display();
    return tab;
  };

  it("does not inject legacy style tag", async () => {
    await renderTab();
    expect(document.getElementById("systemsculpt-settings-styles")).toBeNull();
  });

  it("renders search input with native styling", async () => {
    const tab = await renderTab();
    const searchInput = tab.containerEl.querySelector("input[type='search']");
    expect(searchInput).not.toBeNull();
    expect(searchInput!.classList.contains("search-input")).toBe(true);
    expect(searchInput!.classList.contains("systemsculpt-settings-search-input")).toBe(false);
  });

  it("uses streamlined tab bar classes", async () => {
    const tab = await renderTab();
    expect(tab.containerEl.querySelector(".systemsculpt-settings-tabs")).toBeNull();
    expect(tab.containerEl.querySelector(".ss-settings-tab-bar")).not.toBeNull();
  });
});
