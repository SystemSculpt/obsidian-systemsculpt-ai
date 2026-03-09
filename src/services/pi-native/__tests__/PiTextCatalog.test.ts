import { Platform } from "obsidian";
import { listLocalPiTextModels } from "../../pi/PiTextModels";

jest.mock("../../pi/PiTextModels", () => ({
  ...jest.requireActual("../../pi/PiTextModels"),
  listLocalPiTextModels: jest.fn().mockResolvedValue([]),
}));
import { listPiTextCatalogModels } from "../PiTextCatalog";

describe("PiTextCatalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
  });

  it("keeps the SystemSculpt alias canonical and pinned first", async () => {
    (listLocalPiTextModels as jest.Mock).mockResolvedValue([
      {
        providerId: "openai",
        modelId: "gpt-5-mini",
        label: "GPT-5 Mini",
        description: "context 128K",
        contextLength: 128_000,
        maxOutputTokens: 16_384,
        supportsReasoning: true,
        supportsImages: true,
        keywords: ["openai/gpt-5-mini"],
      },
      {
        providerId: "systemsculpt",
        modelId: "ai-agent",
        label: "SystemSculpt",
        description: "context 256K",
        contextLength: 256_000,
        maxOutputTokens: 32_768,
        supportsReasoning: true,
        supportsImages: true,
        keywords: ["systemsculpt/ai-agent"],
      },
    ]);

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "license_test", licenseValid: true },
    } as any);

    expect(models[0]).toMatchObject({
      id: "systemsculpt@@systemsculpt/ai-agent",
      name: "SystemSculpt",
      provider: "systemsculpt",
      piExecutionModelId: "systemsculpt/ai-agent",
      piAuthMode: "local",
      piRemoteAvailable: false,
      piLocalAvailable: true,
    });
  });

  it("keeps SystemSculpt visible but unavailable when no active license is configured", async () => {
    (listLocalPiTextModels as jest.Mock).mockResolvedValue([
      {
        providerId: "systemsculpt",
        modelId: "ai-agent",
        label: "SystemSculpt",
        description: "context 256K",
        contextLength: 256_000,
        maxOutputTokens: 32_768,
        supportsReasoning: true,
        supportsImages: true,
        keywords: ["systemsculpt/ai-agent"],
      },
    ]);

    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "", licenseValid: false },
    } as any);

    expect(models[0]).toMatchObject({
      id: "systemsculpt@@systemsculpt/ai-agent",
      name: "SystemSculpt",
      piLocalAvailable: false,
      description: "Add an active SystemSculpt license in Setup to use this model.",
    });
  });
});
