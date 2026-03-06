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

  it("delegates model listing to the Pi-native text catalog", async () => {
    const plugin = buildPlugin();
    listPiTextCatalogModels.mockResolvedValue([{ id: "openai@@gpt-5-mini" }]);

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const models = await service.getModels();

    expect(listPiTextCatalogModels).toHaveBeenCalledWith(plugin);
    expect(models).toEqual([{ id: "openai@@gpt-5-mini" }]);
  });

  it("returns the Pi execution id for remote models", async () => {
    const plugin = buildPlugin();
    (plugin.modelService.getModelById as jest.Mock).mockResolvedValue({
      id: "openai@@gpt-5-mini",
      provider: "openai",
      piExecutionModelId: "openai/gpt-5-mini",
      piRemoteAvailable: true,
    });

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const info = await service.getModelInfo("openai@@gpt-5-mini");

    expect(info).toMatchObject({
      isCustom: false,
      modelSource: "pi_managed",
      actualModelId: "openai/gpt-5-mini",
    });
  });

  it("returns the Pi execution id for local models", async () => {
    const plugin = buildPlugin();
    (plugin.modelService.getModelById as jest.Mock).mockResolvedValue({
      id: "ollama@@llama3.1:8b",
      provider: "ollama",
      piExecutionModelId: "ollama/llama3.1:8b",
      piRemoteAvailable: false,
    });

    const service = new ModelManagementService(plugin, "https://api.systemsculpt.com/api/v1");
    const info = await service.getModelInfo("ollama@@llama3.1:8b");

    expect(info).toMatchObject({
      isCustom: false,
      modelSource: "pi_local",
      actualModelId: "ollama/llama3.1:8b",
    });
  });
});
