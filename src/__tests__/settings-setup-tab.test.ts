/** @jest-environment jsdom */

import { displaySetupTabContent } from "../settings/SetupTabContent";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App } from "obsidian";

jest.mock("../services/providers/LocalLLMScanner", () => ({
  scanLocalLLMProviders: jest.fn().mockResolvedValue([]),
}));

jest.mock("../modals/CustomProviderModal", () => ({
  showCustomProviderModal: jest.fn().mockResolvedValue(null),
}));

var getCreditsBalanceMock: jest.Mock;
jest.mock("../services/SystemSculptService", () => {
  getCreditsBalanceMock = jest.fn();
  return {
    SystemSculptService: {
      getInstance: jest.fn(() => ({
        getCreditsBalance: getCreditsBalanceMock,
      })),
    },
  };
});

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
    openCreditsBalanceModal: jest.fn().mockResolvedValue(undefined),
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
    getCreditsBalanceMock.mockResolvedValue({
      totalRemaining: 2500,
      includedRemaining: 1200,
      includedPerMonth: 2000,
      addOnRemaining: 1300,
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      purchaseUrl: "https://systemsculpt.com/resources?tab=license",
    });
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

  it("opens credits details from setup when pro is active", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-test";

    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await Promise.resolve();

    const detailsButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Details");

    expect(detailsButton).toBeTruthy();
    (detailsButton as HTMLButtonElement).click();

    expect(plugin.openCreditsBalanceModal).toHaveBeenCalledTimes(1);
  });
});
