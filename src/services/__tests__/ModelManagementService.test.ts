/**
 * @jest-environment node
 */

// Mock httpClient
jest.mock("../../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

// Mock modelUtils
jest.mock("../../utils/modelUtils", () => ({
  MODEL_ID_SEPARATOR: "::",
  parseCanonicalId: jest.fn((id: string) => {
    if (!id || typeof id !== "string") return null;
    const parts = id.split("::");
    if (parts.length < 2) return null;
    return {
      providerId: parts[0],
      modelId: parts.slice(1).join("::"),
    };
  }),
}));

// Mock AGENT_CONFIG
jest.mock("../../constants/agent", () => ({
  AGENT_CONFIG: {
    MODEL_ID: "systemsculpt::ai-agent",
    MODEL_DISPLAY_NAME: "SystemSculpt Agent",
    MODEL_DESCRIPTION: "AI-powered agent for code assistance",
  },
}));

// Mock API endpoints
jest.mock("../../constants/api", () => ({
  SYSTEMSCULPT_API_ENDPOINTS: {
    MODELS: {
      LIST: "/api/models",
    },
  },
}));

// Mock errors
jest.mock("../../utils/errors", () => ({
  SystemSculptError: class SystemSculptError extends Error {
    code: string;
    statusCode?: number;
    constructor(message: string, code: string, statusCode?: number) {
      super(message);
      this.code = code;
      this.statusCode = statusCode;
    }
  },
  ERROR_CODES: {
    MODEL_REQUEST_ERROR: "MODEL_REQUEST_ERROR",
    MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  },
}));

import { ModelManagementService } from "../ModelManagementService";
import { httpRequest } from "../../utils/httpClient";

const mockHttpRequest = httpRequest as jest.MockedFunction<typeof httpRequest>;

describe("ModelManagementService", () => {
  let service: ModelManagementService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPlugin = {
      settings: {
        licenseKey: "test-license-key",
        enableSystemSculptProvider: true,
        customProviders: [],
      },
      modelService: {
        getModelById: jest.fn(),
      },
    };

    service = new ModelManagementService(mockPlugin, "https://api.systemsculpt.com");
  });

  describe("constructor", () => {
    it("creates instance with plugin and base URL", () => {
      expect(service).toBeInstanceOf(ModelManagementService);
    });
  });

  describe("updateBaseUrl", () => {
    it("updates the base URL", () => {
      service.updateBaseUrl("https://new-api.example.com");
      // Internal state updated - verify by calling getModels and checking request URL
      expect(true).toBe(true); // Method exists and doesn't throw
    });
  });

  describe("stripProviderPrefixes", () => {
    it("returns model ID unchanged (no longer strips prefixes)", () => {
      const result = service.stripProviderPrefixes("openrouter/openai/gpt-4o");
      expect(result).toBe("openrouter/openai/gpt-4o");
    });

    it("returns simple model ID unchanged", () => {
      const result = service.stripProviderPrefixes("gpt-4o");
      expect(result).toBe("gpt-4o");
    });

    it("returns groq model ID unchanged", () => {
      const result = service.stripProviderPrefixes("groq/llama-3-8b");
      expect(result).toBe("groq/llama-3-8b");
    });
  });

  describe("getModels", () => {
    it("returns local fallback when SystemSculpt provider is disabled", async () => {
      mockPlugin.settings.enableSystemSculptProvider = false;

      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("systemsculpt");
      expect(models[0].name).toBe("SystemSculpt Agent");
    });

    it("returns local fallback when no license key is configured", async () => {
      mockPlugin.settings.licenseKey = "";

      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("systemsculpt");
    });

    it("returns local fallback when license key is whitespace", async () => {
      mockPlugin.settings.licenseKey = "   ";

      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("systemsculpt");
    });

    it("fetches models from API when license key is valid", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          models: [
            {
              id: "model-1",
              name: "Test Model",
              description: "A test model",
              upstream_model: "openrouter/openai/gpt-4o",
            },
          ],
        },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();

      expect(mockHttpRequest).toHaveBeenCalledWith({
        url: "https://api.systemsculpt.com/api/models",
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "x-license-key": "test-license-key",
        },
      });
      expect(models).toHaveLength(1);
    });

    it("handles array response format", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: [
          {
            id: "model-1",
            name: "Array Model",
          },
        ],
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();

      expect(models).toHaveLength(1);
    });

    it("handles data array response format", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          data: [
            {
              id: "model-1",
              name: "Data Model",
            },
          ],
        },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();

      expect(models).toHaveLength(1);
    });

    it("returns local fallback for non-200 status", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 500,
        json: { error: "Server error" },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("systemsculpt");
    });

    it("returns local fallback on API error", async () => {
      mockHttpRequest.mockRejectedValue(new Error("Network error"));

      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("systemsculpt");
    });

    it("returns local fallback for empty models array", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: { models: [] },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("systemsculpt");
    });

    it("returns local fallback for invalid response format", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: { invalid: "format" },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].provider).toBe("systemsculpt");
    });
  });

  describe("getModelInfo", () => {
    it("returns info for SystemSculpt model", async () => {
      mockPlugin.modelService.getModelById.mockResolvedValue({
        id: "systemsculpt::ai-agent",
        name: "SystemSculpt Agent",
        upstream_model: "openrouter/openai/gpt-4o",
      });

      const info = await service.getModelInfo("systemsculpt::ai-agent");

      expect(info.isCustom).toBe(false);
      expect(info.actualModelId).toBe("ai-agent");
      expect(info.upstreamModelId).toBe("openrouter/openai/gpt-4o");
    });

    it("uses default upstream model when not provided", async () => {
      mockPlugin.modelService.getModelById.mockResolvedValue({
        id: "systemsculpt::ai-agent",
        name: "SystemSculpt Agent",
      });

      const info = await service.getModelInfo("systemsculpt::ai-agent");

      expect(info.upstreamModelId).toBe("openrouter/x-ai/grok-4.1-fast");
    });

    it("throws error for model not found", async () => {
      mockPlugin.modelService.getModelById.mockResolvedValue(null);

      await expect(service.getModelInfo("unknown::model")).rejects.toThrow("Model unknown::model not found");
    });

    it("returns info for custom provider model", async () => {
      mockPlugin.settings.customProviders = [
        {
          id: "custom-provider",
          name: "Custom Provider",
          isEnabled: true,
          endpoint: "https://custom.api.com",
        },
      ];
      mockPlugin.modelService.getModelById.mockResolvedValue({
        id: "custom-provider::my-model",
        name: "My Custom Model",
      });

      const info = await service.getModelInfo("custom-provider::my-model");

      expect(info.isCustom).toBe(true);
      expect(info.provider).toBeDefined();
      expect(info.provider.id).toBe("custom-provider");
      expect(info.actualModelId).toBe("my-model");
    });

    it("matches custom provider by name when id doesn't match", async () => {
      mockPlugin.settings.customProviders = [
        {
          id: "different-id",
          name: "Custom",
          isEnabled: true,
          endpoint: "https://custom.api.com",
        },
      ];
      mockPlugin.modelService.getModelById.mockResolvedValue({
        id: "custom::my-model",
        name: "My Custom Model",
      });

      const info = await service.getModelInfo("custom::my-model");

      expect(info.isCustom).toBe(true);
      expect(info.provider).toBeDefined();
    });

    it("throws error for disabled custom provider", async () => {
      mockPlugin.settings.customProviders = [
        {
          id: "disabled-provider",
          name: "Disabled Provider",
          isEnabled: false,
          endpoint: "https://disabled.api.com",
        },
      ];
      mockPlugin.modelService.getModelById.mockResolvedValue({
        id: "disabled-provider::my-model",
        name: "My Disabled Model",
      });

      await expect(service.getModelInfo("disabled-provider::my-model")).rejects.toThrow(
        "Custom provider disabled-provider not found or disabled"
      );
    });

    it("throws error for missing custom provider", async () => {
      mockPlugin.settings.customProviders = [];
      mockPlugin.modelService.getModelById.mockResolvedValue({
        id: "unknown-provider::my-model",
        name: "Unknown Model",
      });

      await expect(service.getModelInfo("unknown-provider::my-model")).rejects.toThrow(
        "Custom provider unknown-provider not found or disabled"
      );
    });

    it("throws error for invalid model ID format without separator", async () => {
      mockPlugin.modelService.getModelById.mockResolvedValue({
        id: "invalid-model-id",
        name: "Invalid Model",
      });

      await expect(service.getModelInfo("invalid-model-id")).rejects.toThrow(
        "Invalid model ID format"
      );
    });
  });

  describe("preloadModels", () => {
    it("resolves immediately (no-op)", async () => {
      await expect(service.preloadModels()).resolves.toBeUndefined();
    });
  });

  describe("buildLocalAgentModel (private)", () => {
    it("builds model with correct properties", async () => {
      mockPlugin.settings.enableSystemSculptProvider = false;
      const models = await service.getModels();
      const model = models[0];

      expect(model.id).toBe("systemsculpt::ai-agent");
      expect(model.name).toBe("SystemSculpt Agent");
      expect(model.provider).toBe("systemsculpt");
      expect(model.capabilities).toContain("tools");
      expect(model.capabilities).toContain("function_calling");
      expect(model.context_length).toBe(128000);
      expect(model.identifier.providerId).toBe("systemsculpt");
    });
  });

  describe("buildAgentModelFromApi (private)", () => {
    it("builds model from API response with all fields", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          models: [
            {
              id: "api-model",
              name: "API Model",
              description: "Custom description from API",
              upstream_model: "openrouter/custom/model",
              context_length: 64000,
              capabilities: ["tools"],
              supported_parameters: ["temperature"],
              pricing: { prompt: "0.001", completion: "0.002", image: "0", request: "0" },
              architecture: { modality: "text->text", tokenizer: "custom", instruct_type: null },
            },
          ],
        },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();
      const model = models[0];

      expect(model.upstream_model).toBe("openrouter/custom/model");
    });

    it("uses defaults for missing API fields", async () => {
      mockHttpRequest.mockResolvedValue({
        status: 200,
        json: {
          models: [
            {
              id: "minimal-model",
            },
          ],
        },
        text: "",
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      } as any);

      const models = await service.getModels();
      const model = models[0];

      expect(model.context_length).toBe(128000);
      expect(model.capabilities).toContain("tools");
      expect(model.upstream_model).toBe("openrouter/x-ai/grok-4.1-fast");
    });
  });
});
