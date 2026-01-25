/**
 * @jest-environment jsdom
 */
import { CustomProviderService } from "../CustomProviderService";
import { CustomProvider } from "../../types/llm";

// Mock ProviderAdapterFactory
const mockAdapter = {
  getModels: jest.fn(),
  validateApiKey: jest.fn(),
};

jest.mock("../providers/adapters/ProviderAdapterFactory", () => ({
  ProviderAdapterFactory: {
    createAdapter: jest.fn(() => mockAdapter),
  },
}));

// Mock errorLogger
jest.mock("../../utils/errorLogger", () => ({
  errorLogger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

describe("CustomProviderService", () => {
  let service: CustomProviderService;
  let mockPlugin: any;
  let mockApp: any;
  let mockSettingsManager: any;

  const createMockProvider = (overrides: Partial<CustomProvider> = {}): CustomProvider => ({
    id: "test-provider-1",
    name: "Test Provider",
    endpoint: "https://api.example.com/v1",
    apiKey: "test-api-key",
    models: [],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset static caches
    CustomProviderService.clearStaticCaches();

    mockSettingsManager = {
      getSettings: jest.fn().mockReturnValue({
        customProviders: [],
      }),
      updateSettings: jest.fn().mockResolvedValue(undefined),
    };

    mockPlugin = {
      getSettingsManager: jest.fn().mockReturnValue(mockSettingsManager),
    };

    mockApp = {};

    service = new CustomProviderService(mockPlugin, mockApp);

    // Default mock behavior
    mockAdapter.getModels.mockResolvedValue([
      { id: "model-1", name: "Model 1", contextWindow: 4096 },
      { id: "model-2", name: "Model 2", contextWindow: 8192 },
    ]);
    mockAdapter.validateApiKey.mockResolvedValue(undefined);
  });

  describe("constructor", () => {
    it("creates service instance", () => {
      expect(service).toBeInstanceOf(CustomProviderService);
    });
  });

  describe("clearCache", () => {
    it("clears connection caches", () => {
      // Call clearCache - it should not throw
      expect(() => service.clearCache()).not.toThrow();
    });
  });

  describe("clearStaticCaches", () => {
    it("clears static connection caches", () => {
      expect(() => CustomProviderService.clearStaticCaches()).not.toThrow();
    });
  });

  describe("testConnection", () => {
    it("returns success for valid provider", async () => {
      const provider = createMockProvider();

      const result = await service.testConnection(provider);

      expect(result.success).toBe(true);
      expect(result.models).toHaveLength(2);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it("returns cached result on subsequent calls", async () => {
      const provider = createMockProvider();

      const result1 = await service.testConnection(provider);
      const result2 = await service.testConnection(provider);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // Should only call getModels once due to caching
      expect(mockAdapter.getModels).toHaveBeenCalledTimes(1);
    });

    it("bypasses cache when force option is true", async () => {
      const provider = createMockProvider();

      await service.testConnection(provider);
      await service.testConnection(provider, { force: true });

      // Should call getModels twice
      expect(mockAdapter.getModels).toHaveBeenCalledTimes(2);
    });

    it("validates OpenRouter API key explicitly", async () => {
      const provider = createMockProvider({
        endpoint: "https://openrouter.ai/api/v1",
      });

      await service.testConnection(provider);

      expect(mockAdapter.validateApiKey).toHaveBeenCalled();
    });

    it("returns failure for localhost with no models", async () => {
      const provider = createMockProvider({
        endpoint: "http://localhost:8080/v1",
      });
      mockAdapter.getModels.mockResolvedValue([]);

      const result = await service.testConnection(provider);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Cannot reach local provider");
    });

    it("returns failure on connection error", async () => {
      const provider = createMockProvider();
      mockAdapter.getModels.mockRejectedValue(new Error("Connection refused"));

      const result = await service.testConnection(provider);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Connection refused");
    });

    it("handles abort error specially", async () => {
      const provider = createMockProvider();
      const abortError = new Error("Request aborted");
      abortError.name = "AbortError";
      mockAdapter.getModels.mockRejectedValue(abortError);

      const result = await service.testConnection(provider);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Connection timed out");
    });

    it("handles non-Error objects", async () => {
      const provider = createMockProvider();
      mockAdapter.getModels.mockRejectedValue("string error");

      const result = await service.testConnection(provider);

      expect(result.success).toBe(false);
      expect(result.error).toContain("unexpected error");
    });

    it("uses persisted healthy result when available", async () => {
      const provider = createMockProvider({
        lastHealthyAt: Date.now() - 1000, // 1 second ago
        lastHealthyConfigHash: `test-provider-1::https://api.example.com/v1::test-api-key`,
        cachedModels: ["model-1", "model-2"],
      });

      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });

      const result = await service.testConnection(provider);

      expect(result.success).toBe(true);
      expect(result.models).toEqual(["model-1", "model-2"]);
      // Should not call getModels because we used persisted result
      expect(mockAdapter.getModels).not.toHaveBeenCalled();
    });

    it("adds MiniMax fallback models when using persisted cache", async () => {
      const provider = createMockProvider({
        endpoint: "https://api.minimax.io/v1",
        lastHealthyAt: Date.now() - 1000,
        lastHealthyConfigHash: `test-provider-1::https://api.minimax.io/v1::test-api-key`,
        cachedModels: ["MiniMax-M2"],
      });

      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });

      const result = await service.testConnection(provider);

      expect(result.success).toBe(true);
      expect(result.models).toEqual(
        expect.arrayContaining(["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M1", "MiniMax-Text-01"])
      );
      expect(mockAdapter.getModels).not.toHaveBeenCalled();
    });

    it("ignores stale persisted result", async () => {
      const provider = createMockProvider({
        lastHealthyAt: Date.now() - 7 * 60 * 60 * 1000, // 7 hours ago (beyond 6 hour window)
        lastHealthyConfigHash: `test-provider-1::https://api.example.com/v1::test-api-key`,
        cachedModels: ["old-model"],
      });

      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });

      const result = await service.testConnection(provider);

      expect(result.success).toBe(true);
      // Should call getModels because persisted result was stale
      expect(mockAdapter.getModels).toHaveBeenCalled();
    });

    it("ignores persisted result with different signature", async () => {
      const provider = createMockProvider({
        lastHealthyAt: Date.now() - 1000,
        lastHealthyConfigHash: "different-signature",
        cachedModels: ["old-model"],
      });

      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });

      const result = await service.testConnection(provider);

      expect(result.success).toBe(true);
      // Should call getModels because signature doesn't match
      expect(mockAdapter.getModels).toHaveBeenCalled();
    });

    it("persists health data on successful connection", async () => {
      const provider = createMockProvider();
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });

      await service.testConnection(provider, { force: true });

      expect(mockSettingsManager.updateSettings).toHaveBeenCalled();
      const updateCall = mockSettingsManager.updateSettings.mock.calls[0][0];
      expect(updateCall.customProviders[0].lastHealthyAt).toBeDefined();
      expect(updateCall.customProviders[0].cachedModels).toEqual(["model-1", "model-2"]);
    });

    it("clears health data on failed connection", async () => {
      const provider = createMockProvider({
        lastHealthyAt: Date.now(),
        lastHealthyConfigHash: "old-hash",
      });
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });
      mockAdapter.getModels.mockRejectedValue(new Error("Connection failed"));

      await service.testConnection(provider, { force: true });

      expect(mockSettingsManager.updateSettings).toHaveBeenCalled();
      const updateCall = mockSettingsManager.updateSettings.mock.calls[0][0];
      expect(updateCall.customProviders[0].lastHealthyAt).toBeUndefined();
      expect(updateCall.customProviders[0].lastHealthyConfigHash).toBeUndefined();
    });

    it("handles concurrent requests for same provider", async () => {
      const provider = createMockProvider();

      // Start two concurrent requests
      const promise1 = service.testConnection(provider, { force: true });
      const promise2 = service.testConnection(provider);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      // Both should return valid results
    });
  });

  describe("getProviderAdapter", () => {
    it("returns adapter from factory", () => {
      const provider = createMockProvider();
      const { ProviderAdapterFactory } = require("../providers/adapters/ProviderAdapterFactory");

      const adapter = service.getProviderAdapter(provider);

      expect(ProviderAdapterFactory.createAdapter).toHaveBeenCalledWith(provider, mockPlugin);
      expect(adapter).toBe(mockAdapter);
    });
  });

  describe("cache key generation", () => {
    it("generates unique cache keys for different providers", async () => {
      const provider1 = createMockProvider({
        id: "provider-1",
        endpoint: "https://api1.example.com/v1",
        apiKey: "key1",
      });
      const provider2 = createMockProvider({
        id: "provider-2",
        endpoint: "https://api2.example.com/v1",
        apiKey: "key2",
      });

      await service.testConnection(provider1);
      await service.testConnection(provider2);

      // Should call getModels twice (once for each provider)
      expect(mockAdapter.getModels).toHaveBeenCalledTimes(2);
    });

    it("treats same endpoint/key as same cache entry regardless of provider id", async () => {
      const provider1 = createMockProvider({
        id: "provider-1",
        endpoint: "https://api.example.com/v1",
        apiKey: "shared-key",
      });
      const provider2 = createMockProvider({
        id: "provider-2",
        endpoint: "https://api.example.com/v1",
        apiKey: "shared-key",
      });

      await service.testConnection(provider1);
      await service.testConnection(provider2);

      // Should only call getModels once due to same cache key
      expect(mockAdapter.getModels).toHaveBeenCalledTimes(1);
    });
  });

  describe("model normalization", () => {
    it("normalizes ProviderModel objects to IDs for caching", async () => {
      const provider = createMockProvider();
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });
      mockAdapter.getModels.mockResolvedValue([
        { id: "model-a", name: "Model A", contextWindow: 4096 },
        { id: "model-b", name: "Model B" },
      ]);

      await service.testConnection(provider, { force: true });

      const updateCall = mockSettingsManager.updateSettings.mock.calls[0][0];
      expect(updateCall.customProviders[0].cachedModels).toEqual(["model-a", "model-b"]);
    });

    it("handles mixed string and object models", async () => {
      const provider = createMockProvider();
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });
      mockAdapter.getModels.mockResolvedValue([
        "string-model",
        { id: "object-model", name: "Object Model" },
      ] as any);

      await service.testConnection(provider, { force: true });

      const updateCall = mockSettingsManager.updateSettings.mock.calls[0][0];
      expect(updateCall.customProviders[0].cachedModels).toEqual(["string-model", "object-model"]);
    });

    it("filters out models with empty IDs", async () => {
      const provider = createMockProvider();
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });
      mockAdapter.getModels.mockResolvedValue([
        { id: "valid-model", name: "Valid" },
        { id: "", name: "Empty ID" },
        { id: null as any, name: "Null ID" },
      ]);

      await service.testConnection(provider, { force: true });

      const updateCall = mockSettingsManager.updateSettings.mock.calls[0][0];
      expect(updateCall.customProviders[0].cachedModels).toEqual(["valid-model"]);
    });
  });

  describe("error handling", () => {
    it("handles settings update failure gracefully", async () => {
      const provider = createMockProvider();
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });
      mockSettingsManager.updateSettings.mockRejectedValue(new Error("Storage error"));

      // Should not throw despite settings update failure
      const result = await service.testConnection(provider, { force: true });

      expect(result.success).toBe(true);
    });

    it("handles missing provider in settings during persist", async () => {
      const provider = createMockProvider({ id: "non-existent" });
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [], // Provider not in settings
      });

      // Should not throw
      const result = await service.testConnection(provider, { force: true });

      expect(result.success).toBe(true);
      // Should not attempt to update settings
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });

    it("handles missing provider in settings during clear health", async () => {
      const provider = createMockProvider({ id: "non-existent" });
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [],
      });
      mockAdapter.getModels.mockRejectedValue(new Error("Test error"));

      // Should not throw
      const result = await service.testConnection(provider, { force: true });

      expect(result.success).toBe(false);
      // Should not attempt to update settings
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });

    it("skips clear health when no health data exists", async () => {
      const provider = createMockProvider({
        // No lastHealthyAt or lastHealthyConfigHash
      });
      mockSettingsManager.getSettings.mockReturnValue({
        customProviders: [provider],
      });
      mockAdapter.getModels.mockRejectedValue(new Error("Test error"));

      await service.testConnection(provider, { force: true });

      // Should not call updateSettings since there's nothing to clear
      expect(mockSettingsManager.updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("deferred test execution", () => {
    it("executes test asynchronously", async () => {
      const provider = createMockProvider();

      const result = await service.testConnection(provider);

      expect(result.success).toBe(true);
    });

    it("handles multiple queued tests", async () => {
      const provider1 = createMockProvider({ id: "p1", apiKey: "k1" });
      const provider2 = createMockProvider({ id: "p2", apiKey: "k2" });
      const provider3 = createMockProvider({ id: "p3", apiKey: "k3" });

      const results = await Promise.all([
        service.testConnection(provider1),
        service.testConnection(provider2),
        service.testConnection(provider3),
      ]);

      expect(results.every(r => r.success)).toBe(true);
    });
  });
});
