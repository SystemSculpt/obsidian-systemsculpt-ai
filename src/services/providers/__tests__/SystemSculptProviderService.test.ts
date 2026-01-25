/**
 * @jest-environment node
 */

import { SystemSculptProviderService } from "../SystemSculptProviderService";
import { SystemSculptModel } from "../../../types/llm";

// Mock the dependencies
jest.mock("../ProviderErrorManager", () => ({
  ProviderErrorManager: jest.fn().mockImplementation(() => ({
    reportSystemSculptError: jest.fn(),
    getProviderHealth: jest.fn().mockReturnValue({
      status: "healthy",
      recentErrorCount: 0,
    }),
  })),
}));

jest.mock("../../../utils/modelUtils", () => ({
  filterChatModels: jest.fn((models) =>
    models.filter((m: any) => !m.id.includes("embedding"))
  ),
}));

describe("SystemSculptProviderService", () => {
  let mockPlugin: any;
  let mockModels: SystemSculptModel[];

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset singleton
    (SystemSculptProviderService as any).instance = null;

    mockModels = [
      {
        id: "gpt-4",
        name: "GPT-4",
        provider: "systemsculpt",
        description: "Most capable model",
        contextWindow: 8192,
        pricing: { input: 0.03, output: 0.06 },
      } as SystemSculptModel,
      {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        provider: "systemsculpt",
        description: "Fast and efficient",
        contextWindow: 4096,
        pricing: { input: 0.001, output: 0.002 },
      } as SystemSculptModel,
      {
        id: "text-embedding-ada",
        name: "Embedding Model",
        provider: "systemsculpt",
        description: "Embedding model",
        contextWindow: 8192,
      } as SystemSculptModel,
    ];

    mockPlugin = {
      settings: {
        enableSystemSculptProvider: true,
        licenseValid: true,
        licenseKey: "test-key",
      },
      app: {},
      aiService: {
        getModels: jest.fn().mockResolvedValue(mockModels),
      },
      emitter: {
        emitWithProvider: jest.fn(),
      },
    };
  });

  describe("getInstance", () => {
    it("creates singleton instance", () => {
      const instance1 = SystemSculptProviderService.getInstance(mockPlugin);
      const instance2 = SystemSculptProviderService.getInstance(mockPlugin);

      expect(instance1).toBe(instance2);
    });

    it("returns existing instance on subsequent calls", () => {
      const instance1 = SystemSculptProviderService.getInstance(mockPlugin);
      const instance2 = SystemSculptProviderService.getInstance(mockPlugin);

      expect(instance1).toBe(instance2);
    });
  });

  describe("clearInstance", () => {
    it("clears the singleton instance", () => {
      const instance1 = SystemSculptProviderService.getInstance(mockPlugin);
      SystemSculptProviderService.clearInstance();
      const instance2 = SystemSculptProviderService.getInstance(mockPlugin);

      expect(instance1).not.toBe(instance2);
    });

    it("handles clearing when no instance exists", () => {
      expect(() => SystemSculptProviderService.clearInstance()).not.toThrow();
    });
  });

  describe("getProviderType", () => {
    it("returns 'systemsculpt'", () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      expect(service.getProviderType()).toBe("systemsculpt");
    });
  });

  describe("testConnection", () => {
    it("returns true when models are available", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const result = await service.testConnection();

      expect(result).toBe(true);
    });

    it("returns false when provider is disabled", async () => {
      mockPlugin.settings.enableSystemSculptProvider = false;
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const result = await service.testConnection();

      expect(result).toBe(false);
    });

    it("returns false when getModels throws", async () => {
      mockPlugin.aiService.getModels.mockRejectedValue(new Error("Network error"));
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const result = await service.testConnection();

      expect(result).toBe(false);
    });

    it("returns false when no models available", async () => {
      mockPlugin.aiService.getModels.mockResolvedValue([]);
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const result = await service.testConnection();

      expect(result).toBe(false);
    });
  });

  describe("getModels", () => {
    it("returns empty array when provider is disabled", async () => {
      mockPlugin.settings.enableSystemSculptProvider = false;
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const models = await service.getModels();

      expect(models).toEqual([]);
      expect(mockPlugin.aiService.getModels).not.toHaveBeenCalled();
    });

    it("fetches and returns models", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const models = await service.getModels();

      expect(models).toEqual(mockModels);
      expect(mockPlugin.aiService.getModels).toHaveBeenCalled();
    });

    it("caches models after fetching", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      await service.getModels();
      await service.getModels();

      // Should only call API once
      expect(mockPlugin.aiService.getModels).toHaveBeenCalledTimes(1);
    });

    it("emits modelsUpdated event after fetching", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      await service.getModels();

      expect(mockPlugin.emitter.emitWithProvider).toHaveBeenCalledWith(
        "modelsUpdated",
        "systemsculpt",
        mockModels
      );
    });

    it("returns empty array on fetch error", async () => {
      mockPlugin.aiService.getModels.mockRejectedValue(
        new Error("API error")
      );
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const models = await service.getModels();

      expect(models).toEqual([]);
    });

    it("does not make duplicate requests when one is in progress", async () => {
      mockPlugin.aiService.getModels.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve(mockModels), 100)
          )
      );
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      // Start two requests simultaneously
      const promise1 = service.getModels();
      const promise2 = service.getModels();

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1).toBe(result2);
      expect(mockPlugin.aiService.getModels).toHaveBeenCalledTimes(1);
    });
  });

  describe("findBestAlternativeModel", () => {
    it("returns undefined when no models available", () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const result = service.findBestAlternativeModel("unavailable-model");

      expect(result).toBeUndefined();
    });

    it("returns first chat model excluding the unavailable one", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);
      await service.getModels();

      const result = service.findBestAlternativeModel("gpt-4");

      expect(result).toBeDefined();
      expect(result?.id).not.toBe("gpt-4");
    });

    it("excludes embedding models", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);
      await service.getModels();

      const result = service.findBestAlternativeModel("gpt-4");

      expect(result?.id).not.toContain("embedding");
    });

    it("returns undefined when all models are unavailable", async () => {
      mockPlugin.aiService.getModels.mockResolvedValue([
        { id: "only-model", name: "Only Model" } as SystemSculptModel,
      ]);
      const service = SystemSculptProviderService.getInstance(mockPlugin);
      await service.getModels();

      const result = service.findBestAlternativeModel("only-model");

      expect(result).toBeUndefined();
    });
  });

  describe("getCachedModelById", () => {
    it("returns undefined when model not cached", () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const result = service.getCachedModelById("non-existent");

      expect(result).toBeUndefined();
    });

    it("returns cached model after getModels", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);
      await service.getModels();

      const result = service.getCachedModelById("gpt-4");

      expect(result).toBeDefined();
      expect(result?.id).toBe("gpt-4");
    });
  });

  describe("getProviderHealth", () => {
    it("returns health status from error manager", () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      const health = service.getProviderHealth();

      expect(health).toEqual({
        status: "healthy",
        recentErrorCount: 0,
      });
    });
  });

  describe("clearCache", () => {
    it("clears all caches", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);
      await service.getModels();

      service.clearCache();

      // Should fetch again after clearing
      await service.getModels();
      expect(mockPlugin.aiService.getModels).toHaveBeenCalledTimes(2);
    });

    it("clears model details cache", async () => {
      const service = SystemSculptProviderService.getInstance(mockPlugin);
      await service.getModels();

      expect(service.getCachedModelById("gpt-4")).toBeDefined();

      service.clearCache();

      expect(service.getCachedModelById("gpt-4")).toBeUndefined();
    });
  });

  describe("loadWithRetry (private)", () => {
    it("retries on failure", async () => {
      let callCount = 0;
      mockPlugin.aiService.getModels.mockImplementation(() => {
        callCount++;
        if (callCount < 2) {
          return Promise.reject(new Error("Temporary error"));
        }
        return Promise.resolve(mockModels);
      });

      const service = SystemSculptProviderService.getInstance(mockPlugin);
      const models = await service.getModels();

      expect(models).toEqual(mockModels);
      expect(callCount).toBe(2);
    });

    it("throws after max retries", async () => {
      mockPlugin.aiService.getModels.mockRejectedValue(
        new Error("Persistent error")
      );

      const service = SystemSculptProviderService.getInstance(mockPlugin);
      const models = await service.getModels();

      // Should return empty array after retry exhaustion
      expect(models).toEqual([]);
      // Should have called 3 times (max retries)
      expect(mockPlugin.aiService.getModels).toHaveBeenCalledTimes(3);
    });
  });

  describe("error handling", () => {
    it("reports license-related errors", async () => {
      mockPlugin.aiService.getModels.mockRejectedValue(
        new Error("Invalid license key")
      );
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      await service.getModels();

      // The error manager should be called with license-related info
      const { ProviderErrorManager } = require("../ProviderErrorManager");
      const mockErrorManager = ProviderErrorManager.mock.results[0].value;
      expect(mockErrorManager.reportSystemSculptError).toHaveBeenCalledWith(
        expect.objectContaining({
          licenseRelated: true,
        })
      );
    });

    it("reports non-license errors", async () => {
      mockPlugin.aiService.getModels.mockRejectedValue(
        new Error("Network timeout")
      );
      const service = SystemSculptProviderService.getInstance(mockPlugin);

      await service.getModels();

      const { ProviderErrorManager } = require("../ProviderErrorManager");
      const mockErrorManager = ProviderErrorManager.mock.results[0].value;
      expect(mockErrorManager.reportSystemSculptError).toHaveBeenCalledWith(
        expect.objectContaining({
          licenseRelated: false,
        })
      );
    });
  });
});
