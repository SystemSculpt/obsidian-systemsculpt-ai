import type SystemSculptPlugin from "../../main";
import type { SystemSculptModel } from "../../types/llm";
import { buildManagedSystemSculptModel } from "../systemsculpt/ManagedSystemSculptModel";
import { PlatformContext } from "../PlatformContext";

function logPiCatalogFailure(
  plugin: SystemSculptPlugin,
  error: unknown,
): void {
  try {
    plugin.getLogger?.().warn("Pi text model catalog unavailable; falling back to managed model", {
      metadata: {
        error: error instanceof Error ? error.message : String(error || "Unknown error"),
      },
    });
  } catch {
    // Keep catalog fallback non-fatal even if logging is unavailable.
  }
}

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
    } catch (error) {
      logPiCatalogFailure(plugin, error);
    }
  }

  return models;
}
