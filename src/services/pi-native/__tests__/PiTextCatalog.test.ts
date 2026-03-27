import { listPiTextCatalogModels } from "../PiTextCatalog";
import { PlatformContext } from "../../PlatformContext";

jest.mock("../../PlatformContext", () => ({
  PlatformContext: {
    get: jest.fn(),
  },
}));

jest.mock("../../pi/PiTextModels", () => ({
  listLocalPiTextModelsAsSystemModels: jest.fn(),
}));

const { listLocalPiTextModelsAsSystemModels } = jest.requireMock("../../pi/PiTextModels");

describe("PiTextCatalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
