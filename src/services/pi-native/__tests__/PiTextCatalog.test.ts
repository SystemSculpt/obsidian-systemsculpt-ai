import { Platform } from "obsidian";
import { listPiTextCatalogModels } from "../PiTextCatalog";

describe("PiTextCatalog", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(Platform, "isDesktopApp", {
      configurable: true,
      value: true,
    });
  });

  it("returns the single managed SystemSculpt model", async () => {
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

  it("keeps the managed SystemSculpt model visible when no active license is configured", async () => {
    const models = await listPiTextCatalogModels({
      settings: { serverUrl: "http://localhost:3000", licenseKey: "", licenseValid: false },
    } as any);

    expect(models[0]).toMatchObject({
      id: "systemsculpt@@systemsculpt/ai-agent",
      name: "SystemSculpt",
      piLocalAvailable: false,
      description: "Add an active SystemSculpt license in Setup to use SystemSculpt.",
    });
  });
});
