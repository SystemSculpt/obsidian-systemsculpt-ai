import type SystemSculptPlugin from "../main";
import type { SystemSculptModel } from "../types";
import type { SystemSculptTextModelSourceMode } from "../types/llm";
import { SYSTEMSCULPT_PI_EXECUTION_MODEL_ID } from "./pi/PiCanonicalIds";
import { buildManagedSystemSculptModel, isManagedSystemSculptModelId } from "./systemsculpt/ManagedSystemSculptModel";
import { resolveManagedSystemSculptModelContract } from "./systemsculpt/ManagedSystemSculptRemoteConfig";

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
    const resolvedModel = await this.plugin.modelService.getModelById(modelId);

    // If the resolved model is a Pi-local BYOK model (not the managed SystemSculpt model),
    // respect its sourceMode and route through the local Pi runtime.
    if (
      resolvedModel &&
      resolvedModel.sourceMode === "pi_local" &&
      resolvedModel.piLocalAvailable &&
      resolvedModel.piExecutionModelId &&
      !isManagedSystemSculptModelId(resolvedModel.id)
    ) {
      return {
        isCustom: false,
        modelSource: "pi_local",
        model: resolvedModel,
        actualModelId: resolvedModel.piExecutionModelId,
      };
    }

    if (
      resolvedModel &&
      resolvedModel.sourceMode === "custom_endpoint" &&
      resolvedModel.piRemoteAvailable &&
      resolvedModel.piExecutionModelId &&
      !isManagedSystemSculptModelId(resolvedModel.id)
    ) {
      return {
        isCustom: true,
        modelSource: "custom_endpoint",
        model: resolvedModel,
        actualModelId: resolvedModel.piExecutionModelId,
      };
    }

    // Default: route through the managed SystemSculpt hosted model
    const managedContract = await resolveManagedSystemSculptModelContract(this.plugin);
    const managedModel = buildManagedSystemSculptModel(this.plugin, managedContract);
    const baseModel = resolvedModel || managedModel;

    return {
      isCustom: false,
      modelSource: "systemsculpt",
      model: {
        ...baseModel,
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
