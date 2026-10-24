/** @jest-environment jsdom */

import { displaySetupTabContent } from "../settings/SetupTabContent";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App, Notice } from "obsidian";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return {
    ...actual,
    Notice: jest.fn(() => ({ hide: jest.fn() })),
  };
});

var getCreditsBalanceMock: jest.Mock;
jest.mock("../services/SystemSculptService", () => {
  getCreditsBalanceMock = jest.fn();
  return {
    SystemSculptService: {
      getInstance: jest.fn(() => ({
        readCreditsBalance: getCreditsBalanceMock,
      })),
    },
  };
});

const mockedNotice = Notice as unknown as jest.Mock;

const createPluginStub = () => {
  const settingsManager = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
  };

  const licenseManager = {
    validateLicenseKeyDetailed: jest.fn().mockResolvedValue({ outcome: "valid", isValid: true }),
  };

  const accountConnectService = {
    hasPendingRequest: jest.fn(() => false),
    cancelPending: jest.fn(),
    reopen: jest.fn().mockResolvedValue(true),
    begin: jest.fn().mockResolvedValue(undefined),
    submitManualCode: jest.fn().mockResolvedValue({ kind: "error", reason: "expired" }),
    pollInBackground: jest.fn(),
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
    getAccountConnectService: jest.fn(() => accountConnectService),
    accountConnectService,
    openCreditsBalanceModal: jest.fn().mockResolvedValue(undefined),
    embeddingsManager: {
      isSuspended: jest.fn(() => false),
      resumeProcessing: jest.fn(),
    },
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
  let anchorClickSpy: jest.SpyInstance;
  let anchorHrefs: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    app = new App();
    windowOpenSpy = jest.spyOn(window, "open").mockImplementation(() => null);
    // External opens click a synthetic anchor when Electron is unavailable.
    anchorHrefs = [];
    anchorClickSpy = jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        anchorHrefs.push(this.getAttribute("href") ?? "");
      });
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
        checkoutUrl: "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8&utm_source=obsidian-plugin&utm_medium=account&utm_campaign=upgrade",
      },
    });
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
    anchorClickSpy.mockRestore();
  });

  it("opens comparison pricing from View plans and billing from Manage account", () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, false);
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "View plans")!.click();
    expect(new URL(anchorHrefs[0]).pathname).toBe("/pricing");
    expect(new URL(anchorHrefs[0]).searchParams.get("utm_source")).toBe("obsidian-plugin");

    plugin.settings.licenseKey = "skss-test";
    plugin.settings.licenseValid = true;
    container.replaceChildren();
    displaySetupTabContent(container, tab, true);
    container.querySelector<HTMLElement>('[aria-label="Manage account"]')!.click();
    expect(new URL(anchorHrefs[1]).pathname).toBe("/dashboard/billing");
  });

  it("reopens the pending browser request from the manual-code fallback", async () => {
    const plugin = createPluginStub();
    plugin.accountConnectService.hasPendingRequest.mockReturnValue(true);
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, false);
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Open the sign-in page again")!.click();
    await flushSetupSectionRender();
    expect(plugin.accountConnectService.reopen).toHaveBeenCalledTimes(1);
    expect(plugin.accountConnectService.begin).not.toHaveBeenCalled();
  });

  it("keeps the existing connection code valid when the browser cannot reopen", async () => {
    const plugin = createPluginStub();
    plugin.accountConnectService.hasPendingRequest.mockReturnValue(true);
    plugin.accountConnectService.reopen.mockResolvedValue(false);
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, false);
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Open the sign-in page again")!.click();
    await flushSetupSectionRender();
    expect(plugin.accountConnectService.begin).not.toHaveBeenCalled();
    expect(mockedNotice).toHaveBeenCalledWith(expect.stringContaining("existing connection code still works"));
  });

  it("submits a pasted connection code in place without opening a dialog", async () => {
    const plugin = createPluginStub();
    plugin.accountConnectService.hasPendingRequest.mockReturnValue(true);
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.body.createDiv();
    displaySetupTabContent(container, tab, false);
    const codeInput = container.querySelector<HTMLInputElement>("input[placeholder='Paste code']");
    expect(codeInput).not.toBeNull();
    codeInput!.value = "  code-123  ";
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Complete sign-in")!.click();
    await flushSetupSectionRender();

    expect(plugin.accountConnectService.submitManualCode).toHaveBeenCalledWith("code-123");
    expect(document.querySelectorAll("[role='dialog'], .modal")).toHaveLength(0);
  });

  it.each([
    [{ kind: "error", reason: "network" }, "Could not reach SystemSculpt. Check your connection, then try the code again from settings."],
    [{ kind: "signed-in", name: null, email: "user@example.test", licenseValid: true }, "Signed in as user@example.test."],
    [
      { kind: "signed-in", name: null, email: "user@example.test", licenseValid: false },
      "Signed in as user@example.test. Your license is being confirmed. If AI features stay locked, open SystemSculpt settings and retry validation.",
    ],
  ])("shows the latest sign-in result once under Account: %j", (outcome, text) => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    tab.accountConnectOutcome = outcome as any;
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, false);

    const results = container.querySelectorAll('[data-testid="settings.account.connect-result"]');
    expect(results).toHaveLength(1);
    expect(results[0].textContent).toBe(text);
    expect(results[0].getAttribute("role")).toBe("status");
  });

  it("adds no result line for a plan-less account, whose Account row already says so", () => {
    const plugin = createPluginStub();
    plugin.settings.userEmail = "user@example.test";
    const tab = new SystemSculptSettingTab(app, plugin);
    tab.accountConnectOutcome = { kind: "no-license", name: null, email: "user@example.test" };
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, false);

    expect(container.querySelector('[data-testid="settings.account.connect-result"]')).toBeNull();
    expect(container.textContent).toContain("Signed in as user@example.test. No active plan yet");
  });

  it("takes a sign-in result only while Account settings are on screen, and forgets it when settings close", () => {
    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const display = jest.spyOn(tab, "display").mockImplementation(() => undefined);
    const outcome = { kind: "error", reason: "expired" } as const;

    expect(tab.showAccountConnectOutcome(outcome)).toBe(false);
    expect(tab.accountConnectOutcome).toBeNull();

    document.body.appendChild(tab.containerEl);
    expect(tab.showAccountConnectOutcome(outcome)).toBe(true);
    expect(tab.accountConnectOutcome).toBe(outcome);
    expect(display).toHaveBeenCalledTimes(1);

    (tab as any).activeTabId = "workspace";
    expect(tab.showAccountConnectOutcome(outcome)).toBe(false);

    tab.hide();
    expect(tab.accountConnectOutcome).toBeNull();
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

  it("resumes payment-suspended embeddings when account refresh confirms credits", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-test";
    plugin.embeddingsManager.isSuspended.mockReturnValue(true);
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    expect(plugin.embeddingsManager.resumeProcessing).toHaveBeenCalledTimes(1);
  });

  it("labels spendable, held, and gross credit balances separately", async () => {
    getCreditsBalanceMock.mockResolvedValueOnce({
      totalRemaining: 6030,
      heldInFlight: 5349,
      availableUnreserved: 681,
      includedRemaining: 6030,
      includedPerMonth: 10000,
      addOnRemaining: 0,
      usageClass: "customer",
      cycleStartedAt: "2026-07-01T00:00:00.000Z",
      cycleEndsAt: "2026-08-01T00:00:00.000Z",
      purchaseUrl: null,
      billingCycle: "monthly",
      annualUpgradeOffer: null,
    });
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-held";
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    expect(container.textContent).toContain("Available: 681 credits");
    expect(container.textContent).toContain("Held in current requests: 5,349 credits");
    expect(container.textContent).toContain("Total balance: 6,030 credits");
    expect(container.textContent).not.toContain("Remaining: 6,030 credits");
  });

  it("presents master auth as Internal QA without customer billing actions", async () => {
    getCreditsBalanceMock.mockResolvedValueOnce({
      totalRemaining: 0,
      includedRemaining: 0,
      includedPerMonth: 0,
      addOnRemaining: 0,
      usageClass: "master_auth",
      cycleStartedAt: "2026-07-01T00:00:00.000Z",
      cycleEndsAt: "2026-08-01T00:00:00.000Z",
      purchaseUrl: null,
      billingCycle: "unknown",
      annualUpgradeOffer: null,
    });
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-master-auth";
    plugin.embeddingsManager.isSuspended.mockReturnValue(true);
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    expect(container.textContent).toContain("Usage mode");
    expect(container.textContent).toContain("Internal testing");
    expect(container.textContent).toContain("Provider usage is tracked internally");
    expect(container.textContent).not.toContain("Remaining: 0 credits");
    expect(plugin.embeddingsManager.resumeProcessing).toHaveBeenCalledTimes(1);
    const buyCreditsButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Buy credits",
    ) as HTMLButtonElement | undefined;
    const annualSwitchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Switch to annual",
    ) as HTMLButtonElement | undefined;
    expect(buyCreditsButton).toBeTruthy();
    expect(buyCreditsButton?.hidden || buyCreditsButton?.style.display === "none").toBe(true);
    expect(buyCreditsButton?.disabled).toBe(true);
    expect(annualSwitchButton).toBeTruthy();
    expect(annualSwitchButton?.hidden || annualSwitchButton?.style.display === "none").toBe(true);
    expect(annualSwitchButton?.disabled).toBe(true);
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
    expect(plugin.getLicenseManager().validateLicenseKeyDetailed).toHaveBeenCalledWith();
    // The button's "Working..." state is the progress; the re-rendered
    // account row is the result.
    expect(mockedNotice).not.toHaveBeenCalled();
    expect(tab.display).toHaveBeenCalledTimes(1);
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
        plugin.getLicenseManager().validateLicenseKeyDetailed.mockRejectedValue(new Error("upstream failure"));
      } else {
        plugin.getLicenseManager().validateLicenseKeyDetailed.mockResolvedValue({ outcome: "rejected", isValid: false, reason: "invalid" });
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
    expect(plugin.accountConnectService.cancelPending).toHaveBeenCalledTimes(1);
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
    expect(tab.display).toHaveBeenCalledTimes(1);
    expect(mockedNotice).not.toHaveBeenCalled();
  });

  it("uses bounded first-party copy when license validation throws", async () => {
    const plugin = createPluginStub();
    plugin.getLicenseManager().validateLicenseKeyDetailed.mockRejectedValue(
      new Error("upstream leaked skss-secret and request details")
    );
    const tab = new SystemSculptSettingTab(app, plugin);
    tab.display = jest.fn();
    const container = document.createElement("div");
    displaySetupTabContent(container, tab, false);

    const licenseInput = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    licenseInput.value = "skss-secret";
    licenseInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushSetupSectionRender();

    const notices = mockedNotice.mock.calls.map((args) => String(args[0])).join("\n");
    expect(notices).toContain("Unable to validate license. Try again.");
    expect(notices).not.toContain("upstream leaked");
    expect(notices).not.toContain("skss-secret");
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

    expect(anchorHrefs).toEqual([
      "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8&utm_source=obsidian-plugin&utm_medium=account&utm_campaign=upgrade",
    ]);
  });

  it("keeps rejected billing URLs from surfacing as settings actions", async () => {
    getCreditsBalanceMock.mockResolvedValueOnce({
      totalRemaining: 2500,
      includedRemaining: 1200,
      includedPerMonth: 2000,
      addOnRemaining: 1300,
      cycleStartedAt: "2026-02-01T00:00:00.000Z",
      cycleEndsAt: "2026-03-01T00:00:00.000Z",
      purchaseUrl: null,
      billingCycle: "monthly",
      annualUpgradeOffer: null,
    });
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-test";

    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    const annualSwitchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Switch to annual"
    ) as HTMLButtonElement | undefined;
    expect(annualSwitchButton).toBeTruthy();
    expect(annualSwitchButton?.disabled).toBe(true);
    expect(annualSwitchButton?.style.display).toBe("none");

    const buyCreditsButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Buy credits"
    );
    expect(buyCreditsButton).toBeTruthy();
    (buyCreditsButton as HTMLButtonElement).click();

    // Only the safe fallback opens — the rejected URL never surfaces.
    expect(anchorHrefs).toEqual(["https://systemsculpt.com/pricing?utm_source=obsidian-plugin&utm_medium=account&utm_campaign=upgrade"]);
    expect(window.open).not.toHaveBeenCalled();
  });
});
