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

  it("starts in a loading status before the first load resolves", () => {
    const plugin = buildPlugin();
    const service = UnifiedModelService.getInstance(plugin);
    expect(service.getCatalogStatus()).toEqual({ state: "loading", reason: null });
  });

  it("reports a ready status after a successful catalog load", async () => {
    const plugin = buildPlugin();
    const service = UnifiedModelService.getInstance(plugin);
    await service.getModels();
    expect(service.getCatalogStatus()).toEqual({ state: "ready", reason: null });
  });

  it("records an error status with a reason instead of a silent empty list", async () => {
    const plugin = buildPlugin();
    listPiTextCatalogModels.mockRejectedValue(new Error("endpoint unreachable"));
    const service = UnifiedModelService.getInstance(plugin);

    const models = await service.getModels();

    expect(models).toEqual([]);
    expect(service.getCatalogStatus()).toEqual({
      state: "error",
      reason: "endpoint unreachable",
    });
  });

  it("recovers to a ready status after a failed load is retried successfully", async () => {
    const plugin = buildPlugin();
    listPiTextCatalogModels.mockRejectedValueOnce(new Error("endpoint unreachable"));
    const service = UnifiedModelService.getInstance(plugin);

    await service.getModels();
    expect(service.getCatalogStatus().state).toBe("error");

    const recovered = await service.refreshModels();
    expect(recovered.length).toBeGreaterThan(0);
    expect(service.getCatalogStatus()).toEqual({ state: "ready", reason: null });
  });

  it("re-attempts the catalog on the next getModels after an error instead of serving a cached empty list (#206)", async () => {
    const plugin = buildPlugin();
    listPiTextCatalogModels.mockRejectedValueOnce(new Error("endpoint unreachable"));
    const service = UnifiedModelService.getInstance(plugin);

    // First load fails: error recorded, empty list returned.
    await service.getModels();
    expect(service.getCatalogStatus().state).toBe("error");

    // The chat picker's Retry path calls getModels() WITHOUT forcing a refresh.
    // A failed load must not cache an empty list (truthy []), or retry would
    // reuse it and re-throw the same error without ever hitting the catalog (#206).
    const recovered = await service.getModels();

    expect(listPiTextCatalogModels).toHaveBeenCalledTimes(2);
    expect(recovered.map((model: { id: string }) => model.id)).toContain(MANAGED_MODEL.id);
    expect(service.getCatalogStatus()).toEqual({ state: "ready", reason: null });
  });
});
