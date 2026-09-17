import type SystemSculptPlugin from "../main";
import type { ManagedImageModelCatalog } from "../services/images/ManagedImageModelCatalog";
import { getStudioMediaCatalogs } from "./StudioMediaCatalogs";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeConfigSelectOption, StudioNodeInstance } from "./types";

export async function resolveStudioImageModelOptions(
  catalog: Pick<ManagedImageModelCatalog, "load">,
  source: StudioNodeConfigDynamicOptionsSource,
  node: StudioNodeInstance,
): Promise<StudioNodeConfigSelectOption[]> {
  const { models, defaultModelId } = await catalog.load();
  if (source === "image_models") return models.map(model => ({
    value: model.id,
    label: model.name,
    badge: `~${model.estimatedCredits} credits/image`,
    description: `${model.description} Up to ${model.maxImages} per job.${model.reservationCredits ? ` Temporary hold from ${model.reservationCredits} credits/image.` : ""}`,
    keywords: [model.id],
  }));
  const id = typeof node.config.model === "string" && node.config.model ? node.config.model : defaultModelId;
  const model = models.find(model => model.id === id);
  if (!model) throw new Error("This image model is unavailable. Choose a current model.");
  const values = source === "image_sizes" ? model.imageSizes : source === "image_qualities" ? model.qualities : model.aspectRatios;
  return [{ value: "", label: "Model default" }, ...values.map(value => ({ value, label: value }))];
}

export function resolveStudioImageModelOptionsForPlugin(plugin: SystemSculptPlugin, source: StudioNodeConfigDynamicOptionsSource, node: StudioNodeInstance): Promise<StudioNodeConfigSelectOption[]> {
  return resolveStudioImageModelOptions(getStudioMediaCatalogs(plugin).images, source, node);
}

export function resetStudioImageModelOptions(node: StudioNodeInstance, changedKey: string): void {
  if (node.kind !== "studio.image_generation" || changedKey !== "model") return;
  node.config.aspectRatio = "";
  node.config.imageSize = "";
  node.config.quality = "";
  node.config.count = 1;
}
