import {
  listConfiguredRemoteProviderModels,
  resolveRemoteProviderEndpoint,
  getConfiguredRemoteProviderApiKey,
} from "../RemoteProviderCatalog";
import { AI_PROVIDERS } from "../../../constants/externalServices";

jest.mock("../../../studio/piAuth/StudioPiProviderRegistry", () => ({
  resolveProviderLabel: jest.fn((id: string) => id),
  resolvePiProviderFromEndpoint: jest.fn((endpoint: string) => {
    if (endpoint.includes("openrouter")) return "openrouter";
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

    it("is case-insensitive", () => {
      expect(resolveRemoteProviderEndpoint("OpenRouter")).toBe(
        AI_PROVIDERS.OPENROUTER.BASE_URL
      );
    });

    it("returns empty string for unknown providers", () => {
      expect(resolveRemoteProviderEndpoint("anthropic")).toBe("");
      expect(resolveRemoteProviderEndpoint("")).toBe("");
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
