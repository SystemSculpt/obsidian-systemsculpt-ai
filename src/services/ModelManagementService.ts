import type SystemSculptPlugin from "../main";
import type { SystemSculptModel } from "../types";
import { SystemSculptError, ERROR_CODES } from "../utils/errors";
import { listPiTextCatalogModels } from "./pi-native/PiTextCatalog";

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
    return await listPiTextCatalogModels(this.plugin);
  }

  public async getModelInfo(modelId: string): Promise<{
    isCustom: boolean;
    modelSource: "pi_managed" | "pi_local";
    model: SystemSculptModel;
    actualModelId: string;
  }> {
    const model = await this.plugin.modelService.getModelById(modelId);
    if (!model) {
      throw new SystemSculptError(
        `Model ${modelId} not found`,
        ERROR_CODES.MODEL_UNAVAILABLE,
        404
      );
    }

    const actualModelId = String(model.piExecutionModelId || "").trim();
    if (!actualModelId) {
      throw new SystemSculptError(
        `Model ${model.id} is missing a Pi execution id`,
        ERROR_CODES.MODEL_UNAVAILABLE,
        400
      );
    }

    return {
      isCustom: false,
      modelSource: model.piRemoteAvailable ? "pi_managed" : "pi_local",
      model,
      actualModelId,
    };
  }

  public async preloadModels(): Promise<void> {
    return Promise.resolve();
  }
}
