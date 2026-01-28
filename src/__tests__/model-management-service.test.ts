import { ModelManagementService } from "../services/ModelManagementService";
import { AGENT_CONFIG } from "../constants/agent";
import { DEFAULT_SETTINGS, SystemSculptSettings, SystemSculptModel } from "../types";
import SystemSculptPlugin from "../main";

jest.mock("../utils/httpClient", () => ({
  httpRequest: jest.fn(),
}));

const { httpRequest } = jest.requireMock("../utils/httpClient");

describe("ModelManagementService", () => {
  const buildPlugin = (overrides: Partial<SystemSculptSettings> = {}) => {
    const baseSettings: SystemSculptSettings = {
      ...DEFAULT_SETTINGS,
      licenseKey: "license-123",
      licenseValid: true,
      selectedModelId: AGENT_CONFIG.MODEL_ID,
      customProviders: [],
      ...overrides,
    } as SystemSculptSettings;
    const hasActiveLicense = !!baseSettings.licenseKey?.trim() && baseSettings.licenseValid === true;
    const settings: SystemSculptSettings = {
      ...baseSettings,
      enableSystemSculptProvider: hasActiveLicense,
      useSystemSculptAsFallback: hasActiveLicense,
    };

    const plugin = {
      settings,
      modelService: {
        getModelById: jest.fn(),
      },
    } as unknown as SystemSculptPlugin;

    return { plugin, settings };
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns the single SystemSculpt AI Agent with canonical id when licensed", async () => {
    const { plugin } = buildPlugin();
    httpRequest.mockResolvedValue({
      status: 200,
      json: {
        models: [
          {
            id: "systemsculpt/ai-agent",
            name: "SystemSculpt AI Agent",
            description: "Powerful reasoning",
            context_length: 128000,
            pricing: {
              prompt: "0.000010",
              completion: "0.000030",
              image: "0.001",
              request: "0",
            },
          },
        ],
      },
    });

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const models = await service.getModels();

    expect(models).toHaveLength(1);
    const [model] = models;
    expect(model.id).toBe(AGENT_CONFIG.MODEL_ID);
    expect(model.name).toBe(AGENT_CONFIG.MODEL_DISPLAY_NAME);
    expect(model.provider).toBe("systemsculpt");
    expect(model.identifier?.modelId).toBe("systemsculpt/ai-agent");
    expect(model.identifier?.displayName).toBe(AGENT_CONFIG.MODEL_DISPLAY_NAME);
    expect(model.upstream_model).toBe("openrouter/x-ai/grok-4.1-fast");
  });

  it("falls back to local agent model when license missing", async () => {
    const { plugin } = buildPlugin({ licenseKey: "" });
    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");

    const models = await service.getModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe(AGENT_CONFIG.MODEL_ID);
    expect(models[0].name).toBe(AGENT_CONFIG.MODEL_DISPLAY_NAME);
    expect(models[0].upstream_model).toBe("openrouter/x-ai/grok-4.1-fast");
  });

  it("maps SystemSculpt public id to upstream provider model for server requests", async () => {
    const { plugin } = buildPlugin();
    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");

    const systemModel: SystemSculptModel = {
      id: AGENT_CONFIG.MODEL_ID,
      name: AGENT_CONFIG.MODEL_DISPLAY_NAME,
      description: AGENT_CONFIG.MODEL_DESCRIPTION,
      provider: "systemsculpt",
      identifier: {
        providerId: "systemsculpt",
        modelId: "systemsculpt/ai-agent",
        displayName: AGENT_CONFIG.MODEL_DISPLAY_NAME,
      },
      upstream_model: "openrouter/x-ai/grok-4.1-fast",
      context_length: 128000,
      capabilities: ["tools", "function_calling", "vision"],
      architecture: { modality: "text+image->text", tokenizer: "unknown", instruct_type: null },
      pricing: { prompt: "0.000010", completion: "0.000030", image: "0", request: "0" },
    };

    (plugin.modelService.getModelById as jest.Mock).mockResolvedValue(systemModel);

    const info = await service.getModelInfo(AGENT_CONFIG.MODEL_ID);
    expect(info.isCustom).toBe(false);
    expect(info.actualModelId).toBe("systemsculpt/ai-agent");
    expect(info.upstreamModelId).toBe("openrouter/x-ai/grok-4.1-fast");
  });
});
