/**
 * @jest-environment jsdom
 */

import { App } from "obsidian";
import { showPopup } from "../../../core/ui/";
import {
  loadPiTextLocalProviderIds,
  loadPiTextProviderAuth,
  piTextProviderRequiresAuth,
} from "../../../services/pi-native/PiTextAuth";
import { hasManagedSystemSculptAccess } from "../../../services/systemsculpt/ManagedSystemSculptModel";
import {
  loadChatModelPickerOptions,
  openChatModelSetupTab,
  promptChatModelSetup,
} from "../modelSelection";

jest.mock("../../../core/ui/", () => ({
  showPopup: jest.fn(),
}));

jest.mock("../../../services/pi-native/PiTextAuth", () => ({
  loadPiTextLocalProviderIds: jest.fn(),
  loadPiTextProviderAuth: jest.fn(),
  piTextProviderRequiresAuth: jest.fn(),
}));

jest.mock("../../../services/systemsculpt/ManagedSystemSculptModel", () => {
  const actual = jest.requireActual("../../../services/systemsculpt/ManagedSystemSculptModel");
  return {
    ...actual,
    hasManagedSystemSculptAccess: jest.fn(() => true),
  };
});

describe("chat model setup helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (loadPiTextProviderAuth as jest.Mock).mockResolvedValue(new Map());
    (loadPiTextLocalProviderIds as jest.Mock).mockResolvedValue(new Set());
    (piTextProviderRequiresAuth as jest.Mock).mockImplementation(
      (providerHint: string) => String(providerHint || "").trim().length > 0
    );
    (hasManagedSystemSculptAccess as jest.Mock).mockReturnValue(true);
  });

  it("opens Providers when Pi setup is confirmed", async () => {
    (showPopup as jest.Mock).mockResolvedValue({ confirmed: true });
    const openSettingsTab = jest.fn();

    await expect(
      promptChatModelSetup({
        app: new App(),
        openSettingsTab,
        selectedModelId: "openai@@gpt-4.1",
      }),
    ).resolves.toBe(true);

    expect(showPopup).toHaveBeenCalledWith(
      expect.any(App),
      "Open Settings -> Providers to connect the selected provider.",
      expect.objectContaining({
        title: "Finish provider setup",
        primaryButton: "Open Providers",
      }),
    );
    expect(openSettingsTab).toHaveBeenCalledWith("providers");
  });

  it("uses retry-hint account copy and does not open settings when dismissed", async () => {
    (showPopup as jest.Mock).mockResolvedValue({ confirmed: false });
    const openSettingsTab = jest.fn();

    await expect(
      promptChatModelSetup({
        app: new App(),
        openSettingsTab,
        selectedModelId: "systemsculpt@@systemsculpt/ai-agent",
        retryHint: true,
      }),
    ).resolves.toBe(false);

    expect(showPopup).toHaveBeenCalledWith(
      expect.any(App),
      "Open Settings -> Account to activate your SystemSculpt license, then try again.",
      expect.objectContaining({
        title: "Finish setup",
        primaryButton: "Open Account",
      }),
    );
    expect(openSettingsTab).not.toHaveBeenCalled();
  });

  it("swallows settings-tab failures for setup fallbacks", () => {
    expect(() => {
      openChatModelSetupTab(() => {
        throw new Error("settings unavailable");
      }, "providers");
    }).not.toThrow();
  });

  it("treats bundled remote Pi providers as provider-authenticated instead of local-only", async () => {
    (loadPiTextProviderAuth as jest.Mock).mockResolvedValue(
      new Map([
        [
          "openrouter",
          {
            provider: "openrouter",
            hasAnyAuth: true,
          },
        ],
      ])
    );

    const plugin = {
      modelService: {
        getModels: jest.fn().mockResolvedValue([
          {
            id: "systemsculpt@@systemsculpt/ai-agent",
            name: "SystemSculpt Agent",
            provider: "systemsculpt",
          },
          {
            id: "local-pi-lmstudio@@qwen2.5-coder:7b",
            name: "Qwen 2.5 Coder",
            provider: "lmstudio",
            sourceProviderId: "lmstudio",
            sourceMode: "pi_local",
            piLocalAvailable: true,
            piRemoteAvailable: false,
          },
          {
            id: "local-pi-openrouter@@openai/gpt-5.4-mini",
            name: "GPT-5.4 Mini",
            provider: "openrouter",
            sourceProviderId: "openrouter",
            sourceMode: "pi_local",
            piLocalAvailable: true,
            piRemoteAvailable: false,
          },
        ]),
      },
      settings: {},
    } as any;

    const options = await loadChatModelPickerOptions(plugin);
    const localOption = options.find((option) => option.value === "local-pi-lmstudio@@qwen2.5-coder:7b");
    const hostedOption = options.find((option) => option.value === "local-pi-openrouter@@openai/gpt-5.4-mini");

    expect(loadPiTextLocalProviderIds).toHaveBeenCalledWith(plugin);
    expect(localOption).toEqual(
      expect.objectContaining({
        section: "local",
        providerAuthenticated: false,
      })
    );
    expect(hostedOption).toEqual(
      expect.objectContaining({
        section: "pi",
        providerAuthenticated: true,
      })
    );
  });

  it("marks configured remote provider models as authenticated on mobile without local provider ids", async () => {
    (loadPiTextProviderAuth as jest.Mock).mockResolvedValue(
      new Map([
        [
          "openrouter",
          {
            provider: "openrouter",
            hasAnyAuth: true,
          },
        ],
      ])
    );
    const plugin = {
      modelService: {
        getModels: jest.fn().mockResolvedValue([
          {
            id: "openrouter@@openai/gpt-5.4-mini",
            name: "GPT-5.4 Mini",
            provider: "openrouter",
            sourceProviderId: "openrouter",
            sourceMode: "custom_endpoint",
            piRemoteAvailable: true,
            piLocalAvailable: false,
          },
        ]),
      },
      settings: {},
    } as any;

    const options = await loadChatModelPickerOptions(plugin);
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual(
      expect.objectContaining({
        section: "pi",
        providerAuthenticated: true,
        providerId: "openrouter",
      })
    );
  });
});
