/** @jest-environment jsdom */

import { displaySetupTabContent } from "../settings/SetupTabContent";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App } from "obsidian";

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
    openCreditsBalanceModal: jest.fn().mockResolvedValue(undefined),
    modelService: {
      refreshModels: jest.fn().mockResolvedValue(undefined),
    },
  } as any;
};

async function flushSetupSectionRender(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("Setup tab SystemSculpt-only layout", () => {
  let app: App;
  let windowOpenSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    app = new App();
    windowOpenSpy = jest.spyOn(window, "open").mockImplementation(() => null);
    getCreditsBalanceMock.mockResolvedValue({
      totalRemaining: 2500,
      includedRemaining: 1200,
      includedPerMonth: 2000,
      addOnRemaining: 1300,
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      purchaseUrl: "https://systemsculpt.com/resources?tab=license",
      billingCycle: "monthly",
      annualUpgradeOffer: {
        amountSavedCents: 12900,
        percentSaved: 57,
        annualPriceCents: 9900,
        monthlyEquivalentAnnualCents: 22800,
        checkoutUrl: "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
      },
    });
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
  });

  it("renders account, license, and help surfaces without local Pi setup", () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, false);

    expect(container.querySelectorAll(".setting-item").length).toBeGreaterThan(0);
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelector(".ss-help-link")).not.toBeNull();
    expect(container.textContent).toContain("Account & License");
    expect(container.textContent).toContain("Help & resources");
    expect(container.textContent).not.toContain("Release notes");
    expect(container.textContent).not.toContain("View changelog");
    expect(container.textContent).not.toContain("Pi Providers & Auth");
    expect(container.querySelector(".ss-setup-pi-auth-list")).toBeNull();
  });

  it("opens credits details from setup when pro is active", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-test";

    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    const detailsButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Details"
    );

    expect(detailsButton).toBeTruthy();
    (detailsButton as HTMLButtonElement).click();

    expect(plugin.openCreditsBalanceModal).toHaveBeenCalledTimes(1);
  });

  it("opens annual checkout upsell when monthly savings is available", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-test";

    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    const annualSwitchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Switch to annual"
    );

    expect(annualSwitchButton).toBeTruthy();
    (annualSwitchButton as HTMLButtonElement).click();

    expect(window.open).toHaveBeenCalledWith(
      "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
      "_blank"
    );
  });
});
