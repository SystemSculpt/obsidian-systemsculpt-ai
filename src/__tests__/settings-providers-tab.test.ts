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

jest.mock("../core/ui/modals/OAuthStatusModal", () => ({
  OAuthStatusModal: jest.fn().mockImplementation(() => ({
    showWaiting: jest.fn(),
    showPasteFallback: jest.fn(),
    showSuccess: jest.fn().mockResolvedValue(undefined),
    open: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock("../views/chatview/ChatView", () => ({
  ChatView: jest.fn().mockImplementation(function ChatView(this: any, leaf: any, plugin: any) {
    this.leaf = leaf;
    this.plugin = plugin;
  }),
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
  setStudioPiProviderApiKey: setStudioPiProviderApiKeyMock,
} = jest.requireMock("../studio/piAuth/StudioPiAuthStorage") as Record<string, jest.Mock>;

const {
  ChatView: ChatViewMock,
} = jest.requireMock("../views/chatview/ChatView") as Record<string, jest.Mock>;

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
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
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
    } finally {
      if (previousPiAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
      }
    }
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

  it("refreshes models after saving an xAI key and makes Grok 4.3 easy to use", async () => {
    listStudioPiOAuthProvidersMock.mockResolvedValue([]);
    listStudioPiProviderAuthRecordsMock
      .mockResolvedValueOnce([
        {
          provider: "xai",
          displayName: "xAI",
          supportsOAuth: false,
          hasAnyAuth: false,
          hasStoredCredential: false,
          source: "none",
          credentialType: "none",
          oauthExpiresAt: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          provider: "xai",
          displayName: "xAI",
          supportsOAuth: false,
          hasAnyAuth: true,
          hasStoredCredential: true,
          source: "api_key",
          credentialType: "api_key",
          oauthExpiresAt: null,
        },
      ]);
    setStudioPiProviderApiKeyMock.mockResolvedValue(undefined);
    const refreshModels = jest.fn(async () => [
      {
        id: "xai@@grok-4.3",
        name: "Grok 4.3",
        provider: "xai",
        sourceProviderId: "xai",
      },
    ]);

    const app = new App();
    let leafViewState: Record<string, any> = { type: "", state: {} };
    const leaf = {
      view: null as any,
      getViewState: jest.fn(() => leafViewState),
      setViewState: jest.fn(async (nextState: Record<string, any>) => {
        leafViewState = nextState;
      }),
      open: jest.fn(async (view: any) => {
        leaf.view = view;
      }),
    };
    (app.workspace as any).getLeaf = jest.fn(() => leaf);
    (app.workspace as any).setActiveLeaf = jest.fn();
    const updateSettings = jest.fn().mockResolvedValue(undefined);
    const plugin = {
      app,
      settings: {
        customProviders: [],
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings,
      })),
      modelService: {
        refreshModels,
      },
    } as any;
    const tab = { plugin } as any;
    const container = document.createElement("div");

    await displayProvidersTabContent(container, tab);

    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Connect"
    ) as HTMLButtonElement | undefined;
    connectButton?.click();
    await Promise.resolve();

    const input = container.querySelector<HTMLInputElement>(".ss-provider-connect-input");
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save"
    ) as HTMLButtonElement | undefined;
    expect(input).toBeTruthy();
    expect(saveButton).toBeTruthy();

    input!.value = "xai-test-key";
    saveButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(setStudioPiProviderApiKeyMock).toHaveBeenCalledWith(
      "xai",
      "xai-test-key",
      { plugin },
    );
    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Connected via API key");
    expect(container.textContent).toContain("Grok 4.3 is ready in the model picker.");
    const useInChatButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Use in Chat"
    ) as HTMLButtonElement | undefined;
    expect(useInChatButton).toBeTruthy();

    useInChatButton!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(updateSettings).toHaveBeenCalledWith({ selectedModelId: "xai@@grok-4.3" });
    expect((app.workspace as any).getLeaf).toHaveBeenCalledWith("tab");
    expect(leaf.setViewState).toHaveBeenCalledWith({
      type: "systemsculpt-chat-view",
      state: expect.objectContaining({
        chatId: "",
        selectedModelId: "xai@@grok-4.3",
      }),
    });
    expect(ChatViewMock).toHaveBeenCalledWith(leaf, plugin);
    expect(leaf.open).toHaveBeenCalled();
    expect((app.workspace as any).setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
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

  it("calls OAuth flow without onManualCodeInput for callback-server providers", async () => {
    listStudioPiOAuthProvidersMock.mockResolvedValue([
      {
        id: "openai-codex",
        name: "ChatGPT Plus/Pro (Codex Subscription)",
        usesCallbackServer: true,
      },
    ]);
    listStudioPiProviderAuthRecordsMock.mockResolvedValue([
      {
        provider: "openai-codex",
        displayName: "ChatGPT Plus/Pro (Codex Subscription)",
        supportsOAuth: true,
        hasAnyAuth: false,
        hasStoredCredential: false,
        source: "none",
        credentialType: "none",
        oauthExpiresAt: null,
      },
    ]);

    const { runStudioPiOAuthLoginFlow: runFlowMock } = jest.requireMock(
      "../studio/piAuth/StudioPiOAuthLoginFlow"
    ) as Record<string, jest.Mock>;
    runFlowMock.mockResolvedValue({ sawAuthEvent: true, sawAuthUrl: true });

    const plugin = {
      app: new App(),
      settings: { customProviders: [] },
    } as any;
    const tab = { plugin } as any;
    const container = document.createElement("div");

    await displayProvidersTabContent(container, tab);

    // Click "Connect" to expand the provider
    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Connect"
    ) as HTMLButtonElement;
    expect(connectButton).toBeDefined();
    connectButton.click();
    // Flush multiple microticks so async render completes
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();

    // Click "Continue with..." to start OAuth
    const loginButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Continue with")
    ) as HTMLButtonElement;
    expect(loginButton).toBeDefined();
    loginButton.click();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();

    // Verify the flow was called without onManualCodeInput
    expect(runFlowMock).toHaveBeenCalledTimes(1);
    const flowOptions = runFlowMock.mock.calls[0][0];
    expect(flowOptions.onManualCodeInput).toBeUndefined();
    expect(flowOptions.onAuth).toBeDefined();
    expect(flowOptions.onPrompt).toBeDefined();
  });
});
