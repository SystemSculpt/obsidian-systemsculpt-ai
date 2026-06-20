import {
  listConfiguredRemoteProviderModels,
  resolveRemoteProviderEndpoint,
  resolveConfiguredRemoteProviderEndpoint,
  getConfiguredRemoteProviderApiKey,
} from "../RemoteProviderCatalog";
import { AI_PROVIDERS } from "../../../constants/externalServices";

jest.mock("../../../studio/piAuth/StudioPiProviderRegistry", () => ({
  resolveProviderLabel: jest.fn((id: string) => id),
  resolvePiProviderFromEndpoint: jest.fn((endpoint: string) => {
    if (endpoint.includes("openrouter")) return "openrouter";
    if (endpoint.includes("api.x.ai") || endpoint.includes("x.ai")) return "xai";
    return null;
  }),
}));

function makePlugin(customProviders: any[] = []): any {
  return { settings: { customProviders } };
}

describe("RemoteProviderCatalog", () => {
  describe("resolveRemoteProviderEndpoint", () => {
    it("returns the OpenRouter base URL for the openrouter provider", () => {
      expect(resolveRemoteProviderEndpoint("openrouter")).toBe(
        AI_PROVIDERS.OPENROUTER.BASE_URL
      );
    });

    it("returns the xAI base URL for the xai provider", () => {
      expect(resolveRemoteProviderEndpoint("xai")).toBe(
        AI_PROVIDERS.XAI.BASE_URL
      );
    });

    it("returns the OpenAI base URL for the openai provider", () => {
      expect(resolveRemoteProviderEndpoint("openai")).toBe(
        AI_PROVIDERS.OPENAI.BASE_URL
      );
    });

    it("returns the Anthropic base URL for the anthropic provider (#230)", () => {
      expect(resolveRemoteProviderEndpoint("anthropic")).toBe(
        AI_PROVIDERS.ANTHROPIC.BASE_URL
      );
    });

    it("returns the Google base URL for the google provider (#231)", () => {
      expect(resolveRemoteProviderEndpoint("google")).toBe(
        AI_PROVIDERS.GOOGLE.BASE_URL
      );
    });

    it("is case-insensitive", () => {
      expect(resolveRemoteProviderEndpoint("OpenRouter")).toBe(
        AI_PROVIDERS.OPENROUTER.BASE_URL
      );
      expect(resolveRemoteProviderEndpoint("XAI")).toBe(
        AI_PROVIDERS.XAI.BASE_URL
      );
    });

    it("returns empty string for unknown providers", () => {
      expect(resolveRemoteProviderEndpoint("cohere")).toBe("");
      expect(resolveRemoteProviderEndpoint("")).toBe("");
    });
  });

  describe("resolveConfiguredRemoteProviderEndpoint", () => {
    it("prefers the enabled custom provider's configured endpoint", () => {
      const plugin = makePlugin([
        { id: "openrouter", endpoint: "http://127.0.0.1:4310/api/v1/", apiKey: "k", isEnabled: true },
      ]);
      expect(resolveConfiguredRemoteProviderEndpoint(plugin, "openrouter")).toBe(
        "http://127.0.0.1:4310/api/v1"
      );
    });

    it("falls back to the canonical base URL when no entry matches", () => {
      expect(resolveConfiguredRemoteProviderEndpoint(makePlugin(), "openrouter")).toBe(
        AI_PROVIDERS.OPENROUTER.BASE_URL
      );
    });

    it("ignores disabled entries and invalid endpoints", () => {
      const disabled = makePlugin([
        { id: "openrouter", endpoint: "http://127.0.0.1:4310", apiKey: "k", isEnabled: false },
      ]);
      expect(resolveConfiguredRemoteProviderEndpoint(disabled, "openrouter")).toBe(
        AI_PROVIDERS.OPENROUTER.BASE_URL
      );

      const invalid = makePlugin([
        { id: "openrouter", endpoint: "not-a-url", apiKey: "k", isEnabled: true },
      ]);
      expect(resolveConfiguredRemoteProviderEndpoint(invalid, "openrouter")).toBe(
        AI_PROVIDERS.OPENROUTER.BASE_URL
      );
    });
  });

  describe("getConfiguredRemoteProviderApiKey", () => {
    it("returns the API key for a matching enabled custom provider", () => {
      const plugin = makePlugin([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test-key",
          isEnabled: true,
        },
      ]);

      expect(getConfiguredRemoteProviderApiKey(plugin, "openrouter")).toBe(
        "sk-or-test-key"
      );
    });

    it("returns the API key for a matching enabled xAI provider", () => {
      const plugin = makePlugin([
        {
          id: "xai",
          name: "xAI",
          endpoint: "https://api.x.ai/v1",
          apiKey: "xai-test-key",
          isEnabled: true,
        },
      ]);

      expect(getConfiguredRemoteProviderApiKey(plugin, "xai")).toBe(
        "xai-test-key"
      );
    });

    it("returns empty string when provider is disabled", () => {
      const plugin = makePlugin([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-test-key",
          isEnabled: false,
        },
      ]);

      expect(getConfiguredRemoteProviderApiKey(plugin, "openrouter")).toBe("");
    });

    it("returns empty string when no API key is set", () => {
      const plugin = makePlugin([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "",
          isEnabled: true,
        },
      ]);

      expect(getConfiguredRemoteProviderApiKey(plugin, "openrouter")).toBe("");
    });

    it("returns empty string when no custom providers match", () => {
      const plugin = makePlugin([
        {
          id: "anthropic",
          name: "Anthropic",
          endpoint: "https://api.anthropic.com",
          apiKey: "sk-ant-key",
          isEnabled: true,
        },
      ]);

      expect(getConfiguredRemoteProviderApiKey(plugin, "openrouter")).toBe("");
    });

    it("handles missing customProviders gracefully", () => {
      expect(
        getConfiguredRemoteProviderApiKey({ settings: {} } as any, "openrouter")
      ).toBe("");
    });

    it("matches provider by endpoint when id and name are empty", () => {
      const plugin = makePlugin([
        {
          id: "",
          name: "",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-endpoint-match",
          isEnabled: true,
        },
      ]);

      expect(getConfiguredRemoteProviderApiKey(plugin, "openrouter")).toBe(
        "sk-or-endpoint-match"
      );
    });

    it("matches xAI by endpoint when id and name are empty", () => {
      const plugin = makePlugin([
        {
          id: "",
          name: "",
          endpoint: "https://api.x.ai/v1",
          apiKey: "xai-endpoint-match",
          isEnabled: true,
        },
      ]);

      expect(getConfiguredRemoteProviderApiKey(plugin, "xai")).toBe(
        "xai-endpoint-match"
      );
    });
  });

  describe("listConfiguredRemoteProviderModels", () => {
    it("returns remote provider models when matching provider is configured", () => {
      const plugin = makePlugin([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-key",
          isEnabled: true,
        },
      ]);

      const models = listConfiguredRemoteProviderModels(plugin);

      expect(models.length).toBeGreaterThan(0);
      const model = models[0];
      expect(model.id).toContain("openrouter");
      expect(model.sourceMode).toBe("custom_endpoint");
      expect(model.sourceProviderId).toBe("openrouter");
      expect(model.piRemoteAvailable).toBe(true);
      expect(model.piLocalAvailable).toBe(false);
      expect(model.piAuthMode).toBe("byok");
      expect(model.piExecutionModelId).toBeTruthy();
      expect(model.supported_parameters).toContain("tools");
    });

    it("returns Grok 4.3 when xAI is configured", () => {
      const plugin = makePlugin([
        {
          id: "xai",
          name: "xAI",
          endpoint: "https://api.x.ai/v1",
          apiKey: "xai-key",
          isEnabled: true,
        },
      ]);

      const models = listConfiguredRemoteProviderModels(plugin);
      const grok = models.find((model) => model.id === "xai@@grok-4.3");

      expect(grok).toMatchObject({
        id: "xai@@grok-4.3",
        name: "Grok 4.3",
        provider: "xai",
        sourceMode: "custom_endpoint",
        sourceProviderId: "xai",
        piRemoteAvailable: true,
        piLocalAvailable: false,
        piAuthMode: "byok",
        piExecutionModelId: "grok-4.3",
        context_length: 1_000_000,
      });
      expect(grok?.supported_parameters).toContain("tools");
      expect(grok?.capabilities).toEqual(
        expect.arrayContaining(["chat", "reasoning", "vision"])
      );
    });

    it("returns GPT-5.4 Mini when OpenAI is configured", () => {
      const plugin = makePlugin([
        {
          id: "openai",
          name: "OpenAI",
          endpoint: "https://api.openai.com/v1",
          apiKey: "sk-openai-key",
          isEnabled: true,
        },
      ]);

      const models = listConfiguredRemoteProviderModels(plugin);
      const gpt = models.find((model) => model.id === "openai@@gpt-5.4-mini");

      expect(gpt).toMatchObject({
        id: "openai@@gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        provider: "openai",
        sourceMode: "custom_endpoint",
        sourceProviderId: "openai",
        piRemoteAvailable: true,
        piLocalAvailable: false,
        piAuthMode: "byok",
        piExecutionModelId: "gpt-5.4-mini",
      });
      expect(gpt?.supported_parameters).toContain("tools");
    });

    it("returns Claude Sonnet 4.6 when Anthropic is configured (#230)", () => {
      const plugin = makePlugin([
        {
          id: "anthropic",
          name: "Anthropic",
          endpoint: "https://api.anthropic.com/v1",
          apiKey: "sk-ant-key",
          isEnabled: true,
        },
      ]);

      const models = listConfiguredRemoteProviderModels(plugin);
      const claude = models.find((model) => model.id === "anthropic@@claude-sonnet-4-6");

      expect(claude).toMatchObject({
        id: "anthropic@@claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        sourceMode: "custom_endpoint",
        sourceProviderId: "anthropic",
        piRemoteAvailable: true,
        piLocalAvailable: false,
        piAuthMode: "byok",
        piExecutionModelId: "claude-sonnet-4-6",
        context_length: 200_000,
      });
      expect(claude?.supported_parameters).toContain("tools");
      expect(claude?.capabilities).toEqual(
        expect.arrayContaining(["chat", "reasoning", "vision"])
      );
    });

    it("returns Gemini 3 Flash when Google is configured (#231)", () => {
      const plugin = makePlugin([
        {
          id: "google",
          name: "Google Gemini",
          endpoint: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-key",
          isEnabled: true,
        },
      ]);

      const models = listConfiguredRemoteProviderModels(plugin);
      const gemini = models.find((model) => model.id === "google@@gemini-3-flash-preview");

      expect(gemini).toMatchObject({
        id: "google@@gemini-3-flash-preview",
        name: "Gemini 3 Flash",
        provider: "google",
        sourceMode: "custom_endpoint",
        sourceProviderId: "google",
        piRemoteAvailable: true,
        piLocalAvailable: false,
        piAuthMode: "byok",
        piExecutionModelId: "gemini-3-flash-preview",
        context_length: 1_000_000,
      });
      expect(gemini?.supported_parameters).toContain("tools");
      expect(gemini?.capabilities).toEqual(
        expect.arrayContaining(["chat", "reasoning", "vision"])
      );
    });

    it("gives every configured remote provider model a resolvable execution endpoint (#201 contract)", () => {
      // The core #201 failure mode: a model appears in the Chat dropdown but
      // has no execution endpoint, so selecting it throws "No remote endpoint
      // configured". Lock catalog appearance to executability so a future seed
      // can never ship that gap again.
      const plugin = makePlugin([
        { id: "openrouter", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", apiKey: "k", isEnabled: true },
        { id: "xai", name: "xAI", endpoint: "https://api.x.ai/v1", apiKey: "k", isEnabled: true },
        { id: "openai", name: "OpenAI", endpoint: "https://api.openai.com/v1", apiKey: "k", isEnabled: true },
        { id: "anthropic", name: "Anthropic", endpoint: "https://api.anthropic.com/v1", apiKey: "k", isEnabled: true },
        { id: "google", name: "Google Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta", apiKey: "k", isEnabled: true },
      ]);

      const models = listConfiguredRemoteProviderModels(plugin);
      expect(models.length).toBeGreaterThanOrEqual(5);
      for (const model of models) {
        expect(resolveRemoteProviderEndpoint(String(model.sourceProviderId))).not.toBe("");
      }
    });

    it("returns empty array when no matching provider is configured", () => {
      const plugin = makePlugin([]);
      expect(listConfiguredRemoteProviderModels(plugin)).toEqual([]);
    });

    it("excludes models whose provider is disabled", () => {
      const plugin = makePlugin([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-key",
          isEnabled: false,
        },
      ]);

      expect(listConfiguredRemoteProviderModels(plugin)).toEqual([]);
    });

    it("excludes models whose provider has no API key", () => {
      const plugin = makePlugin([
        {
          id: "openrouter",
          name: "OpenRouter",
          endpoint: "https://openrouter.ai/api/v1",
          apiKey: "",
          isEnabled: true,
        },
      ]);

      expect(listConfiguredRemoteProviderModels(plugin)).toEqual([]);
    });
  });
});
