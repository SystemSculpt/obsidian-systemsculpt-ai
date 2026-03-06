import { Platform } from "obsidian";
import {
  hasAuthenticatedModelSelectorProvider,
  normalizeModelSelectorProviderId,
} from "../StandardModelSelectionModal";
import { buildModelSelectionListItems } from "../model-selection/ModelSelectionItems";
import { buildModelSelectionProviderSummary } from "../model-selection/ModelSelectionProviderAuth";
import {
  buildLocalPiCanonicalModelId,
  buildLocalPiExecutionModelId,
  resolveLocalPiExecutionModelIdFromCanonical,
} from "../../services/pi/PiTextModels";

describe("StandardModelSelectionModal auth helpers", () => {
  beforeEach(() => {
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: false,
    });
  });

  it("normalizes provider IDs safely", () => {
    expect(normalizeModelSelectorProviderId(" OpenAI-Codex ")).toBe("openai-codex");
    expect(normalizeModelSelectorProviderId("")).toBe("");
    expect(normalizeModelSelectorProviderId(null)).toBe("");
  });

  it("detects authenticated providers from stored credential flags", () => {
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "anthropic",
        hasAnyAuth: true,
        hasStoredCredential: true,
        credentialType: "none",
      })
    ).toBe(true);
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "openai-codex",
        hasAnyAuth: true,
        hasStoredCredential: false,
        credentialType: "oauth",
      })
    ).toBe(true);
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "openai",
        hasAnyAuth: true,
        hasStoredCredential: false,
        credentialType: "api_key",
      })
    ).toBe(true);
    expect(
      hasAuthenticatedModelSelectorProvider({
        provider: "openrouter",
        hasAnyAuth: false,
        hasStoredCredential: false,
        credentialType: "none",
      })
    ).toBe(false);
  });

  it("builds a provider-first summary for local-ready, connected, and unavailable providers", () => {
    const models = [
      { id: "openai@@gpt-4.1", provider: "openai", name: "GPT-4.1", piLocalAvailable: true },
      { id: "anthropic@@claude-3.7", provider: "anthropic", name: "Claude 3.7", piLocalAvailable: true },
      { id: "openrouter@@google/gemini-3-flash-preview", provider: "openrouter", name: "Gemini 3 Flash" },
    ] as any;

    const summary = buildModelSelectionProviderSummary(
      models,
      new Map([
        [
          "openai",
          {
            provider: "openai",
            hasAnyAuth: true,
            hasStoredCredential: true,
            credentialType: "api_key",
            displayName: "OpenAI",
          },
        ],
      ]),
      {
        selectedModelId: "openai@@gpt-4.1",
        resolveProviderLabel: (provider) =>
          provider === "openrouter" ? "OpenRouter" : provider === "openai" ? "OpenAI" : "Anthropic",
      }
    );

    expect(summary.totalModels).toBe(3);
    expect(summary.totalProviders).toBe(3);
    expect(summary.piReadyProviders).toBe(0);
    expect(summary.managedProviders).toBe(0);
    expect(summary.localProviders).toBe(1);
    expect(summary.unavailableProviders).toBe(2);
    expect(summary.providers[0]).toMatchObject({
      providerId: "openai",
      accessState: "local",
      isCurrentProvider: true,
    });
    expect(summary.providers.map((provider) => provider.accessState)).toContain("unavailable");
  });

  it("shows authenticated Pi providers even before models are discovered", () => {
    const summary = buildModelSelectionProviderSummary(
      [],
      new Map([
        [
          "openai",
          {
            provider: "openai",
            hasAnyAuth: true,
            hasStoredCredential: true,
            credentialType: "api_key",
            displayName: "OpenAI",
          },
        ],
      ]),
      {
        resolveProviderLabel: () => "OpenAI",
      }
    );

    expect(summary.totalModels).toBe(0);
    expect(summary.totalProviders).toBe(1);
    expect(summary.piReadyProviders).toBe(1);
    expect(summary.providers[0]).toMatchObject({
      providerId: "openai",
      modelCount: 0,
      accessState: "pi-auth",
    });
  });

  it("decorates model items with provider access copy and classes", () => {
    const items = buildModelSelectionListItems(
      [
        {
          id: "openai@@gpt-4.1",
          provider: "openai",
          name: "GPT-4.1",
          description: "Fast and strong",
          context_length: 128000,
          pricing: { input: "0.01", output: "0.03" },
          piLocalAvailable: true,
        },
        {
          id: "anthropic@@claude-3.7",
          provider: "anthropic",
          name: "Claude 3.7",
          description: "Reasoning model",
          context_length: 200000,
          piLocalAvailable: true,
        },
      ] as any,
      {
        selectedModelId: "openai@@gpt-4.1",
        resolveProviderLabel: (provider) => (provider === "openai" ? "OpenAI" : "Anthropic"),
        resolveModelAccessState: (model) => (model.provider === "openai" ? "pi-auth" : "unavailable"),
      }
    );

    expect(items[0]).toMatchObject({
      id: "openai@@gpt-4.1",
      badge: "OpenAI ✓",
      selected: true,
    });
    expect(items[0].description).toContain("Pi connected via OpenAI");
    expect((items[0] as any).additionalClasses).toContain("ss-provider-access-pi-auth");
    expect(items[1].description).toContain("Connect in Pi");
    expect(items[1].disabled).toBe(true);
  });

  it("treats desktop local Pi models without auth as unavailable", () => {
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });

    const summary = buildModelSelectionProviderSummary(
      [
        {
          id: "anthropic@@claude-sonnet-4-6",
          provider: "anthropic",
          name: "Claude Sonnet 4.6",
          piLocalAvailable: true,
        },
      ] as any,
      new Map(),
      {
        selectedModelId: "anthropic@@claude-sonnet-4-6",
        resolveProviderLabel: () => "Anthropic",
      }
    );

    expect(summary.providers[0]).toMatchObject({
      providerId: "anthropic",
      accessState: "unavailable",
    });
  });

  it("creates collision-safe canonical IDs for Local Pi models", () => {
    const canonicalId = buildLocalPiCanonicalModelId("openai", "gpt-4.1");
    expect(canonicalId).toBe("local-pi-openai@@gpt-4.1");
    expect(buildLocalPiExecutionModelId("openai", "gpt-4.1")).toBe("openai/gpt-4.1");
    expect(resolveLocalPiExecutionModelIdFromCanonical(canonicalId)).toBe("openai/gpt-4.1");
  });
});
