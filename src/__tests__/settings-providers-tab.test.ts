/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayProvidersTabContent } from "../settings/ProvidersTabContent";
import { getStudioPiAuthMethodRestriction } from "../studio/piAuth/StudioPiProviderRegistry";

jest.mock("../studio/piAuth/StudioPiAuthStorage", () => {
  return {
    setStudioPiProviderApiKey: jest.fn(),
    clearStudioPiProviderAuth: jest.fn(),
  };
});

jest.mock("../studio/piAuth/StudioPiAuthInventory", () => {
  return {
    listStudioPiProviderAuthRecords: jest.fn(),
    listStudioPiOAuthProviders: jest.fn(),
  };
});

jest.mock("../studio/piAuth/StudioPiOAuthLoginFlow", () => ({
  runStudioPiOAuthLoginFlow: jest.fn(),
}));

jest.mock("../utils/oauthUiHelpers", () => ({
  openExternalUrlForOAuth: jest.fn(),
}));

jest.mock("../core/ui/modals/PopupModal", () => ({
  showPopup: jest.fn(),
}));

jest.mock("../services/pi/PiTextModels", () => {
  return {
    collectSharedPiProviderHints: jest.fn(() => []),
    listLocalPiProviderIds: jest.fn(async () => []),
  };
});

jest.mock("../services/PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      supportsDesktopOnlyFeatures: jest.fn(() => true),
    })),
  },
}));

const {
  listStudioPiProviderAuthRecords: listStudioPiProviderAuthRecordsMock,
  listStudioPiOAuthProviders: listStudioPiOAuthProvidersMock,
} = jest.requireMock("../studio/piAuth/StudioPiAuthInventory") as Record<string, jest.Mock>;

const {
  collectSharedPiProviderHints: collectSharedPiProviderHintsMock,
  listLocalPiProviderIds: listLocalPiProviderIdsMock,
} = jest.requireMock("../services/pi/PiTextModels") as Record<string, jest.Mock>;

describe("Providers tab provider states", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";
    listLocalPiProviderIdsMock.mockResolvedValue([]);

    listStudioPiOAuthProvidersMock.mockResolvedValue([
      {
        id: "anthropic",
        name: "Anthropic Claude Max",
        usesCallbackServer: false,
      },
    ]);
    listStudioPiProviderAuthRecordsMock.mockResolvedValue([
      {
        provider: "anthropic",
        displayName: "Anthropic Claude Max",
        supportsOAuth: true,
        hasAnyAuth: false,
        hasStoredCredential: false,
        source: "none",
        credentialType: "none",
        oauthExpiresAt: null,
      },
    ]);
  });

  it("keeps subscription login visible but disabled with warning copy and hover details", async () => {
    const plugin = {
      app: new App(),
      settings: {
        customProviders: [],
      },
    } as any;
    const tab = { plugin } as any;
    const container = document.createElement("div");

    await displayProvidersTabContent(container, tab);

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Connect"
    ) as HTMLButtonElement | undefined;
    expect(connectButton).toBeTruthy();

    connectButton?.click();
    await Promise.resolve();

    const subscriptionButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Subscription login"
    ) as HTMLButtonElement | undefined;
    const apiKeyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "API key"
    ) as HTMLButtonElement | undefined;
    const restriction = getStudioPiAuthMethodRestriction("anthropic", "oauth");
    const reasonEl = container.querySelector<HTMLElement>(".ss-provider-connect-method-reason");

    expect(subscriptionButton).toBeTruthy();
    expect(subscriptionButton?.disabled).toBe(true);
    expect(subscriptionButton?.title).toBe(restriction.hoverDetails);
    expect(apiKeyButton).toBeTruthy();
    expect(apiKeyButton?.disabled).toBe(false);
    expect(apiKeyButton?.className).toContain("ss-provider-connect-method--active");
    expect(reasonEl?.textContent).toContain(restriction.inlineReason || "");
    expect(reasonEl?.getAttribute("title")).toBe(restriction.hoverDetails);
  });

  it("shows stored Anthropic subscription auth as disabled instead of connected", async () => {
    listStudioPiProviderAuthRecordsMock.mockResolvedValue([
      {
        provider: "anthropic",
        displayName: "Anthropic Claude Max",
        supportsOAuth: true,
        hasAnyAuth: true,
        hasStoredCredential: true,
        source: "oauth",
        credentialType: "oauth",
        oauthExpiresAt: null,
      },
    ]);

    const plugin = {
      app: new App(),
      settings: {
        customProviders: [],
      },
    } as any;
    const tab = { plugin } as any;
    const container = document.createElement("div");

    await displayProvidersTabContent(container, tab);

    const restriction = getStudioPiAuthMethodRestriction("anthropic", "oauth");
    const row = container.querySelector(".ss-provider-row");
    const warningEl = container.querySelector<HTMLElement>(".ss-provider-row__warning");
    const fixButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Fix"
    ) as HTMLButtonElement | undefined;
    const disconnectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Disconnect"
    ) as HTMLButtonElement | undefined;

    expect(container.textContent).toContain("Subscription login disabled. Use API key instead.");
    expect(container.textContent).toContain("0 ready, 1 needs attention");
    expect(container.textContent).not.toContain("Connected via subscription");
    expect(row?.className).toContain("ss-provider-row--blocked");
    expect(row?.className).not.toContain("ss-provider-row--connected");
    expect(warningEl?.textContent).toContain(restriction.inlineReason || "");
    expect(warningEl?.getAttribute("title")).toBe(restriction.hoverDetails);
    expect(fixButton).toBeTruthy();
    expect(disconnectButton).toBeTruthy();

    fixButton?.click();
    await Promise.resolve();

    const connectPanel = container.querySelector(".ss-provider-connect-panel");
    const apiKeyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "API key"
    ) as HTMLButtonElement | undefined;

    expect(connectPanel?.textContent).toContain(
      "Save an API key to replace the stored subscription login, or disconnect it from the row above."
    );
    expect(apiKeyButton?.className).toContain("ss-provider-connect-method--active");
  });

  it("shows Ollama as a local setup flow with models.json guidance", async () => {
    listStudioPiOAuthProvidersMock.mockResolvedValue([]);
    listStudioPiProviderAuthRecordsMock.mockResolvedValue([
      {
        provider: "ollama",
        displayName: "Ollama",
        supportsOAuth: false,
        hasAnyAuth: false,
        hasStoredCredential: false,
        source: "none",
        credentialType: "none",
        oauthExpiresAt: null,
      },
    ]);

    const plugin = {
      app: new App(),
      settings: {
        customProviders: [],
      },
    } as any;
    const tab = { plugin } as any;
    const container = document.createElement("div");

    await displayProvidersTabContent(container, tab);

    expect(container.textContent).toContain("Set up locally via Pi models.json");

    const setupButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Set up"
    ) as HTMLButtonElement | undefined;
    expect(setupButton).toBeTruthy();

    setupButton?.click();
    await Promise.resolve();

    const setupPanel = container.querySelector(".ss-provider-connect-panel");
    expect(setupPanel?.textContent).toContain(".systemsculpt/pi-agent/models.json");
    expect(setupPanel?.textContent).toContain("http://localhost:11434/v1");
    expect(setupPanel?.textContent).toContain("openai-completions");
    expect(setupPanel?.textContent).toContain("\"ollama\"");
    expect(setupPanel?.textContent).not.toContain("No available connection method");
  });

  it("treats detected local providers as ready without showing disconnect actions", async () => {
    listStudioPiOAuthProvidersMock.mockResolvedValue([]);
    listStudioPiProviderAuthRecordsMock.mockResolvedValue([
      {
        provider: "lmstudio",
        displayName: "LM Studio",
        supportsOAuth: false,
        hasAnyAuth: false,
        hasStoredCredential: false,
        source: "none",
        credentialType: "none",
        oauthExpiresAt: null,
      },
    ]);
    listLocalPiProviderIdsMock.mockResolvedValue(["lmstudio"]);

    const plugin = {
      app: new App(),
      settings: {
        customProviders: [],
      },
    } as any;
    const tab = { plugin } as any;
    const container = document.createElement("div");

    await displayProvidersTabContent(container, tab);

    expect(container.textContent).toContain("Configured locally via Pi models.json");
    expect(container.textContent).toContain("1 ready");

    const detailsButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Details"
    ) as HTMLButtonElement | undefined;
    expect(detailsButton).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Disconnect"
      )
    ).toBe(false);

    const row = container.querySelector(".ss-provider-row");
    expect(row?.className).toContain("ss-provider-row--connected");
  });

  it("fails closed with an error instead of spinning forever when provider inventory stalls", async () => {
    jest.useFakeTimers();
    listStudioPiOAuthProvidersMock.mockResolvedValue([]);
    listStudioPiProviderAuthRecordsMock.mockImplementation(
      () => new Promise(() => {})
    );

    const plugin = {
      app: new App(),
      settings: {
        customProviders: [],
      },
    } as any;
    const tab = { plugin } as any;
    const container = document.createElement("div");

    try {
      const renderPromise = displayProvidersTabContent(container, tab);
      await jest.advanceTimersByTimeAsync(5_100);
      await renderPromise;

      const errorEl = container.querySelector<HTMLElement>(".ss-providers-error");
      expect(errorEl?.textContent).toContain("Timed out while loading provider settings.");
      expect(container.querySelector(".ss-providers-loading")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
