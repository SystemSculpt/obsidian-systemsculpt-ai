import { ModelManagementService } from "../services/ModelManagementService";
import SystemSculptPlugin from "../main";

jest.mock("../services/pi-native/PiTextCatalog", () => ({
  listPiTextCatalogModels: jest.fn(),
}));

const { listPiTextCatalogModels } = jest.requireMock("../services/pi-native/PiTextCatalog");

describe("ModelManagementService", () => {
  const buildPlugin = () =>
    ({
      modelService: {
        getModelById: jest.fn(),
      },
    } as unknown as SystemSculptPlugin);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("delegates model listing to the managed SystemSculpt catalog", async () => {
    const plugin = buildPlugin();
    listPiTextCatalogModels.mockResolvedValue([{ id: "systemsculpt@@systemsculpt/ai-agent" }]);

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const models = await service.getModels();

    expect(listPiTextCatalogModels).toHaveBeenCalledWith(plugin);
    expect(models).toEqual([{ id: "systemsculpt@@systemsculpt/ai-agent" }]);
  });

  it("normalizes the SystemSculpt model to the hosted managed source", async () => {
    const plugin = buildPlugin();
    (plugin.modelService.getModelById as jest.Mock).mockResolvedValue({
      id: "systemsculpt@@systemsculpt/ai-agent",
      provider: "systemsculpt",
      sourceMode: "pi_local",
      piExecutionModelId: "systemsculpt/ai-agent",
      piLocalAvailable: true,
    });

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const info = await service.getModelInfo("systemsculpt@@systemsculpt/ai-agent");

    expect(info).toMatchObject({
      isCustom: false,
      modelSource: "systemsculpt",
      actualModelId: "systemsculpt/ai-agent",
      model: expect.objectContaining({
        sourceMode: "systemsculpt",
        piAuthMode: "hosted",
        piRemoteAvailable: true,
        piLocalAvailable: false,
      }),
    });
  });

  it("routes non-SystemSculpt Pi models through the local Pi execution path", async () => {
    const plugin = buildPlugin();
    (plugin.modelService.getModelById as jest.Mock).mockResolvedValue({
      id: "local-pi-openai@@gpt-4.1",
      provider: "openai",
      sourceMode: "pi_local",
      sourceProviderId: "openai",
      piExecutionModelId: "openai/gpt-4.1",
      piLocalAvailable: true,
    });

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const info = await service.getModelInfo("local-pi-openai@@gpt-4.1");

    expect(info).toMatchObject({
      isCustom: false,
      modelSource: "pi_local",
      actualModelId: "openai/gpt-4.1",
      model: expect.objectContaining({
        id: "local-pi-openai@@gpt-4.1",
        provider: "openai",
        sourceMode: "pi_local",
      }),
    });
  });

  it("falls back to the managed SystemSculpt model when a legacy model id is requested", async () => {
    const plugin = buildPlugin();
    (plugin.modelService.getModelById as jest.Mock).mockResolvedValue(undefined);

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const info = await service.getModelInfo("local-pi-openai@@gpt-4.1");

    expect(info).toMatchObject({
      isCustom: false,
      modelSource: "systemsculpt",
      actualModelId: "systemsculpt/ai-agent",
      model: expect.objectContaining({
        id: "systemsculpt@@systemsculpt/ai-agent",
        provider: "systemsculpt",
      }),
    });
  });
});
