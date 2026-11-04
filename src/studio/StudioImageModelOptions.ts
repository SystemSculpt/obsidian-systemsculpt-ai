import type { ManagedImageModel, ManagedImageModelCatalog } from "../services/images/ManagedImageModelCatalog";
import type { StudioNodeConfigSelectOption, StudioNodeInstance } from "./types";

function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function option(model: ManagedImageModel): StudioNodeConfigSelectOption {
  return {
    value: model.id,
    label: model.name,
    badge: `~${formatCredits(model.estimatedCredits)} credits/image`,
    description: model.description,
    keywords: [model.id, model.provider],
  };
}

/**
 * Image model options from the server catalog. A saved model the catalog no
 * longer lists stays selectable so the card never silently switches models.
 */
export async function resolveStudioImageModelOptions(
  catalog: Pick<ManagedImageModelCatalog, "load">,
  node: StudioNodeInstance,
): Promise<StudioNodeConfigSelectOption[]> {
  const { models } = await catalog.load();
  const options = models.map(option);
  const saved = typeof node.config.model === "string" ? node.config.model.trim() : "";
  if (saved && !options.some(entry => entry.value === saved)) options.unshift({ value: saved, label: saved });
  return options;
}
