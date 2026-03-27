/** @jest-environment jsdom */

import { App } from "obsidian";
import { displayProvidersTabContent } from "../settings/ProvidersTabContent";
import { getStudioPiAuthMethodRestriction } from "../studio/piAuth/StudioPiProviderRegistry";

var listStudioPiProviderAuthRecordsMock: jest.Mock;
var listStudioPiOAuthProvidersMock: jest.Mock;
var clearStudioPiProviderAuthMock: jest.Mock;
var setStudioPiProviderApiKeyMock: jest.Mock;
var collectSharedPiProviderHintsMock: jest.Mock;

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

  return {
    collectSharedPiProviderHints: (...args: unknown[]) =>
      collectSharedPiProviderHintsMock(...args),
    listLocalPiProviderIds: jest.fn(() => []),
  };
});

jest.mock("../services/PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(() => ({
      supportsDesktopOnlyFeatures: jest.fn(() => true),
    })),
  },
}));

describe("Providers tab Anthropic subscription restriction", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = "";

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
});
