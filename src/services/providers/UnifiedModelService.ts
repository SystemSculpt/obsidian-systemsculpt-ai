import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { FavoritesService } from "../FavoritesService";
import { RuntimeIncompatibilityService } from "../RuntimeIncompatibilityService";
import {
  findModelById,
  filterChatModels,
  getToolCompatibilityInfo,
  supportsTools,
} from "../../utils/modelUtils";
import { listPiTextCatalogModels } from "../pi-native/PiTextCatalog";
import { resolveLegacyPiTextSelection } from "../pi-native/PiTextMigration";

export class UnifiedModelService {
  private static instance: UnifiedModelService | null = null;
  private favoritesService: FavoritesService;
  private cachedModels: SystemSculptModel[] | null = null;
  private loadingPromise: Promise<SystemSculptModel[]> | null = null;
  private isInitialLoadDone = false;

  private constructor(private readonly plugin: SystemSculptPlugin) {
    this.favoritesService = FavoritesService.getInstance(plugin);
  }

  public static getInstance(plugin: SystemSculptPlugin): UnifiedModelService {
    if (!this.instance) {
      this.instance = new UnifiedModelService(plugin);
    }
    return this.instance;
  }

  public static clearInstance(): void {
    this.instance = null;
  }

  private async loadModels(forceRefresh: boolean): Promise<SystemSculptModel[]> {
    if (!forceRefresh && this.cachedModels) {
      return this.cachedModels;
    }
    if (!forceRefresh && this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = (async () => {
      const models = await listPiTextCatalogModels(this.plugin);
      this.favoritesService.processFavorites(models);

      const incompatService = RuntimeIncompatibilityService.getInstance(this.plugin);
      const modelsWithRuntimeFlags = models.map((model) =>
        incompatService.applyRuntimeFlags(model)
      );

      this.cachedModels = modelsWithRuntimeFlags;

      if (!this.isInitialLoadDone) {
        await this.validateSelectedModel(modelsWithRuntimeFlags);
        this.isInitialLoadDone = true;
      }

      return modelsWithRuntimeFlags;
    })();

    try {
      return await this.loadingPromise;
    } finally {
      this.loadingPromise = null;
    }
  }

  public async getModels(forceRefresh: boolean = false): Promise<SystemSculptModel[]> {
    try {
      return await this.loadModels(forceRefresh);
    } catch {
      this.cachedModels = [];
      return [];
    }
  }

  public async getModelById(modelId: string): Promise<SystemSculptModel | undefined> {
    if (this.cachedModels) {
      const cached = findModelById(this.cachedModels, modelId);
      if (cached) {
        return cached;
      }
    }

    const models = await this.getModels();
    return findModelById(models, modelId);
  }

  public findBestAlternativeModel(
    unavailableModelId: string,
    models: SystemSculptModel[]
  ): SystemSculptModel | undefined {
    const chatModels = filterChatModels(models).filter((model) => model.id !== unavailableModelId);
    if (chatModels.length === 0) {
      return undefined;
    }

    const unavailable = findModelById(models, unavailableModelId);
    if (!unavailable) {
      return chatModels[0];
    }

    const sameProvider = chatModels.filter(
      (model) => (model.provider || "").toLowerCase() === (unavailable.provider || "").toLowerCase()
    );
    if (sameProvider.length > 0) {
      const localPreferred = sameProvider.find((model) => model.piLocalAvailable);
      return localPreferred || sameProvider[0];
    }

    const localPreferred = chatModels.find((model) => model.piLocalAvailable);
    return localPreferred || chatModels[0];
  }

  public async validateSelectedModel(
    models?: SystemSculptModel[]
  ): Promise<{
    wasReplaced: boolean;
    oldModelId?: string;
    newModel?: SystemSculptModel;
    forDefault: boolean;
  }> {
    const result = {
      wasReplaced: false,
      oldModelId: undefined as string | undefined,
      newModel: undefined as SystemSculptModel | undefined,
      forDefault: true,
    };

    const modelList = models || (await this.getModels());
    const savedId = String(this.plugin.settings.selectedModelId || "").trim();
    if (!savedId) {
      return result;
    }

    const directMatch = findModelById(modelList, savedId);
    if (directMatch) {
      return result;
    }

    const migrated = resolveLegacyPiTextSelection(
      savedId,
      modelList,
      this.plugin.settings.customProviders || []
    );
    if (migrated) {
      result.wasReplaced = true;
      result.oldModelId = savedId;
      result.newModel = migrated;
      await this.plugin.getSettingsManager().updateSettings({ selectedModelId: migrated.id });
      return result;
    }

    if (modelList.length > 0) {
      const fallbackModel = this.findBestAlternativeModel(savedId, modelList);
      if (fallbackModel) {
        result.wasReplaced = true;
        result.oldModelId = savedId;
        result.newModel = fallbackModel;
        await this.plugin.getSettingsManager().updateSettings({ selectedModelId: fallbackModel.id });
      }
    } else {
      await this.plugin.getSettingsManager().updateSettings({ selectedModelId: "" });
    }

    return result;
  }

  public async validateSpecificModel(
    modelId: string,
    models?: SystemSculptModel[]
  ): Promise<{
    isAvailable: boolean;
    alternativeModel?: SystemSculptModel;
  }> {
    const modelList = models || this.cachedModels || (await this.getModels());
    const found = findModelById(modelList, modelId);
    if (found) {
      return { isAvailable: true };
    }

    return {
      isAvailable: false,
      alternativeModel: modelList.length > 0
        ? this.findBestAlternativeModel(modelId, modelList)
        : undefined,
    };
  }

  public async toggleFavorite(model: SystemSculptModel): Promise<void> {
    await this.favoritesService.toggleFavorite(model);
    this.cachedModels = null;
  }

  public async refreshModels(): Promise<SystemSculptModel[]> {
    this.cachedModels = null;
    return await this.getModels(true);
  }

  public async checkToolCompatibility(modelId: string): Promise<{
    isCompatible: boolean;
    reason: string;
    confidence: "high" | "medium" | "low";
  }> {
    const model = await this.getModelById(modelId);
    if (!model) {
      return {
        isCompatible: false,
        reason: "Model not found",
        confidence: "high",
      };
    }
    return getToolCompatibilityInfo(model);
  }

  public async getToolCompatibleModels(): Promise<SystemSculptModel[]> {
    const models = await this.getModels();
    return models.filter((model) => supportsTools(model));
  }

  public async testAllConnections(): Promise<{
    systemSculpt: boolean;
    customProviders: boolean;
    localPi: boolean;
  }> {
    const models = await this.getModels(true);
    return {
      systemSculpt: models.some(
        (model) =>
          String(model.provider || "").trim().toLowerCase() === "systemsculpt" &&
          !!model.piExecutionModelId
      ),
      customProviders: models.some((model) => model.piAuthMode === "byok"),
      localPi: models.some((model) => model.piLocalAvailable),
    };
  }

  public getCachedModels(): SystemSculptModel[] {
    return this.cachedModels ? [...this.cachedModels] : [];
  }

  public clearAllCaches(): void {
    this.cachedModels = null;
    this.loadingPromise = null;
  }
}
