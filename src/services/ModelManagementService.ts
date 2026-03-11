import type SystemSculptPlugin from "../main";
import type { SystemSculptModel } from "../types";
import type { SystemSculptTextModelSourceMode } from "../types/llm";
import { SYSTEMSCULPT_PI_EXECUTION_MODEL_ID } from "./pi/PiCanonicalIds";
import { buildManagedSystemSculptModel } from "./systemsculpt/ManagedSystemSculptModel";

async function loadPiTextCatalogModule(): Promise<typeof import("./pi-native/PiTextCatalog")> {
  return await import("./pi-native/PiTextCatalog");
}

export class ModelManagementService {
  private plugin: SystemSculptPlugin;
  private baseUrl: string;

  constructor(plugin: SystemSculptPlugin, baseUrl: string) {
    this.plugin = plugin;
    this.baseUrl = baseUrl;
  }

  public updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  public stripProviderPrefixes(modelId: string): string {
    return modelId;
  }

  public async getModels(): Promise<SystemSculptModel[]> {
    const { listPiTextCatalogModels } = await loadPiTextCatalogModule();
    return await listPiTextCatalogModels(this.plugin);
  }

  public async getModelInfo(modelId: string): Promise<{
    isCustom: boolean;
    modelSource: SystemSculptTextModelSourceMode;
    model: SystemSculptModel;
    actualModelId: string;
  }> {
    const resolvedModel =
      (await this.plugin.modelService.getModelById(modelId)) || buildManagedSystemSculptModel(this.plugin);
    const managedModel = buildManagedSystemSculptModel(this.plugin);

    return {
      isCustom: false,
      modelSource: "systemsculpt",
      model: {
        ...resolvedModel,
        ...managedModel,
        id: managedModel.id,
        name: managedModel.name,
        provider: managedModel.provider,
      },
      actualModelId: SYSTEMSCULPT_PI_EXECUTION_MODEL_ID,
    };
  }

  public async preloadModels(): Promise<void> {
    return Promise.resolve();
  }
}
