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
  applyChatModelFavorites,
  loadChatModelPickerOptions,
  openChatModelSetupTab,
  promptChatModelSetup,
  type ChatModelPickerOption,
} from "../modelSelection";
import { ensureCanonicalId } from "../../../utils/modelUtils";

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

  it("surfaces the catalog error reason instead of returning a silent empty list", async () => {
    const plugin = {
      modelService: {
        getModels: jest.fn().mockResolvedValue([]),
        getCatalogStatus: jest.fn(() => ({
          state: "error",
          reason: "OpenRouter endpoint unreachable",
        })),
      },
      settings: {},
    } as any;

    await expect(loadChatModelPickerOptions(plugin)).rejects.toThrow(
      "OpenRouter endpoint unreachable"
    );
  });

  it("returns an empty list without throwing when the catalog is ready but empty", async () => {
    const plugin = {
      modelService: {
        getModels: jest.fn().mockResolvedValue([]),
        getCatalogStatus: jest.fn(() => ({ state: "ready", reason: null })),
      },
      settings: {},
    } as any;

    await expect(loadChatModelPickerOptions(plugin)).resolves.toEqual([]);
  });

  it("returns an empty list when the model service exposes no catalog status", async () => {
    const plugin = {
      modelService: { getModels: jest.fn().mockResolvedValue([]) },
      settings: {},
    } as any;

    await expect(loadChatModelPickerOptions(plugin)).resolves.toEqual([]);
  });
});

describe("applyChatModelFavorites", () => {
  const favOption = (
    overrides: Partial<ChatModelPickerOption> &
      Pick<ChatModelPickerOption, "value" | "label" | "section" | "providerLabel">,
  ): ChatModelPickerOption => ({
    value: overrides.value,
    label: overrides.label,
    description: overrides.description,
    badge: overrides.badge,
    keywords: overrides.keywords,
    providerAuthenticated: overrides.providerAuthenticated ?? true,
    providerId: overrides.providerId || overrides.providerLabel.toLowerCase(),
    providerLabel: overrides.providerLabel,
    contextLabel: overrides.contextLabel,
    section: overrides.section,
    icon: overrides.icon || "cloud",
    isFavorite: overrides.isFavorite,
    setupSurface: overrides.setupSurface || {
      targetTab: "providers",
      title: "Finish setup",
      primaryButton: "Open Providers",
    },
  });

  // Section order (systemsculpt -> pi -> local) and, within pi, provider label
  // order put Claude (Anthropic) ahead of GPT-4.1 (OpenAI) by default — so
  // favoriting GPT-4.1 is what proves favorites-first actually reorders.
  const baseOptions = (): ChatModelPickerOption[] => [
    favOption({
      value: "systemsculpt@@systemsculpt/ai-agent",
      label: "SystemSculpt Agent",
      section: "systemsculpt",
      providerLabel: "SystemSculpt",
      providerId: "systemsculpt",
      icon: "sparkles",
    }),
    favOption({
      value: "anthropic@@claude-3-7-sonnet",
      label: "Claude 3.7 Sonnet",
      section: "pi",
      providerLabel: "Anthropic",
      providerId: "anthropic",
    }),
    favOption({
      value: "openai@@gpt-4.1",
      label: "GPT-4.1",
      section: "pi",
      providerLabel: "OpenAI",
      providerId: "openai",
    }),
    favOption({
      value: "local-ollama@@qwen2.5-coder",
      label: "Qwen 2.5 Coder",
      section: "local",
      providerLabel: "Ollama",
      providerId: "ollama",
      icon: "hard-drive",
    }),
  ];

  it("annotates isFavorite by canonical id and preserves default order when no flags are set", () => {
    const favoriteIds = new Set([ensureCanonicalId("openai@@gpt-4.1")]);
    const result = applyChatModelFavorites(baseOptions(), {
      favoriteIds,
      showFavoritesOnly: false,
      favoritesFirst: false,
    });

    expect(result.map((option) => option.value)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
      "anthropic@@claude-3-7-sonnet",
      "openai@@gpt-4.1",
      "local-ollama@@qwen2.5-coder",
    ]);
    expect(result.find((option) => option.value === "openai@@gpt-4.1")?.isFavorite).toBe(true);
    expect(result.find((option) => option.value === "anthropic@@claude-3-7-sonnet")?.isFavorite).toBe(
      false,
    );
  });

  it("bubbles favorites to the top of their section when favoritesFirst is enabled", () => {
    const favoriteIds = new Set([ensureCanonicalId("openai@@gpt-4.1")]);
    const result = applyChatModelFavorites(baseOptions(), {
      favoriteIds,
      showFavoritesOnly: false,
      favoritesFirst: true,
    });

    // GPT-4.1 (favorited) now leads the Pi section ahead of Claude, while the
    // section grouping (systemsculpt -> pi -> local) stays intact.
    expect(result.map((option) => option.value)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
      "openai@@gpt-4.1",
      "anthropic@@claude-3-7-sonnet",
      "local-ollama@@qwen2.5-coder",
    ]);
  });

  it("filters to favorites only, always keeping managed SystemSculpt models visible", () => {
    const favoriteIds = new Set([ensureCanonicalId("openai@@gpt-4.1")]);
    const result = applyChatModelFavorites(baseOptions(), {
      favoriteIds,
      showFavoritesOnly: true,
      favoritesFirst: true,
    });

    expect(result.map((option) => option.value)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
      "openai@@gpt-4.1",
    ]);
  });

  it("is an identity reorder with no favorites (back-compat with the default picker)", () => {
    const result = applyChatModelFavorites(baseOptions(), {
      favoriteIds: new Set<string>(),
      showFavoritesOnly: false,
      favoritesFirst: false,
    });

    expect(result.map((option) => option.value)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
      "anthropic@@claude-3-7-sonnet",
      "openai@@gpt-4.1",
      "local-ollama@@qwen2.5-coder",
    ]);
    expect(result.every((option) => option.isFavorite === false)).toBe(true);
  });
});
