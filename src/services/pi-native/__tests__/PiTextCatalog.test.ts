import { listPiTextCatalogModels } from "../PiTextCatalog";
import { PlatformContext } from "../../PlatformContext";
import { MANAGED_SYSTEMSCULPT_MODEL_CONTRACT } from "../../systemsculpt/ManagedSystemSculptContract";
import { clearManagedSystemSculptModelContractCacheForTests } from "../../systemsculpt/ManagedSystemSculptRemoteConfig";

const mockPlatformRequest = jest.fn();

jest.mock("../../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(),
  },
}));

jest.mock("../../PlatformRequestClient", () => ({
  PlatformRequestClient: jest.fn().mockImplementation(() => ({
    request: mockPlatformRequest,
  })),
}));

jest.mock("../../pi/PiTextModels", () => ({
  isSupportedOpenAiCodexChatModel: jest.fn((providerId: string, modelId: string) => {
    if (providerId !== "openai-codex") {
      return true;
    }
    return !["gpt-5.1", "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5.2-codex", "gpt-5.3-codex-spark"].includes(modelId);
  }),
  listLocalPiTextModelsAsSystemModels: jest.fn(),
}));

jest.mock("../../providerRuntime/RemoteProviderCatalog", () => ({
  listConfiguredRemoteProviderModels: jest.fn(() => []),
}));

const { listLocalPiTextModelsAsSystemModels } = jest.requireMock("../../pi/PiTextModels");
const { listConfiguredRemoteProviderModels } = jest.requireMock("../../providerRuntime/RemoteProviderCatalog");

describe("PiTextCatalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearManagedSystemSculptModelContractCacheForTests();
    mockPlatformRequest.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    (PlatformContext.get as jest.Mock).mockReturnValue({
      supportsDesktopOnlyFeatures: () => true,
    });
  });

  it("always includes the managed SystemSculpt model", async () => {
    listLocalPiTextModelsAsSystemModels.mockResolvedValue([]);

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "license_test", licenseValid: true },
    } as any);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "systemsculpt@@systemsculpt/ai-agent",
      name: "SystemSculpt",
      provider: "systemsculpt",
      piExecutionModelId: "systemsculpt/ai-agent",
      sourceMode: "systemsculpt",
      piAuthMode: "hosted",
      piRemoteAvailable: true,
      piLocalAvailable: false,
      context_length: MANAGED_SYSTEMSCULPT_MODEL_CONTRACT.contextLength,
      capabilities: [...MANAGED_SYSTEMSCULPT_MODEL_CONTRACT.capabilities],
      top_provider: expect.objectContaining({
        context_length: MANAGED_SYSTEMSCULPT_MODEL_CONTRACT.contextLength,
        max_completion_tokens: MANAGED_SYSTEMSCULPT_MODEL_CONTRACT.maxCompletionTokens,
      }),
    });
  });

  it("includes desktop-local Pi models when Pi is available", async () => {
    listLocalPiTextModelsAsSystemModels.mockResolvedValue([
      {
        id: "local-pi-openai@@gpt-4.1",
        name: "gpt-4.1",
        provider: "openai",
        sourceMode: "pi_local",
        sourceProviderId: "openai",
        piExecutionModelId: "openai/gpt-4.1",
        piLocalAvailable: true,
      },
      {
        id: "systemsculpt@@systemsculpt/ai-agent",
        name: "SystemSculpt duplicate",
        provider: "systemsculpt",
        sourceMode: "pi_local",
        piExecutionModelId: "systemsculpt/ai-agent",
        piLocalAvailable: true,
      },
    ]);

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "license_test", licenseValid: true },
    } as any);

    expect(models.map((model) => model.id)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
      "local-pi-openai@@gpt-4.1",
    ]);
  });

  it("omits OpenAI Codex models rejected by ChatGPT-account Codex auth", async () => {
    listLocalPiTextModelsAsSystemModels.mockResolvedValue([
      {
        id: "local-pi-openai-codex@@gpt-5.1",
        name: "GPT-5.1",
        provider: "openai-codex",
        sourceMode: "pi_local",
        sourceProviderId: "openai-codex",
        piExecutionModelId: "openai-codex/gpt-5.1",
        piLocalAvailable: true,
      },
      {
        id: "local-pi-openai-codex@@gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        provider: "openai-codex",
        sourceMode: "pi_local",
        sourceProviderId: "openai-codex",
        piExecutionModelId: "openai-codex/gpt-5.4-mini",
        piLocalAvailable: true,
      },
      {
        id: "local-pi-openai-codex@@gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "openai-codex",
        sourceMode: "pi_local",
        sourceProviderId: "openai-codex",
        piExecutionModelId: "openai-codex/gpt-5.3-codex-spark",
        piLocalAvailable: true,
      },
    ]);

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "license_test", licenseValid: true },
    } as any);

    expect(models.map((model) => model.id)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
      "local-pi-openai-codex@@gpt-5.4-mini",
    ]);
  });

  it("falls back to the managed model when local Pi discovery fails", async () => {
    listLocalPiTextModelsAsSystemModels.mockRejectedValue(new Error("Pi RPC unavailable"));

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "", licenseValid: false },
    } as any);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "systemsculpt@@systemsculpt/ai-agent",
      description: "Add an active SystemSculpt license in Setup to use SystemSculpt.",
    });
    expect(mockPlatformRequest).not.toHaveBeenCalled();
  });

  it("keeps mobile limited to the managed SystemSculpt model", async () => {
    (PlatformContext.get as jest.Mock).mockReturnValue({
      supportsDesktopOnlyFeatures: () => false,
    });
    listLocalPiTextModelsAsSystemModels.mockResolvedValue([
      {
        id: "local-pi-openai@@gpt-4.1",
        piExecutionModelId: "openai/gpt-4.1",
        piLocalAvailable: true,
      },
    ]);

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "license_test", licenseValid: true },
    } as any);

    expect(listLocalPiTextModelsAsSystemModels).not.toHaveBeenCalled();
    expect(models.map((model) => model.id)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
    ]);
  });

  it("includes configured remote provider models on mobile", async () => {
    (PlatformContext.get as jest.Mock).mockReturnValue({
      supportsDesktopOnlyFeatures: () => false,
    });
    listConfiguredRemoteProviderModels.mockReturnValue([
      {
        id: "openrouter@@openai/gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        provider: "openrouter",
        sourceMode: "custom_endpoint",
        sourceProviderId: "openrouter",
        piExecutionModelId: "openai/gpt-5.4-mini",
        piRemoteAvailable: true,
        piLocalAvailable: false,
      },
    ]);

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "license_test", licenseValid: true },
    } as any);

    expect(models.map((model) => model.id)).toEqual([
      "systemsculpt@@systemsculpt/ai-agent",
      "openrouter@@openai/gpt-5.4-mini",
    ]);
    expect(listLocalPiTextModelsAsSystemModels).not.toHaveBeenCalled();
  });

  it("hydrates managed model metadata from the website plugin config when available", async () => {
    mockPlatformRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        api: {
          configured_managed_model: {
            context_window: 196_608,
            max_completion_tokens: 24_576,
            capabilities: ["chat", "reasoning", "vision", "tools"],
            modality: "text+image->text",
          },
        },
      }),
    });
    listLocalPiTextModelsAsSystemModels.mockResolvedValue([]);

    const models = await listPiTextCatalogModels({
      manifest: { version: "5.1.0" },
      settings: { serverUrl: "http://localhost:3000", licenseKey: "license_test", licenseValid: true },
    } as any);

    expect(mockPlatformRequest).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining("/api/plugin/config"),
      method: "GET",
      licenseKey: "license_test",
    }));
    expect(models[0]).toMatchObject({
      context_length: 196_608,
      capabilities: ["chat", "reasoning", "vision", "tools"],
      top_provider: expect.objectContaining({
        context_length: 196_608,
        max_completion_tokens: 24_576,
      }),
    });
  });
});
