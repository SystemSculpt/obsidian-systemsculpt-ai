/** @jest-environment jsdom */

import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App } from "obsidian";
import { buildSettingsTabConfigs } from "../settings/SettingsTabRegistry";

jest.mock("../settings/SettingsTabRegistry", () => ({
  buildSettingsTabConfigs: jest.fn(() => [
    {
      id: "account",
      label: "Account",
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
    checkVersion: jest.fn().mockResolvedValue({
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      isLatest: true,
      releaseUrl: "https://example.com/release",
      updateUrl: "https://example.com/update",
    }),
  };

  return {
    manifest: { version: "1.2.3" },
    settings: {
      settingsMode: "standard",
      licenseValid: false,
      customProviders: [],
      activeProvider: null,
      selectedModelId: "",
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
    (buildSettingsTabConfigs as jest.Mock).mockReturnValue([
      {
        id: "account",
        label: "Account",
        sections: [
          (parent: HTMLElement) => {
            parent.createDiv({ cls: "setting-item" });
          },
        ],
      },
    ]);
    app = new App();
    if (!(app.workspace as any).offref) {
      Object.defineProperty(app.workspace, "offref", {
        value: jest.fn(),
        writable: true,
      });
    }
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

  it("describes the plugin as a SystemSculpt client instead of a provider shell", async () => {
    const tab = await renderTab();
    const text = tab.containerEl.textContent || "";
    expect(text).toContain("Manage your SystemSculpt account");
    expect(text).not.toContain("Configure AI models");
  });

  it("shows plugin version inline with the title instead of as its own settings row", async () => {
    const tab = await renderTab();
    const titleRow = tab.containerEl.querySelector(".ss-settings-title-row");
    const title = titleRow?.querySelector("h2");
    const versionPill = titleRow?.querySelector(".ss-version-pill");
    const refreshButton = titleRow?.querySelector(
      'button[aria-label="Check for updates"]'
    ) as HTMLButtonElement | null;

    expect(title?.textContent).toBe("SystemSculpt AI");
    expect(versionPill?.textContent).toContain("v1.2.3");
    expect(refreshButton).not.toBeNull();
    expect(
      Array.from(tab.containerEl.querySelectorAll(".setting-item-name")).some(
        (el) => el.textContent?.trim() === "Plugin version"
      )
    ).toBe(false);
  });

  it("does not render the legacy settings mode control", async () => {
    const tab = await renderTab();
    const text = tab.containerEl.textContent || "";

    expect(text).not.toContain("Settings mode");
    expect(Array.from(tab.containerEl.querySelectorAll(".setting-item-name")).some((el) => el.textContent?.trim() === "Settings mode")).toBe(false);
  });

  it("keeps quick actions out of the top-level settings shell", async () => {
    const tab = await renderTab();
    expect(Array.from(tab.containerEl.querySelectorAll(".setting-item-name")).some((el) => el.textContent?.trim() === "Quick actions")).toBe(false);
  });

  it("builds feedback payloads around SystemSculpt access instead of provider choices", () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "license_test";
    plugin.settings.selectedModelId = "openai@@gpt-4.1";
    plugin.settings.customProviders = [{ name: "Legacy Provider", isEnabled: true }];

    const tab = new SystemSculptSettingTab(app, plugin);
    const url = (tab as any).generateFeedbackUrl();
    const body = decodeURIComponent(url.split("&body=")[1] || "");

    expect(body).toContain("SystemSculpt access: Active");
    expect(body).not.toContain("AI Provider:");
    expect(body).not.toContain("AI Model:");
    expect(body).not.toContain("Custom providers enabled:");
  });

  it("preserves active tab across settings rerenders", async () => {
    (buildSettingsTabConfigs as jest.Mock).mockReturnValue([
      {
        id: "account",
        label: "Account",
        sections: [
          (parent: HTMLElement) => {
            parent.createDiv({ cls: "setting-item", text: "Account item" });
          },
        ],
      },
      {
        id: "knowledge",
        label: "Knowledge",
        sections: [
          (parent: HTMLElement) => {
            parent.createDiv({ cls: "setting-item", text: "Knowledge item" });
          },
        ],
      },
    ]);

    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    await tab.display();

    const knowledgeButton = tab.containerEl.querySelector('button[data-tab="knowledge"]') as HTMLElement | null;
    expect(knowledgeButton).not.toBeNull();
    knowledgeButton?.click();

    await tab.display();

    const knowledgeButtonAfter = tab.containerEl.querySelector('button[data-tab="knowledge"]') as HTMLElement | null;
    const knowledgePanelAfter = tab.containerEl.querySelector(
      '.systemsculpt-tab-content[data-tab="knowledge"]'
    ) as HTMLElement | null;

    expect(knowledgeButtonAfter?.classList.contains("mod-active")).toBe(true);
    expect(knowledgePanelAfter?.classList.contains("is-active")).toBe(true);
  });
});
