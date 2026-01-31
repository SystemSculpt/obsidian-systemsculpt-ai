import { CustomProviderModelService } from "../CustomProviderModelService";
import type { CustomProvider, SystemSculptModel } from "../../../types/llm";

// Mock dependencies
jest.mock("../../CustomProviderService", () => ({
  CustomProviderService: jest.fn().mockImplementation(() => ({
    testConnection: jest.fn(),
  })),
}));

jest.mock("../ProviderErrorManager", () => ({
  ProviderErrorManager: jest.fn().mockImplementation(() => ({
    reportCustomProviderError: jest.fn(),
    getProviderHealth: jest.fn().mockReturnValue({
      status: "healthy",
      recentErrorCount: 0,
    }),
  })),
}));

jest.mock("../../../utils/modelUtils", () => ({
  createCanonicalId: jest.fn((provider, model) => `${provider}/${model}`),
  getCanonicalId: jest.fn((id) => id),
  filterChatModels: jest.fn((models) =>
    models.filter((m: any) => !m.id.includes("embed"))
  ),
}));

jest.mock("../../../constants/anthropic", () => ({
  isAnthropicEndpoint: jest.fn((endpoint) => endpoint.includes("anthropic")),
  ANTHROPIC_MODELS: [
    {
      id: "claude-3-opus-20240229",
      name: "Claude 3 Opus",
      contextWindow: 200000,
      maxOutput: 4096,
      capabilities: ["vision"],
      supportsStreaming: true,
      supportsTools: true,
    },
  ],
}));

jest.mock("../../../core/ui/notifications", () => ({
  showNoticeWhenReady: jest.fn(),
}));

const createMockPlugin = () => ({
  settings: {
    customProviders: [] as CustomProvider[],
  },
  customProviderService: {
    testConnection: jest.fn(),
  },
  app: {},
  emitter: {
    emitWithProvider: jest.fn(),
  },
  getSettingsManager: jest.fn().mockReturnValue({
    getSettings: jest.fn().mockImplementation(function(this: any) {
      return (this as any)._parentPlugin?.settings || { customProviders: [] };
    }),
    saveSettings: jest.fn().mockResolvedValue(undefined),
  }),
});

describe("CustomProviderModelService", () => {
  let mockPlugin: ReturnType<typeof createMockPlugin>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    CustomProviderModelService.clearInstance();
    mockPlugin = createMockPlugin();
    // Link settings manager to plugin
    (mockPlugin.getSettingsManager() as any)._parentPlugin = mockPlugin;
  });

  afterEach(() => {
    jest.useRealTimers();
    CustomProviderModelService.clearInstance();
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = CustomProviderModelService.getInstance(mockPlugin as any);
      const instance2 = CustomProviderModelService.getInstance(mockPlugin as any);

      expect(instance1).toBe(instance2);
    });

    it("creates new instance after clearInstance", () => {
      const instance1 = CustomProviderModelService.getInstance(mockPlugin as any);
      CustomProviderModelService.clearInstance();
      const instance2 = CustomProviderModelService.getInstance(mockPlugin as any);

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("clearInstance", () => {
    it("clears singleton and caches", () => {
      const instance = CustomProviderModelService.getInstance(mockPlugin as any);
      (instance as any).providerCaches.set("test", { models: [], timestamp: 0 });

      CustomProviderModelService.clearInstance();

      const newInstance = CustomProviderModelService.getInstance(mockPlugin as any);
      expect((newInstance as any).providerCaches.size).toBe(0);
    });
  });

  describe("getProviderType", () => {
    it("returns 'custom'", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      expect(service.getProviderType()).toBe("custom");
    });
  });

  describe("testConnection", () => {
    it("returns true when no providers enabled", async () => {
      mockPlugin.settings.customProviders = [];
      const service = CustomProviderModelService.getInstance(mockPlugin as any);

      const result = await service.testConnection();

      expect(result).toBe(true);
    });

    it("returns true when at least one provider connects successfully", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "Provider1", endpoint: "http://test1", apiKey: "key1", isEnabled: true },
        { id: "2", name: "Provider2", endpoint: "http://test2", apiKey: "key2", isEnabled: true },
      ];
      mockPlugin.customProviderService.testConnection
        .mockRejectedValueOnce(new Error("Failed"))
        .mockResolvedValueOnce({ success: true });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.testConnection();

      expect(result).toBe(true);
    });

    it("returns false when all providers fail", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "Provider1", endpoint: "http://test1", apiKey: "key1", isEnabled: true },
      ];
      mockPlugin.customProviderService.testConnection.mockResolvedValue({ success: false });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.testConnection();

      expect(result).toBe(false);
    });

    it("returns false on exception", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "Provider1", endpoint: "http://test1", apiKey: "key1", isEnabled: true },
      ];
      mockPlugin.customProviderService.testConnection.mockRejectedValue(new Error("Network error"));

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.testConnection();

      expect(result).toBe(false);
    });

    it("skips disabled providers", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "Provider1", endpoint: "http://test1", apiKey: "key1", isEnabled: false },
      ];

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.testConnection();

      expect(result).toBe(true);
      expect(mockPlugin.customProviderService.testConnection).not.toHaveBeenCalled();
    });
  });

  describe("getModels", () => {
    it("returns cached models if available", async () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const cachedModels: SystemSculptModel[] = [
        { id: "test/model1", name: "Model 1", provider: "test" } as any,
      ];
      (service as any).models = cachedModels;
      (service as any).lastFetchTime = Date.now();

      const result = await service.getModels();

      expect(result).toBe(cachedModels);
    });

    it("loads models when cache is empty", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "TestProvider", endpoint: "http://test", apiKey: "key", isEnabled: true },
      ];
      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [{ id: "model1", name: "Model 1" }],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModels();

      expect(result.length).toBe(1);
      expect(result[0].id).toBe("testprovider/model1");
    });

    it("propagates provider model metadata (vision + tools) into SystemSculptModel", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1", apiKey: "key", isEnabled: true },
      ];
      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [
          {
            id: "x-ai/grok-4.1-fast",
            name: "Grok 4.1 Fast",
            contextWindow: 131072,
            capabilities: ["vision"],
            supported_parameters: ["tools", "max_tokens"],
            architecture: { modality: "text+image->text", tokenizer: "Grok", instruct_type: null },
            pricing: { prompt: "0.000001", completion: "0.000002", image: "0.000003", request: "0" },
          },
        ],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModels();

      expect(result).toHaveLength(1);
      expect(result[0].architecture.modality).toBe("text+image->text");
      expect(result[0].capabilities).toContain("vision");
      expect(result[0].supported_parameters).toContain("tools");
    });

    it("forces provider refresh when forceRefresh is true", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "TestProvider", endpoint: "http://test", apiKey: "key", isEnabled: true },
      ];
      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [{ id: "model1", name: "Model 1" }],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).models = [{ id: "cached/model", name: "Cached", provider: "test" } as any];
      (service as any).lastFetchTime = Date.now();

      await service.getModels(true);

      expect(mockPlugin.customProviderService.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: "1" }),
        { force: true }
      );
    });

    it("returns empty array when no providers enabled", async () => {
      mockPlugin.settings.customProviders = [];

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModels();

      expect(result).toEqual([]);
    });
  });

  describe("getModelsDeferred", () => {
    it("returns cached models immediately", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const cachedModels: SystemSculptModel[] = [
        { id: "test/model1", name: "Model 1", provider: "test" } as any,
      ];
      (service as any).models = cachedModels;
      (service as any).lastFetchTime = Date.now();

      const result = service.getModelsDeferred();

      expect(result).toBe(cachedModels);
    });

    it("returns empty array and triggers loading when no cache", () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "Test", endpoint: "http://test", apiKey: "key", isEnabled: true },
      ];
      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = service.getModelsDeferred();

      expect(result).toEqual([]);
      expect((service as any).deferredPrefetchStarted).toBe(true);
    });

    it("does not trigger loading multiple times", () => {
      mockPlugin.settings.customProviders = [];
      const service = CustomProviderModelService.getInstance(mockPlugin as any);

      service.getModelsDeferred();
      service.getModelsDeferred();
      service.getModelsDeferred();

      // Only one loading should have started
      expect((service as any).deferredPrefetchStarted).toBe(true);
    });
  });

  describe("getModelsFromProvider", () => {
    it("returns cached provider models if not expired", async () => {
      const provider: CustomProvider = {
        id: "test",
        name: "Test",
        endpoint: "http://test",
        apiKey: "key",
        isEnabled: true,
      };
      const cachedModels: SystemSculptModel[] = [
        { id: "test/model1", name: "Model 1", provider: "test" } as any,
      ];

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).providerCaches.set("test", {
        models: cachedModels,
        timestamp: Date.now(),
      });

      const result = await service.getModelsFromProvider(provider);

      expect(result).toBe(cachedModels);
      expect(mockPlugin.customProviderService.testConnection).not.toHaveBeenCalled();
    });

    it("fetches models when cache expired", async () => {
      const provider: CustomProvider = {
        id: "test",
        name: "TestProvider",
        endpoint: "http://test",
        apiKey: "key",
        isEnabled: true,
      };

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [{ id: "fresh-model", name: "Fresh Model" }],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      // Set expired cache
      (service as any).providerCaches.set("test", {
        models: [],
        timestamp: Date.now() - 60 * 60 * 1000, // 1 hour ago
      });

      const result = await service.getModelsFromProvider(provider);

      expect(result.length).toBe(1);
      expect(result[0].id).toBe("testprovider/fresh-model");
    });

    it("returns empty array on connection failure", async () => {
      const provider: CustomProvider = {
        id: "test",
        name: "Test",
        endpoint: "http://test",
        apiKey: "key",
        isEnabled: true,
      };

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: false,
        error: "Connection failed",
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModelsFromProvider(provider);

      expect(result).toEqual([]);
    });

    it("enriches Anthropic models with metadata", async () => {
      const provider: CustomProvider = {
        id: "anthropic",
        name: "Anthropic",
        endpoint: "https://api.anthropic.com",
        apiKey: "key",
        isEnabled: true,
      };

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [{ id: "claude-3-opus-20240229" }],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModelsFromProvider(provider);

      expect(result.length).toBe(1);
      expect(result[0].name).toBe("Claude 3 Opus");
      expect(result[0].context_length).toBe(200000);
      expect(result[0].capabilities).toContain("vision");
    });
  });

  describe("getModelsForProviders", () => {
    it("returns empty array for empty providers list", async () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModelsForProviders([]);

      expect(result).toEqual([]);
    });

    it("fetches models from multiple providers", async () => {
      const providers: CustomProvider[] = [
        { id: "1", name: "Provider1", endpoint: "http://test1", apiKey: "key1", isEnabled: true },
        { id: "2", name: "Provider2", endpoint: "http://test2", apiKey: "key2", isEnabled: true },
      ];

      mockPlugin.customProviderService.testConnection
        .mockResolvedValueOnce({ success: true, models: [{ id: "m1" }] })
        .mockResolvedValueOnce({ success: true, models: [{ id: "m2" }] });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModelsForProviders(providers);

      expect(result.length).toBe(2);
    });
  });

  describe("findBestAlternativeModel", () => {
    it("returns undefined when no models available", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).models = null;

      const result = service.findBestAlternativeModel("some-model");

      expect(result).toBeUndefined();
    });

    it("returns undefined when models array is empty", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).models = [];

      const result = service.findBestAlternativeModel("some-model");

      expect(result).toBeUndefined();
    });

    it("excludes the unavailable model from results", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).models = [
        { id: "model1", provider: "test" },
        { id: "model2", provider: "test" },
      ];

      const result = service.findBestAlternativeModel("model1");

      expect(result?.id).toBe("model2");
    });

    it("prefers models from the same provider", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).models = [
        { id: "other/model1", provider: "other" },
        { id: "same/model2", provider: "same" },
      ];
      (service as any).modelDetailsCache.set("unavailable", { id: "unavailable", provider: "same" });

      const result = service.findBestAlternativeModel("unavailable");

      expect(result?.provider).toBe("same");
    });

    it("returns first available when no same-provider model", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).models = [
        { id: "other/model1", provider: "other" },
      ];
      (service as any).modelDetailsCache.set("unavailable", { id: "unavailable", provider: "different" });

      const result = service.findBestAlternativeModel("unavailable");

      expect(result?.id).toBe("other/model1");
    });
  });

  describe("getCachedModelById", () => {
    it("returns cached model by ID", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const model = { id: "test-model", name: "Test" } as SystemSculptModel;
      (service as any).modelDetailsCache.set("test-model", model);

      const result = service.getCachedModelById("test-model");

      expect(result).toBe(model);
    });

    it("returns undefined for non-existent ID", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);

      const result = service.getCachedModelById("non-existent");

      expect(result).toBeUndefined();
    });
  });

  describe("clearCache", () => {
    it("clears all caches", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).models = [{ id: "test" }];
      (service as any).providerCaches.set("provider1", { models: [], timestamp: 0 });
      (service as any).modelDetailsCache.set("model1", { id: "model1" });

      service.clearCache();

      expect((service as any).models).toBeNull();
      expect((service as any).providerCaches.size).toBe(0);
      expect((service as any).modelDetailsCache.size).toBe(0);
    });
  });

  describe("clearProviderCache", () => {
    it("clears specific provider cache", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      (service as any).providerCaches.set("provider1", { models: [], timestamp: 0 });
      (service as any).providerCaches.set("provider2", { models: [], timestamp: 0 });

      service.clearProviderCache("provider1");

      expect((service as any).providerCaches.has("provider1")).toBe(false);
      expect((service as any).providerCaches.has("provider2")).toBe(true);
    });
  });

  describe("getProviderHealth", () => {
    it("returns health status from error manager", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);

      const result = service.getProviderHealth("test-provider");

      expect(result.status).toBe("healthy");
      expect(result.recentErrorCount).toBe(0);
    });
  });

  describe("createCustomModels (private)", () => {
    it("creates models with canonical IDs", async () => {
      const provider: CustomProvider = {
        id: "test",
        name: "TestProvider",
        endpoint: "http://test",
        apiKey: "key",
        isEnabled: true,
      };

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [
          { id: "model1", name: "Model One", contextWindow: 8192 },
          "model2", // string format
        ],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      const result = await service.getModelsFromProvider(provider);

      expect(result[0].id).toBe("testprovider/model1");
      expect(result[0].name).toBe("Model One");
      expect(result[0].context_length).toBe(8192);

      expect(result[1].id).toBe("testprovider/model2");
      expect(result[1].name).toBe("model2");
    });
  });

  describe("handleProviderFailure (private)", () => {
    it("increments failure count", async () => {
      const provider: CustomProvider = {
        id: "failing",
        name: "FailingProvider",
        endpoint: "http://test",
        apiKey: "key",
        isEnabled: true,
        failureCount: 0,
      };
      mockPlugin.settings.customProviders = [provider];

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: false,
        error: "401 Unauthorized",
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      await service.getModelsFromProvider(provider);

      expect(provider.failureCount).toBe(1);
    });

    it("auto-disables provider after 3 failures", async () => {
      const provider: CustomProvider = {
        id: "failing",
        name: "FailingProvider",
        endpoint: "http://test",
        apiKey: "key",
        isEnabled: true,
        failureCount: 2, // Already failed twice
      };
      mockPlugin.settings.customProviders = [provider];

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: false,
        error: "401 Unauthorized - api key invalid",
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      await service.getModelsFromProvider(provider);

      expect(provider.failureCount).toBe(3);
      expect(provider.isEnabled).toBe(false);
    });

    it("treats authentication failures in 429 responses as auth-related", async () => {
      const provider: CustomProvider = {
        id: "auth429",
        name: "Auth429Provider",
        endpoint: "http://test",
        apiKey: "bad-key",
        isEnabled: true,
        failureCount: 0,
      };
      mockPlugin.settings.customProviders = [provider];

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: false,
        error: "API error 429: too many authentication failures",
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      await service.getModelsFromProvider(provider);

      expect(provider.failureCount).toBe(1);
    });
  });

  describe("resetProviderFailureCount (private)", () => {
    it("resets failure count on successful connection", async () => {
      const provider: CustomProvider = {
        id: "recovered",
        name: "RecoveredProvider",
        endpoint: "http://test",
        apiKey: "key",
        isEnabled: true,
        failureCount: 2,
        lastFailureTime: Date.now() - 1000,
      };
      mockPlugin.settings.customProviders = [provider];

      mockPlugin.customProviderService.testConnection.mockResolvedValue({
        success: true,
        models: [{ id: "model1" }],
      });

      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      await service.getModelsFromProvider(provider);

      expect(provider.failureCount).toBe(0);
      expect(provider.lastFailureTime).toBeUndefined();
    });
  });

  describe("concurrency control", () => {
    it("has concurrency limit set", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      expect((service as any).concurrencyLimit).toBe(2);
    });

    it("maintains fetch queue for queued requests", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      expect((service as any).fetchQueue).toBeDefined();
      expect(Array.isArray((service as any).fetchQueue)).toBe(true);
    });

    it("tracks active fetches", () => {
      const service = CustomProviderModelService.getInstance(mockPlugin as any);
      expect((service as any).activeFetches).toBeDefined();
      expect((service as any).activeFetches instanceof Map).toBe(true);
    });
  });
});
