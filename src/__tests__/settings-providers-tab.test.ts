/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayProvidersTabContent } from "../settings/ProvidersTabContent";
import { getStudioPiAuthMethodRestriction } from "../studio/piAuth/StudioPiProviderRegistry";

var listStudioPiProviderAuthRecordsMock: jest.Mock;
var listStudioPiOAuthProvidersMock: jest.Mock;
var clearStudioPiProviderAuthMock: jest.Mock;
var setStudioPiProviderApiKeyMock: jest.Mock;
var collectSharedPiProviderHintsMock: jest.Mock;
var listLocalPiProviderIdsMock: jest.Mock;

jest.mock("../studio/piAuth/StudioPiAuthStorage", () => {
  listStudioPiProviderAuthRecordsMock = jest.fn();
  listStudioPiOAuthProvidersMock = jest.fn();
  clearStudioPiProviderAuthMock = jest.fn();
  setStudioPiProviderApiKeyMock = jest.fn();

  return {
    listStudioPiProviderAuthRecords: (...args: unknown[]) =>
      listStudioPiProviderAuthRecordsMock(...args),
    readStudioPiProviderAuthState: jest.fn(),
    setStudioPiProviderApiKey: (...args: unknown[]) =>
      setStudioPiProviderApiKeyMock(...args),
    clearStudioPiProviderAuth: (...args: unknown[]) =>
      clearStudioPiProviderAuthMock(...args),
    listStudioPiOAuthProviders: (...args: unknown[]) =>
      listStudioPiOAuthProvidersMock(...args),
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
  collectSharedPiProviderHintsMock = jest.fn(() => []);
  listLocalPiProviderIdsMock = jest.fn(async () => []);

  return {
    collectSharedPiProviderHints: (...args: unknown[]) =>
      collectSharedPiProviderHintsMock(...args),
    listLocalPiProviderIds: (...args: unknown[]) =>
      listLocalPiProviderIdsMock(...args),
  };
});

jest.mock("../services/PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      supportsDesktopOnlyFeatures: jest.fn(() => true),
    })),
  },
}));

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
    expect(setupPanel?.textContent).toContain("~/.pi/agent/models.json");
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
});
