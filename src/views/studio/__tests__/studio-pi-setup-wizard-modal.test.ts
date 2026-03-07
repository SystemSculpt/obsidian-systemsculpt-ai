/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import type { StudioPiOAuthProvider } from "../../../studio/StudioLocalTextModelCatalog";
import {
  normalizeWizardProviderId,
  StudioPiSetupWizardModal,
} from "../StudioPiSetupWizardModal";

const installStudioLocalPiCliMock = jest.fn();
const listStudioPiOAuthProvidersMock = jest.fn();
const readStudioPiProviderAuthStateMock = jest.fn();
const listLocalPiProviderIdsMock = jest.fn();
const listLocalPiTextModelsMock = jest.fn();

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  class MockModal {
    app: App;
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;

    constructor(app: App) {
      this.app = app;
      this.contentEl = document.createElement("div");
      this.titleEl = document.createElement("div");
      this.modalEl = document.createElement("div");
    }

    open(): void {}
    close(): void {}
  }

  return {
    ...actual,
    Modal: MockModal,
    Notice: jest.fn(),
    Platform: {
      ...actual.Platform,
      isDesktopApp: true,
    },
    setIcon: jest.fn((el: HTMLElement, icon: string) => {
      el.setAttribute("data-icon", icon);
    }),
  };
});

jest.mock("../../../studio/StudioLocalTextModelCatalog", () => ({
  buildStudioPiApiKeyEnvCommandHint: jest.fn(() => "export OPENAI_API_KEY=\"your-api-key-here\""),
  buildStudioPiResolvedLoginCommand: jest.fn(async (_plugin: unknown, provider: string) => `pi /login ${provider}`),
  buildStudioPiLoginCommand: jest.fn((provider: string) => `pi /login ${provider}`),
  clearStudioPiProviderAuth: jest.fn(async () => {}),
  getStudioPiAuthStoragePathHintForPlatform: jest.fn(() => "~/.pi/agent/auth.json"),
  getStudioPiLoginSurfaceLabel: jest.fn(() => "Terminal"),
  installStudioLocalPiCli: (...args: unknown[]) => installStudioLocalPiCliMock(...args),
  launchStudioPiProviderLoginInTerminal: jest.fn(async () => {}),
  listStudioPiOAuthProviders: (...args: unknown[]) => listStudioPiOAuthProvidersMock(...args),
  readStudioPiProviderAuthState: (...args: unknown[]) => readStudioPiProviderAuthStateMock(...args),
  setStudioPiProviderApiKey: jest.fn(async () => {}),
}));

jest.mock("../../../services/pi/PiTextModels", () => ({
  listLocalPiProviderIds: (...args: unknown[]) => listLocalPiProviderIdsMock(...args),
  listLocalPiTextModels: (...args: unknown[]) => listLocalPiTextModelsMock(...args),
}));

jest.mock("../../../utils/clipboard", () => ({
  tryCopyToClipboard: jest.fn(async () => true),
}));

jest.mock("../../../utils/oauthUiHelpers", () => ({
  openExternalUrlForOAuth: jest.fn(async () => {}),
}));

jest.mock("../../../studio/piAuth/StudioPiOAuthLoginFlow", () => ({
  runStudioPiOAuthLoginFlow: jest.fn(async () => {}),
}));

function oauthProvider(id: string, name: string): StudioPiOAuthProvider {
  return { id, name, usesCallbackServer: false };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createModal(provider = "", issue: "provider_auth" | "missing_cli" = "provider_auth"): StudioPiSetupWizardModal {
  return new StudioPiSetupWizardModal(
    {
      app: new App(),
      plugin: {} as any,
      issue,
      modelId: "",
      provider,
      errorMessage:
        issue === "missing_cli"
          ? "spawn pi ENOENT"
          : "No API key found for anthropic. Use /login anthropic",
      projectPath: null,
    },
    jest.fn()
  );
}

describe("StudioPiSetupWizardModal", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    jest.clearAllMocks();

    installStudioLocalPiCliMock.mockResolvedValue({ version: "1.2.3" });
    listStudioPiOAuthProvidersMock.mockResolvedValue([
      oauthProvider("openai-codex", "OpenAI Codex"),
      oauthProvider("anthropic", "Anthropic"),
      oauthProvider("google-antigravity", "Google Antigravity"),
    ]);
    readStudioPiProviderAuthStateMock.mockImplementation(async (provider: string) => ({
      provider,
      hasAnyAuth: false,
      source: "none",
    }));
    listLocalPiProviderIdsMock.mockResolvedValue([]);
    listLocalPiTextModelsMock.mockResolvedValue([]);
  });

  it("starts with the auth-method question and then shows subscription choices", async () => {
    const modal = createModal();
    modal.onOpen();
    await flushAsyncWork();

    expect(modal.titleEl.textContent).toBe("Set Up Pi");
    expect(modal.contentEl.textContent).toContain("How do you want to connect?");
    expect(modal.contentEl.textContent).toContain("Subscription login");
    expect(modal.contentEl.textContent).toContain("API key");
    expect(modal.contentEl.textContent).toContain("ChatGPT");
    expect(modal.contentEl.textContent).toContain("Claude");
    expect(modal.contentEl.textContent).toContain("ChatGPT subscription");
    expect(modal.contentEl.textContent).toContain("Recommended for most people.");
    expect(modal.contentEl.textContent).toContain("Continue with ChatGPT");
    expect(modal.contentEl.textContent).not.toContain("Connect provider");
    expect(modal.contentEl.querySelectorAll(".ss-pi-wizard__oauth-choice").length).toBeGreaterThanOrEqual(3);
    expect(modal.contentEl.querySelectorAll(".ss-pi-wizard__method-choice").length).toBe(2);
    expect(modal.contentEl.querySelector(".ss-pi-wizard__oauth-choice--active")?.textContent).toContain(
      "ChatGPT subscription"
    );
    expect(modal.contentEl.querySelector(".ss-pi-wizard__provider-row")).toBeNull();
  });

  it("keeps the API-key path available for API-key-only providers", async () => {
    const modal = createModal("openai");
    modal.onOpen();
    await flushAsyncWork();

    expect(modal.contentEl.textContent).toContain("How do you want to connect?");
    expect(modal.contentEl.textContent).toContain("Subscription");
    expect(modal.contentEl.textContent).toContain("API key");
    expect(modal.contentEl.querySelector(".ss-pi-wizard__provider-row")).not.toBeNull();
    expect(modal.contentEl.querySelector("select.ss-pi-wizard__select")).not.toBeNull();
    expect(modal.contentEl.querySelector("input.ss-pi-wizard__input")).not.toBeNull();
  });

  it("shows the install card copy up front and hides stale technical details after Pi is ready", async () => {
    const modal = createModal("", "missing_cli");
    modal.onOpen();

    expect(modal.contentEl.textContent).toContain("Install Pi");
    expect(modal.contentEl.textContent).toContain("Studio can install Pi automatically before you sign in.");

    await flushAsyncWork();

    expect(modal.contentEl.textContent).not.toContain("Show technical details");
    expect(modal.contentEl.textContent).toContain("How do you want to connect?");
  });

  it("normalizes trailing punctuation from provider hints", () => {
    expect(normalizeWizardProviderId("anthropic.")).toBe("anthropic");
    expect(normalizeWizardProviderId("openai,")).toBe("openai");
  });
});
