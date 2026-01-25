import { UnifiedModelService } from "../UnifiedModelService";
import type { SystemSculptModel, CustomProvider } from "../../../types/llm";

// Mock SystemSculptProviderService
const mockSystemSculptService = {
  getInstance: jest.fn(),
  clearInstance: jest.fn(),
  getModels: jest.fn(),
  getCachedModelById: jest.fn(),
  findBestAlternativeModel: jest.fn(),
  testConnection: jest.fn(),
  clearCache: jest.fn(),
  peekCachedModels: jest.fn(),
};

// Mock CustomProviderModelService
const mockCustomProviderService = {
  getInstance: jest.fn(),
  clearInstance: jest.fn(),
  getModels: jest.fn(),
  getModelsDeferred: jest.fn(),
  getModelsForProviders: jest.fn(),
  getCachedModelById: jest.fn(),
  findBestAlternativeModel: jest.fn(),
  testConnection: jest.fn(),
  clearCache: jest.fn(),
  peekCachedModels: jest.fn(),
};

// Mock FavoritesService
const mockFavoritesService = {
  getInstance: jest.fn(),
  processFavorites: jest.fn(),
  toggleFavorite: jest.fn(),
};

jest.mock("../SystemSculptProviderService", () => ({
  SystemSculptProviderService: {
    getInstance: () => mockSystemSculptService,
    clearInstance: () => mockSystemSculptService.clearInstance(),
  },
}));

jest.mock("../CustomProviderModelService", () => ({
  CustomProviderModelService: {
    getInstance: () => mockCustomProviderService,
    clearInstance: () => mockCustomProviderService.clearInstance(),
  },
}));

jest.mock("../../FavoritesService", () => ({
  FavoritesService: {
    getInstance: () => mockFavoritesService,
  },
}));

jest.mock("../../../utils/modelUtils", () => ({
  getCanonicalId: jest.fn((model) => model.id),
  findModelById: jest.fn((models, id) => models?.find((m: any) => m.id === id)),
  filterChatModels: jest.fn((models) =>
    models.filter((m: any) => !m.id.includes("embed"))
  ),
  supportsTools: jest.fn((model) => model.supportsTools || false),
  getToolCompatibilityInfo: jest.fn((model) => ({
    isCompatible: model.supportsTools || false,
    reason: model.supportsTools ? "Model supports tools" : "Model does not support tools",
    confidence: "high" as const,
  })),
  parseCanonicalId: jest.fn((id) => {
    if (!id || !id.includes("@@")) return null;
    const [providerId, modelId] = id.split("@@");
    return { providerId, modelId };
  }),
}));

const createMockPlugin = () => ({
  settings: {
    customProviders: [] as CustomProvider[],
    selectedModelId: "",
  },
  getSettingsManager: jest.fn().mockReturnValue({
    updateSettings: jest.fn().mockResolvedValue(undefined),
  }),
});

describe("UnifiedModelService", () => {
  let mockPlugin: ReturnType<typeof createMockPlugin>;

  beforeEach(() => {
    jest.clearAllMocks();
    UnifiedModelService.clearInstance();
    mockPlugin = createMockPlugin();

    // Setup default mock returns
    mockSystemSculptService.getModels.mockResolvedValue([]);
    mockSystemSculptService.testConnection.mockResolvedValue(true);
    mockSystemSculptService.peekCachedModels.mockReturnValue(null);
    mockCustomProviderService.getModels.mockResolvedValue([]);
    mockCustomProviderService.getModelsDeferred.mockReturnValue([]);
    mockCustomProviderService.testConnection.mockResolvedValue(true);
    mockCustomProviderService.peekCachedModels.mockReturnValue(null);
    mockCustomProviderService.getModelsForProviders.mockResolvedValue([]);
  });

  afterEach(() => {
    UnifiedModelService.clearInstance();
  });

  describe("getInstance", () => {
    it("returns singleton instance", () => {
      const instance1 = UnifiedModelService.getInstance(mockPlugin as any);
      const instance2 = UnifiedModelService.getInstance(mockPlugin as any);

      expect(instance1).toBe(instance2);
    });
  });

  describe("clearInstance", () => {
    it("clears singleton and child services", () => {
      const instance1 = UnifiedModelService.getInstance(mockPlugin as any);
      UnifiedModelService.clearInstance();
      const instance2 = UnifiedModelService.getInstance(mockPlugin as any);

      expect(instance1).not.toBe(instance2);
      expect(mockSystemSculptService.clearInstance).toHaveBeenCalled();
      expect(mockCustomProviderService.clearInstance).toHaveBeenCalled();
    });
  });

  describe("getModels", () => {
    it("combines models from all providers", async () => {
      const systemModels: SystemSculptModel[] = [
        { id: "sys/model1", name: "System Model 1", provider: "systemsculpt" } as any,
      ];
      const customModels: SystemSculptModel[] = [
        { id: "custom/model1", name: "Custom Model 1", provider: "custom" } as any,
      ];

      mockSystemSculptService.getModels.mockResolvedValue(systemModels);
      mockCustomProviderService.getModels.mockResolvedValue(customModels);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.getModels();

      expect(result.length).toBe(2);
      expect(result.some((m) => m.id === "sys/model1")).toBe(true);
      expect(result.some((m) => m.id === "custom/model1")).toBe(true);
    });

    it("processes favorites on combined models", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "model1", name: "Model 1" },
      ]);
      mockCustomProviderService.getModels.mockResolvedValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      await service.getModels();

      expect(mockFavoritesService.processFavorites).toHaveBeenCalled();
    });

    it("clears cache when forceRefresh is true", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([]);
      mockCustomProviderService.getModels.mockResolvedValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      await service.getModels(true);

      expect(mockSystemSculptService.clearCache).toHaveBeenCalled();
      expect(mockCustomProviderService.clearCache).toHaveBeenCalled();
    });

    it("handles failed provider gracefully", async () => {
      mockSystemSculptService.getModels.mockRejectedValue(new Error("Failed"));
      mockCustomProviderService.getModels.mockResolvedValue([
        { id: "custom/model1", name: "Custom" },
      ]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.getModels();

      // Should still return custom models
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("custom/model1");
    });

    it("defers custom provider loading when appropriate", async () => {
      mockPlugin.settings.customProviders = [
        { id: "1", name: "Custom", endpoint: "http://test", apiKey: "key", isEnabled: true },
      ];
      mockPlugin.settings.selectedModelId = "systemsculpt@@some/model";

      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "sys/model1", name: "System" },
      ]);
      mockCustomProviderService.getModelsDeferred.mockReturnValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      await service.getModels();

      expect(mockCustomProviderService.getModelsDeferred).toHaveBeenCalled();
    });
  });

  describe("getModelById", () => {
    it("returns cached model from system service", async () => {
      const model = { id: "sys/model", name: "System Model" } as SystemSculptModel;
      mockSystemSculptService.getCachedModelById.mockReturnValue(model);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.getModelById("sys/model");

      expect(result).toBe(model);
      expect(mockCustomProviderService.getCachedModelById).not.toHaveBeenCalled();
    });

    it("returns cached model from custom service", async () => {
      const model = { id: "custom/model", name: "Custom Model" } as SystemSculptModel;
      mockSystemSculptService.getCachedModelById.mockReturnValue(undefined);
      mockCustomProviderService.getCachedModelById.mockReturnValue(model);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.getModelById("custom/model");

      expect(result).toBe(model);
    });

    it("loads models if not in cache", async () => {
      mockSystemSculptService.getCachedModelById.mockReturnValue(undefined);
      mockCustomProviderService.getCachedModelById.mockReturnValue(undefined);
      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "found/model", name: "Found Model" },
      ]);
      mockCustomProviderService.getModels.mockResolvedValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.getModelById("found/model");

      expect(result?.id).toBe("found/model");
    });
  });

  describe("findBestAlternativeModel", () => {
    it("returns undefined for empty model list", () => {
      const service = UnifiedModelService.getInstance(mockPlugin as any);

      const result = service.findBestAlternativeModel("unavailable", []);

      expect(result).toBeUndefined();
    });

    it("returns undefined for null model list", () => {
      const service = UnifiedModelService.getInstance(mockPlugin as any);

      const result = service.findBestAlternativeModel("unavailable", null as any);

      expect(result).toBeUndefined();
    });

    it("tries system service first for alternative", () => {
      const alternative = { id: "alt/model", name: "Alternative" } as SystemSculptModel;
      mockSystemSculptService.findBestAlternativeModel.mockReturnValue(alternative);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = service.findBestAlternativeModel("unavailable", [
        { id: "model1", name: "Model 1" },
      ] as any);

      expect(result).toBe(alternative);
    });

    it("falls back to custom service for alternative", () => {
      const alternative = { id: "custom/alt", name: "Custom Alt" } as SystemSculptModel;
      mockSystemSculptService.findBestAlternativeModel.mockReturnValue(undefined);
      mockCustomProviderService.findBestAlternativeModel.mockReturnValue(alternative);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = service.findBestAlternativeModel("unavailable", [
        { id: "model1", name: "Model 1" },
      ] as any);

      expect(result).toBe(alternative);
    });

    it("returns first chat model when no provider alternative", () => {
      mockSystemSculptService.findBestAlternativeModel.mockReturnValue(undefined);
      mockCustomProviderService.findBestAlternativeModel.mockReturnValue(undefined);

      const models = [
        { id: "model1", name: "Model 1" },
        { id: "model2", name: "Model 2" },
      ] as SystemSculptModel[];

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = service.findBestAlternativeModel("unavailable", models);

      expect(result?.id).toBe("model1");
    });
  });

  describe("validateSelectedModel", () => {
    it("returns not replaced when model exists", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "selected/model", name: "Selected" },
      ]);
      mockCustomProviderService.getModels.mockResolvedValue([]);
      mockPlugin.settings.selectedModelId = "selected/model";

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.validateSelectedModel();

      expect(result.wasReplaced).toBe(false);
    });

    it("replaces with alternative when model not found", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "alternative/model", name: "Alternative" },
      ]);
      mockCustomProviderService.getModels.mockResolvedValue([]);
      mockPlugin.settings.selectedModelId = "missing/model";
      mockSystemSculptService.findBestAlternativeModel.mockReturnValue({
        id: "alternative/model",
        name: "Alternative",
      });

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.validateSelectedModel();

      expect(result.wasReplaced).toBe(true);
      expect(result.oldModelId).toBe("missing/model");
      expect(mockPlugin.getSettingsManager().updateSettings).toHaveBeenCalledWith({
        selectedModelId: "alternative/model",
      });
    });

    it("clears selection when no models available", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([]);
      mockCustomProviderService.getModels.mockResolvedValue([]);
      mockPlugin.settings.selectedModelId = "missing/model";

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      await service.validateSelectedModel();

      expect(mockPlugin.getSettingsManager().updateSettings).toHaveBeenCalledWith({
        selectedModelId: "",
      });
    });
  });

  describe("validateSpecificModel", () => {
    it("returns available when model exists", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "target/model", name: "Target" },
      ]);
      mockCustomProviderService.getModels.mockResolvedValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.validateSpecificModel("target/model");

      expect(result.isAvailable).toBe(true);
      expect(result.alternativeModel).toBeUndefined();
    });

    it("returns not available with alternative when model missing", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "alt/model", name: "Alternative" },
      ]);
      mockCustomProviderService.getModels.mockResolvedValue([]);
      mockSystemSculptService.findBestAlternativeModel.mockReturnValue({
        id: "alt/model",
        name: "Alternative",
      });

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.validateSpecificModel("missing/model");

      expect(result.isAvailable).toBe(false);
      expect(result.alternativeModel?.id).toBe("alt/model");
    });

    it("uses cached models when available", async () => {
      mockSystemSculptService.peekCachedModels.mockReturnValue([
        { id: "cached/model", name: "Cached" },
      ]);
      mockCustomProviderService.peekCachedModels.mockReturnValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.validateSpecificModel("cached/model");

      expect(result.isAvailable).toBe(true);
      expect(mockSystemSculptService.getModels).not.toHaveBeenCalled();
    });
  });

  describe("toggleFavorite", () => {
    it("delegates to favorites service", async () => {
      const model = { id: "model1", name: "Model 1" } as SystemSculptModel;

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      await service.toggleFavorite(model);

      expect(mockFavoritesService.toggleFavorite).toHaveBeenCalledWith(model);
    });
  });

  describe("refreshModels", () => {
    it("calls getModels with force refresh", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([]);
      mockCustomProviderService.getModels.mockResolvedValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      await service.refreshModels();

      expect(mockSystemSculptService.clearCache).toHaveBeenCalled();
      expect(mockCustomProviderService.clearCache).toHaveBeenCalled();
    });
  });

  describe("checkToolCompatibility", () => {
    it("returns not compatible when model not found", async () => {
      mockSystemSculptService.getCachedModelById.mockReturnValue(undefined);
      mockCustomProviderService.getCachedModelById.mockReturnValue(undefined);
      mockSystemSculptService.getModels.mockResolvedValue([]);
      mockCustomProviderService.getModels.mockResolvedValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.checkToolCompatibility("nonexistent/model");

      expect(result.isCompatible).toBe(false);
      expect(result.reason).toBe("Model not found");
    });

    it("returns compatibility info for found model", async () => {
      const model = { id: "tool/model", name: "Tool Model", supportsTools: true } as any;
      mockSystemSculptService.getCachedModelById.mockReturnValue(model);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.checkToolCompatibility("tool/model");

      expect(result.isCompatible).toBe(true);
    });
  });

  describe("getToolCompatibleModels", () => {
    it("filters models that support tools", async () => {
      mockSystemSculptService.getModels.mockResolvedValue([
        { id: "tool/model", name: "Tool Model", supportsTools: true },
        { id: "no-tool/model", name: "No Tool", supportsTools: false },
      ]);
      mockCustomProviderService.getModels.mockResolvedValue([]);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.getToolCompatibleModels();

      expect(result.length).toBe(1);
      expect(result[0].id).toBe("tool/model");
    });

    it("returns empty array on error", async () => {
      mockSystemSculptService.getModels.mockRejectedValue(new Error("Failed"));
      mockCustomProviderService.getModels.mockRejectedValue(new Error("Failed"));

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.getToolCompatibleModels();

      expect(result).toEqual([]);
    });
  });

  describe("testAllConnections", () => {
    it("tests all provider connections", async () => {
      mockSystemSculptService.testConnection.mockResolvedValue(true);
      mockCustomProviderService.testConnection.mockResolvedValue(false);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.testAllConnections();

      expect(result.systemSculpt).toBe(true);
      expect(result.customProviders).toBe(false);
    });

    it("handles connection test failures", async () => {
      mockSystemSculptService.testConnection.mockRejectedValue(new Error("Network"));
      mockCustomProviderService.testConnection.mockResolvedValue(true);

      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = await service.testAllConnections();

      expect(result.systemSculpt).toBe(false);
      expect(result.customProviders).toBe(true);
    });
  });

  describe("getCachedModels", () => {
    it("returns empty array (not fully implemented)", () => {
      const service = UnifiedModelService.getInstance(mockPlugin as any);
      const result = service.getCachedModels();

      expect(result).toEqual([]);
    });
  });

  describe("clearAllCaches", () => {
    it("clears both provider caches", () => {
      const service = UnifiedModelService.getInstance(mockPlugin as any);
      service.clearAllCaches();

      expect(mockSystemSculptService.clearCache).toHaveBeenCalled();
      expect(mockCustomProviderService.clearCache).toHaveBeenCalled();
    });
  });
});
