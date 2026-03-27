import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { buildManagedSystemSculptModel } from "../systemsculpt/ManagedSystemSculptModel";
import { PlatformContext } from "../PlatformContext";

export async function listPiTextCatalogModels(
  plugin: SystemSculptPlugin
): Promise<SystemSculptModel[]> {
  const models: SystemSculptModel[] = [buildManagedSystemSculptModel(plugin)];

  // On desktop, include all models from authenticated Pi providers
  if (PlatformContext.get().supportsDesktopOnlyFeatures()) {
    try {
      const { listLocalPiTextModelsAsSystemModels } = await import("../pi/PiTextModels");
      const localModels = await listLocalPiTextModelsAsSystemModels(plugin);

      // Deduplicate: skip any local model whose id already matches the managed model
      const existingIds = new Set(models.map((m) => m.id));
      for (const model of localModels) {
        if (!existingIds.has(model.id)) {
          models.push(model);
          existingIds.add(model.id);
        }
      }
    } catch {
      // Pi model registry unavailable — fall back to managed model only.
    }
  }

  return models;
}
