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
      purchaseUrl: "https://systemsculpt.com/pricing",
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
    expect(container.textContent).toContain("Account & license");
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

  it("never renders or copies the saved license and exposes canonical legal links", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-saved-secret";
    const clipboardWrite = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });

    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    const licenseInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(licenseInput).not.toBeNull();
    expect(licenseInput?.value).toBe("");
    licenseInput?.focus();
    expect(licenseInput?.type).toBe("password");
    expect(container.innerHTML).not.toContain("skss-saved-secret");
    expect(Array.from(container.querySelectorAll("button")).some((button) =>
      `${button.textContent} ${button.getAttribute("aria-label")} ${button.getAttribute("title")}`.includes("Copy license key")
    )).toBe(false);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://systemsculpt.com/terms"]')?.textContent).toBe("Terms");
    expect(container.querySelector<HTMLAnchorElement>('a[href="https://systemsculpt.com/privacy"]')?.textContent).toBe("Privacy");
  });

  it("replaces a saved license only on an explicit keyboard action", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-saved-secret";
    const tab = new SystemSculptSettingTab(app, plugin);
    tab.display = jest.fn();
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, true);

    const licenseInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    licenseInput.value = "skss-replacement";
    licenseInput.dispatchEvent(new Event("change", { bubbles: true }));
    expect(plugin.getSettingsManager().updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ licenseKey: "skss-replacement" })
    );

    licenseInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    licenseInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushSetupSectionRender();
    expect(plugin.getSettingsManager().updateSettings).toHaveBeenCalledWith({ licenseKey: "skss-replacement" });
    expect(plugin.getSettingsManager().updateSettings).toHaveBeenCalledTimes(1);
    expect(plugin.getLicenseManager().validateLicenseKey).toHaveBeenCalledWith(true, false);
  });

  it.each(["returns false", "throws"])(
    "restores the prior key and entitlement flags when replacement validation %s",
    async (failureMode) => {
      const plugin = createPluginStub();
      plugin.settings.licenseValid = true;
      plugin.settings.licenseKey = "skss-still-valid";
      plugin.settings.enableSystemSculptProvider = true;
      plugin.settings.useSystemSculptAsFallback = true;
      if (failureMode === "throws") {
        plugin.getLicenseManager().validateLicenseKey.mockRejectedValue(new Error("upstream failure"));
      } else {
        plugin.getLicenseManager().validateLicenseKey.mockResolvedValue(false);
      }
      const tab = new SystemSculptSettingTab(app, plugin);
      tab.display = jest.fn();
      const container = document.createElement("div");
      displaySetupTabContent(container, tab, true);

      const licenseInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
      licenseInput.value = "skss-invalid-replacement";
      licenseInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await flushSetupSectionRender();

      expect(plugin.getSettingsManager().updateSettings).toHaveBeenNthCalledWith(1, {
        licenseKey: "skss-invalid-replacement",
      });
      expect(plugin.getSettingsManager().updateSettings).toHaveBeenLastCalledWith({
        licenseKey: "skss-still-valid",
        licenseValid: true,
      });
      expect(licenseInput.value).toBe("");
      expect(container.innerHTML).not.toContain("skss-still-valid");
      expect(container.innerHTML).not.toContain("skss-invalid-replacement");
    },
  );

  it("deactivates durably by clearing the stored license and account identity", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-saved-secret";
    const tab = new SystemSculptSettingTab(app, plugin);
    tab.display = jest.fn();
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, true);

    const deactivate = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Deactivate"
    ) as HTMLButtonElement;
    deactivate.click();
    await flushSetupSectionRender();
    expect(plugin.getSettingsManager().updateSettings).toHaveBeenCalledWith({
      licenseKey: "",
      licenseValid: false,
      userEmail: "",
      userName: "",
      displayName: "",
      subscriptionStatus: "",
      lastValidated: 0,
    });
    expect(container.innerHTML).not.toContain("skss-saved-secret");
  });

  it("uses bounded first-party copy when license validation throws", async () => {
    const plugin = createPluginStub();
    plugin.getLicenseManager().validateLicenseKey.mockRejectedValue(
      new Error("upstream leaked skss-secret and request details")
    );
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const tab = new SystemSculptSettingTab(app, plugin);
    tab.display = jest.fn();
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, false);

    const licenseInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    licenseInput.value = "skss-secret";
    licenseInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushSetupSectionRender();

    const notices = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(notices).toContain("Unable to validate license. Try again.");
    expect(notices).not.toContain("upstream leaked");
    expect(notices).not.toContain("skss-secret");
    log.mockRestore();
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
      "_blank",
      "noopener,noreferrer",
    );
  });
});
