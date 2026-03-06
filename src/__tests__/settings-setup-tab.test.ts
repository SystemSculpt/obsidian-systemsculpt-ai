/** @jest-environment jsdom */

import {
  compareStudioPiAuthRecords,
  displaySetupTabContent,
  deriveStudioPiMigrationCandidates,
} from "../settings/SetupTabContent";
import { SystemSculptSettingTab } from "../settings/SystemSculptSettingTab";
import { App, Platform } from "obsidian";
import * as StudioPiCatalog from "../studio/StudioLocalTextModelCatalog";
import * as SetupPiOAuthFlow from "../settings/piAuth/SetupPiOAuthFlow";
import { ensureBundledPiRuntime } from "../services/pi/PiRuntimeBootstrap";

jest.mock("../studio/StudioLocalTextModelCatalog", () => ({
  listStudioPiProviderAuthRecords: jest.fn().mockResolvedValue([]),
  migrateStudioPiProviderApiKeys: jest.fn().mockResolvedValue({
    migrated: [],
    skipped: [],
    errors: [],
  }),
  loginStudioPiProviderOAuth: jest.fn().mockResolvedValue(undefined),
  setStudioPiProviderApiKey: jest.fn().mockResolvedValue(undefined),
  clearStudioPiProviderAuth: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../settings/piAuth/SetupPiOAuthFlow", () => ({
  runSetupPiOAuthLogin: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/pi/PiRuntimeBootstrap", () => ({
  ensureBundledPiRuntime: jest.fn().mockResolvedValue({
    pluginInstallDir: "/tmp/test-vault/.obsidian/plugins/systemsculpt-ai",
    result: {
      installedRuntime: false,
      packageCount: 2,
    },
  }),
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
      studioPiAuthMigrationVersion: 1,
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

async function flushSetupSectionRender(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

describe("Setup tab native layout", () => {
  let app: App;
  let windowOpenSpy: jest.SpyInstance;
  const ensureBundledPiRuntimeMock = ensureBundledPiRuntime as jest.MockedFunction<typeof ensureBundledPiRuntime>;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    app = new App();
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
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
    ensureBundledPiRuntimeMock.mockResolvedValue({
      pluginInstallDir: "/tmp/test-vault/.obsidian/plugins/systemsculpt-ai",
      result: {
        installedRuntime: false,
        packageCount: 2,
      },
    });
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
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
    expect(container.textContent).toContain("Pi Providers & Auth");
  });

  it("opens credits details from setup when pro is active", async () => {
    const plugin = createPluginStub();
    plugin.settings.licenseValid = true;
    plugin.settings.licenseKey = "skss-test";

    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, true);
    await flushSetupSectionRender();

    const detailsButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Details");

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

    const annualSwitchButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Switch to annual");

    expect(annualSwitchButton).toBeTruthy();
    (annualSwitchButton as HTMLButtonElement).click();

    expect(window.open).toHaveBeenCalledWith(
      "https://systemsculpt.com/checkout?resourceId=2b96b063-3ed9-4e5a-972c-6910fb611ab8",
      "_blank"
    );
  });

  it("derives strict Pi migration candidates from known endpoints only", () => {
    const result = deriveStudioPiMigrationCandidates(
      [
        {
          id: "openai-main",
          name: "OpenAI",
          endpoint: "https://api.openai.com/v1",
          apiKey: "sk-openai",
          isEnabled: true,
        },
        {
          id: "unknown-endpoint",
          name: "Unknown",
          endpoint: "https://example.com/v1",
          apiKey: "sk-unknown",
          isEnabled: true,
        },
      ],
      "legacy-key"
    );

    expect(result.candidates).toEqual([
      {
        providerId: "openai",
        apiKey: "sk-openai",
        origin: "custom-provider:openai-main",
      },
    ]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "custom-provider:unknown-endpoint",
          reason: "unmapped_endpoint",
        }),
        expect.objectContaining({
          source: "legacy:openAiApiKey",
          reason: "duplicate_provider_mapping",
          providerId: "openai",
        }),
      ])
    );
  });

  it("sorts providers with stored OAuth/API-key credentials to the top", () => {
    const records = [
      {
        provider: "openrouter",
        displayName: "OpenRouter",
        supportsOAuth: false,
        hasAnyAuth: false,
        hasStoredCredential: false,
        source: "none",
        credentialType: "none",
        oauthExpiresAt: null,
      },
      {
        provider: "openai-codex",
        displayName: "OpenAI Codex",
        supportsOAuth: true,
        hasAnyAuth: true,
        hasStoredCredential: true,
        source: "oauth",
        credentialType: "oauth",
        oauthExpiresAt: null,
      },
      {
        provider: "anthropic",
        displayName: "Anthropic",
        supportsOAuth: false,
        hasAnyAuth: true,
        hasStoredCredential: true,
        source: "api_key",
        credentialType: "api_key",
        oauthExpiresAt: null,
      },
    ] as any[];

    const sorted = [...records].sort(compareStudioPiAuthRecords).map((record) => record.provider);
    expect(sorted.slice(0, 2)).toEqual(["anthropic", "openai-codex"]);
    expect(sorted[2]).toBe("openrouter");
  });

  it("shows completion labels for authenticated OAuth and API-key providers", async () => {
    const listAuthRecordsMock = StudioPiCatalog.listStudioPiProviderAuthRecords as jest.Mock;
    listAuthRecordsMock.mockResolvedValue([
      {
        provider: "openai-codex",
        displayName: "OpenAI Codex",
        supportsOAuth: true,
        hasAnyAuth: true,
        hasStoredCredential: true,
        source: "oauth",
        credentialType: "oauth",
        oauthExpiresAt: null,
      },
      {
        provider: "anthropic",
        displayName: "Anthropic",
        supportsOAuth: false,
        hasAnyAuth: true,
        hasStoredCredential: true,
        source: "api_key",
        credentialType: "api_key",
        oauthExpiresAt: null,
      },
      {
        provider: "openrouter",
        displayName: "OpenRouter",
        supportsOAuth: false,
        hasAnyAuth: false,
        hasStoredCredential: false,
        source: "none",
        credentialType: "none",
        oauthExpiresAt: null,
      },
    ]);

    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, false);
    await flushSetupSectionRender();

    const piRows = Array.from(container.querySelectorAll(".ss-setup-pi-auth-list .setting-item"));
    const getRowByName = (name: string) =>
      piRows.find((row) => row.querySelector(".setting-item-name")?.textContent?.trim() === name);

    const oauthRow = getRowByName("OpenAI Codex");
    expect(oauthRow).toBeTruthy();
    expect(oauthRow?.textContent).toContain("OAuth ✓");
    expect(oauthRow?.classList.contains("is-authenticated")).toBe(true);

    const apiKeyRow = getRowByName("Anthropic");
    expect(apiKeyRow).toBeTruthy();
    expect(apiKeyRow?.textContent).toContain("API key ✓");
    expect(apiKeyRow?.classList.contains("is-authenticated")).toBe(true);

    const unauthenticatedRow = getRowByName("OpenRouter");
    expect(unauthenticatedRow).toBeTruthy();
    expect(unauthenticatedRow?.textContent).toContain("Set API key");
    expect(unauthenticatedRow?.classList.contains("is-authenticated")).toBe(false);
  });

  it("runs in-app OAuth login flow from setup instead of terminal launcher", async () => {
    const listAuthRecordsMock = StudioPiCatalog.listStudioPiProviderAuthRecords as jest.Mock;
    const runSetupPiOAuthLoginMock = SetupPiOAuthFlow.runSetupPiOAuthLogin as jest.Mock;
    listAuthRecordsMock.mockResolvedValue([
      {
        provider: "openai-codex",
        displayName: "OpenAI Codex",
        supportsOAuth: true,
        hasAnyAuth: false,
        hasStoredCredential: false,
        source: "none",
        credentialType: "none",
        oauthExpiresAt: null,
      },
    ]);

    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, false);
    await flushSetupSectionRender();

    const oauthRow = Array.from(
      container.querySelectorAll(".ss-setup-pi-auth-list .setting-item")
    ).find((row) => row.querySelector(".setting-item-name")?.textContent?.trim() === "OpenAI Codex");
    expect(oauthRow).toBeTruthy();

    const oauthButton = Array.from(
      (oauthRow as HTMLElement).querySelectorAll("button")
    ).find((button) => button.textContent?.trim() === "OAuth login");
    expect(oauthButton).toBeTruthy();

    (oauthButton as HTMLButtonElement).click();
    await Promise.resolve();

    expect(runSetupPiOAuthLoginMock).toHaveBeenCalledTimes(1);
    const oauthOptions = runSetupPiOAuthLoginMock.mock.calls[0][0];
    expect(oauthOptions.record.provider).toBe("openai-codex");
    expect(oauthOptions.providerLabel).toBe("OpenAI Codex");
    expect(oauthOptions.app).toBe(app);
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it("includes Anthropic in fallback OAuth provider rows", async () => {
    const listAuthRecordsMock = StudioPiCatalog.listStudioPiProviderAuthRecords as jest.Mock;
    listAuthRecordsMock.mockResolvedValue([]);

    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, false);
    await flushSetupSectionRender();

    const piRows = Array.from(container.querySelectorAll(".ss-setup-pi-auth-list .setting-item"));
    const anthropicRow = piRows.find(
      (row) => row.querySelector(".setting-item-name")?.textContent?.trim() === "Anthropic"
    );

    expect(anthropicRow).toBeTruthy();
    expect(anthropicRow?.textContent).toContain("OAuth login");
  });

  it("shows concise bundled-runtime recovery copy when bootstrap is still resolving", async () => {
    ensureBundledPiRuntimeMock.mockRejectedValue(
      new Error("Unable to resolve the SystemSculpt plugin installation directory for Pi runtime bootstrap.")
    );

    const plugin = createPluginStub();
    const tab = new SystemSculptSettingTab(app, plugin);
    const container = document.createElement("div");

    displaySetupTabContent(container, tab, false);
    await flushSetupSectionRender();

    expect(container.textContent).toContain("Preparing bundled Pi runtime");
    expect(container.textContent).toContain("Wait a moment, then press Refresh.");
    expect(container.textContent).not.toContain("Unable to resolve the SystemSculpt plugin installation directory");
  });
});
