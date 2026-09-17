import {
  findManagedVideoEstimate,
  type ManagedVideoModel,
  type ManagedVideoModelCatalog,
} from "../services/videos/ManagedVideoModelCatalog";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeConfigSelectOption, StudioNodeInstance } from "./types";

export const STUDIO_VIDEO_GENERATION_NODE_KIND = "studio.video_generation";
/** Config keys whose change re-renders the card so dependent pickers refresh. */
export const STUDIO_VIDEO_MODEL_CONFIG_KEYS: readonly string[] = ["model", "durationSeconds", "resolution", "aspectRatio", "generateAudio"];

function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function modelBadge(model: ManagedVideoModel): string | undefined {
  const estimate = findManagedVideoEstimate(model, {
    resolution: model.defaultResolution,
    generateAudio: model.defaultGenerateAudio,
    durationSeconds: model.defaultDurationSeconds,
  });
  return estimate ? `~${formatCredits(estimate.estimatedCredits)} credits/clip` : undefined;
}

function modelDescription(model: ManagedVideoModel): string {
  const typical = model.typicalDurationMs ? ` Typically ~${Math.max(1, Math.round(model.typicalDurationMs / 1000))}s.` : "";
  return `${model.description} Default ${model.defaultDurationSeconds}s at ${model.defaultResolution}.${typical}`;
}

export function isStudioVideoOptionsSource(source: StudioNodeConfigDynamicOptionsSource): boolean {
  return source.startsWith("video_generation_");
}

/**
 * Dynamic select options for the video node. The model picker lists every
 * billable model with its default-combination price; the dependent pickers
 * offer the selected model's own matrix, or the first model's when none is
 * chosen yet, each with a "Model default" blank entry.
 */
export async function resolveStudioVideoModelOptions(
  catalog: Pick<ManagedVideoModelCatalog, "load">,
  source: StudioNodeConfigDynamicOptionsSource,
  node: StudioNodeInstance,
): Promise<StudioNodeConfigSelectOption[]> {
  const { models } = await catalog.load();
  if (source === "video_generation_models") return models.map(model => ({
    value: model.id,
    label: model.name,
    ...(modelBadge(model) ? { badge: modelBadge(model) } : {}),
    description: modelDescription(model),
    keywords: [model.id],
  }));
  const id = typeof node.config.model === "string" && node.config.model ? node.config.model : models[0]?.id;
  const model = models.find(model => model.id === id);
  if (!model) throw new Error("This video model is unavailable. Choose a current model.");
  const blank = { value: "", label: "Model default" };
  if (source === "video_generation_durations") {
    return [blank, ...model.durationsSeconds.map(seconds => ({ value: String(seconds), label: `${seconds}s` }))];
  }
  const values = source === "video_generation_resolutions" ? model.resolutions : model.aspectRatios;
  return [blank, ...values.map(value => ({ value, label: value }))];
}

/** Picking a different model returns the dependent options to that model's defaults. */
export function resetStudioVideoModelOptions(node: StudioNodeInstance, changedKey: string): void {
  if (node.kind !== STUDIO_VIDEO_GENERATION_NODE_KIND || changedKey !== "model") return;
  node.config.durationSeconds = "";
  node.config.resolution = "";
  node.config.aspectRatio = "";
}
