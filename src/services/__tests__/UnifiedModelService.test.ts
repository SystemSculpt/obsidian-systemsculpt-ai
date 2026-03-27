import { UnifiedModelService } from "../providers/UnifiedModelService";

jest.mock("../FavoritesService", () => ({
  FavoritesService: {
    getInstance: jest.fn(() => ({
      processFavorites: jest.fn(),
      toggleFavorite: jest.fn().mockResolvedValue(undefined),
    })),
  },
}));

jest.mock("../RuntimeIncompatibilityService", () => ({
  RuntimeIncompatibilityService: {
    getInstance: jest.fn(() => ({
      applyRuntimeFlags: jest.fn((model) => model),
    })),
  },
}));

jest.mock("../pi-native/PiTextCatalog", () => ({
  listPiTextCatalogModels: jest.fn(),
}));

const { listPiTextCatalogModels } = jest.requireMock("../pi-native/PiTextCatalog");

const MANAGED_MODEL = {
  id: "systemsculpt@@systemsculpt/ai-agent",
  name: "SystemSculpt",
  description: "Managed SystemSculpt chat model.",
  provider: "systemsculpt",
  sourceMode: "systemsculpt",
  piExecutionModelId: "systemsculpt/ai-agent",
  piLocalAvailable: false,
  capabilities: ["chat", "reasoning"],
  supported_parameters: ["tools"],
};

describe("UnifiedModelService", () => {
  function buildPlugin() {
    const updateSettings = jest.fn().mockImplementation(async (patch: Record<string, unknown>) => {
      Object.assign(plugin.settings, patch);
    });

    const plugin = {
      settings: {
        selectedModelId: "",
        customProviders: [],
      },
      getSettingsManager: jest.fn(() => ({
        updateSettings,
      })),
      __updateSettings: updateSettings,
    } as any;

    return plugin;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    UnifiedModelService.clearInstance();
    listPiTextCatalogModels.mockResolvedValue([{ ...MANAGED_MODEL }]);
  });

  it("replaces stale selected-model ids with the managed SystemSculpt model", async () => {
    const plugin = buildPlugin();
    plugin.settings.selectedModelId = "local-pi-openai@@gpt-4.1";

    const service = UnifiedModelService.getInstance(plugin);
    await service.getModels();

    expect(plugin.settings.selectedModelId).toBe(MANAGED_MODEL.id);
    expect(plugin.__updateSettings).toHaveBeenCalledWith({
      selectedModelId: MANAGED_MODEL.id,
    });
  });

  it("offers the managed SystemSculpt model as the only alternative for unknown ids", async () => {
    const plugin = buildPlugin();
    const service = UnifiedModelService.getInstance(plugin);

    const result = await service.validateSpecificModel("local-pi-openai@@gpt-4.1");

    expect(result).toEqual({
      isAvailable: false,
      alternativeModel: expect.objectContaining({
        id: MANAGED_MODEL.id,
      }),
    });
  });

  it("reports local Pi availability when Pi-backed models are present", async () => {
    const plugin = buildPlugin();
    listPiTextCatalogModels.mockResolvedValue([
      { ...MANAGED_MODEL },
      {
        ...MANAGED_MODEL,
        id: "local-pi-openai@@gpt-4.1",
        provider: "openai",
        sourceMode: "pi_local",
        piExecutionModelId: "openai/gpt-4.1",
        piLocalAvailable: true,
      },
    ]);
    const service = UnifiedModelService.getInstance(plugin);

    await service.getModels();
    await expect(service.testAllConnections()).resolves.toEqual({
      systemSculpt: true,
      customProviders: false,
      localPi: true,
    });
  });
});
