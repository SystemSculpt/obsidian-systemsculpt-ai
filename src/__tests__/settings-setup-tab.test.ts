/** @jest-environment jsdom */

import { displaySetupTabContent } from "../settings/SetupTabContent";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App } from "obsidian";

jest.mock("../services/SystemSculptService", () => ({
  SystemSculptService: {
    getInstance: jest.fn(() => ({})),
  },
}));

jest.mock("../services/providers/LocalLLMScanner", () => ({
  scanLocalLLMProviders: jest.fn().mockResolvedValue([]),
}));

jest.mock("../modals/CustomProviderModal", () => ({
  showCustomProviderModal: jest.fn().mockResolvedValue(null),
}));

const createPluginStub = () => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  const licenseManager = {
    validateLicenseKey: jest.fn().mockResolvedValue(true),
  };

  const systemSculptService = {};

  return {
    manifest: { version: "1.0.0" },
    settings: {
      settingsMode: "standard",
      licenseValid: false,
      licenseKey: "",
      customProviders: [],
      enableSystemSculptProvider: false,
      useSystemSculptAsFallback: false,
      systemPromptsDirectory: "SystemSculpt/System Prompts",
    },
    getSettingsManager: jest.fn(() => settingsManager),
    getLicenseManager: jest.fn(() => licenseManager),
    systemSculptService,
    customProviderService: {
      clearCache: jest.fn(),
      testConnection: jest.fn().mockResolvedValue({ success: true, models: [] }),
    },
    modelService: {
      refreshModels: jest.fn().mockResolvedValue(undefined),
      getModels: jest.fn().mockResolvedValue([]),
    },
  } as any;
};

describe("Setup tab native layout", () => {
  let app: App;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    app = new App();
  });

  it("renders only native setting items", () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, false);

    expect(container.querySelectorAll('.setting-item').length).toBeGreaterThan(0);
    expect(container.querySelector('.systemsculpt-pro-promotion-redesigned')).toBeNull();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector('.ss-help-link')).not.toBeNull();
  });
});
