import type { ManagedImageModel, ManagedImageModelCatalogSnapshot } from "../services/images/ManagedImageModelCatalog";
import type { ManagedVideoModel, ManagedVideoModelCatalogSnapshot } from "../services/videos/ManagedVideoModelCatalog";
import type { StudioNodeInstance } from "./types";

export type StudioMediaModelKind = "image" | "video";

/**
 * What the selected model can take, projected onto one node: ports it does
 * not accept are hidden, config fields it does not offer are hidden, and the
 * remaining ports carry the model's own limits as their help text.
 */
export type StudioMediaNodeInputPlan = Readonly<{
  kind: StudioMediaModelKind;
  modelId: string;
  model: ManagedImageModel | ManagedVideoModel | null;
  hiddenInputPortIds: readonly string[];
  inputPortNotes: Readonly<Record<string, string>>;
  hiddenFieldKeys: readonly string[];
  /** Upper bound for the image count field, when the model publishes one. */
  countMax: number | null;
}>;

export function resolveStudioMediaNodeKind(kind: string): StudioMediaModelKind | null {
  const normalized = String(kind || "").trim();
  if (normalized === "studio.image_generation") return "image";
  if (normalized === "studio.video_generation") return "video";
  return null;
}

function selectedModelId(node: Pick<StudioNodeInstance, "config">): string {
  const value = node.config?.model;
  return typeof value === "string" ? value.trim() : "";
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function planStudioImageNodeInputs(model: ManagedImageModel | null, modelId = model?.id ?? ""): StudioMediaNodeInputPlan {
  if (!model) {
    return { kind: "image", modelId, model: null, hiddenInputPortIds: [], inputPortNotes: { images: "Reference images; the chosen model sets the limit." }, hiddenFieldKeys: [], countMax: null };
  }
  const hiddenInputPortIds = model.supportsImageInput ? [] : ["images"];
  const inputPortNotes = model.supportsImageInput
    ? { images: `Up to ${plural(model.maxInputReferences, "reference image")} for ${model.name}.` }
    : { images: `${model.name} is text-only and does not accept reference images.` };
  const hiddenFieldKeys = [
    ...(model.qualities.length === 0 ? ["quality"] : []),
    ...(model.imageSizes.length === 0 ? ["imageSize"] : []),
    ...(model.maxImages <= 1 ? ["count"] : []),
  ];
  return { kind: "image", modelId, model, hiddenInputPortIds, inputPortNotes, hiddenFieldKeys, countMax: model.maxImages };
}

export function planStudioVideoNodeInputs(model: ManagedVideoModel | null, modelId = model?.id ?? ""): StudioMediaNodeInputPlan {
  if (!model) {
    return { kind: "video", modelId, model: null, hiddenInputPortIds: [], inputPortNotes: {}, hiddenFieldKeys: [], countMax: null };
  }
  const roles = new Set(model.supportedFrameRoles);
  const hiddenInputPortIds = (["first_frame", "last_frame"] as const).filter(role => !roles.has(role));
  const inputPortNotes: Record<string, string> = {};
  if (roles.has("first_frame")) inputPortNotes.first_frame = `Still image ${model.name} uses as the exact first frame.`;
  if (roles.has("last_frame")) inputPortNotes.last_frame = `Still image ${model.name} uses as the exact last frame.`;
  const hiddenFieldKeys = [
    ...(model.supportsAudioToggle ? [] : ["generateAudio"]),
    ...(model.durationsSeconds.length <= 1 ? ["durationSeconds"] : []),
    ...(model.resolutions.length <= 1 ? ["resolution"] : []),
    ...(model.aspectRatios.length <= 1 ? ["aspectRatio"] : []),
  ];
  return { kind: "video", modelId, model, hiddenInputPortIds, inputPortNotes, hiddenFieldKeys, countMax: null };
}

/**
 * Plans a media node's inputs from whatever catalog snapshot is on hand. A
 * missing snapshot yields the model-agnostic plan so the card still renders;
 * the host re-renders once the catalog arrives.
 */
export function planStudioMediaNodeInputs(
  node: Pick<StudioNodeInstance, "kind" | "config">,
  snapshots: { images: ManagedImageModelCatalogSnapshot | null; videos: ManagedVideoModelCatalogSnapshot | null },
): StudioMediaNodeInputPlan | null {
  const kind = resolveStudioMediaNodeKind(node.kind);
  if (!kind) return null;
  const chosen = selectedModelId(node);
  if (kind === "image") {
    const catalog = snapshots.images;
    const id = chosen || catalog?.defaultModelId || "";
    const model = catalog?.models.find(entry => entry.id === id) ?? null;
    return planStudioImageNodeInputs(model, id);
  }
  const model = snapshots.videos?.models.find(entry => entry.id === chosen) ?? null;
  return planStudioVideoNodeInputs(model, chosen);
}

/** A human summary of what a model takes, for picker tags. */
export function describeStudioMediaModelInputs(model: ManagedImageModel | ManagedVideoModel): string[] {
  if ("supportsImageInput" in model) {
    return [
      model.supportsImageInput ? `Image input · up to ${model.maxInputReferences}` : "Text only",
      model.maxImages > 1 ? `Up to ${model.maxImages} per job` : "1 per job",
      ...(model.supportsSeed ? ["Seed"] : []),
    ];
  }
  const roles = model.supportedFrameRoles;
  const frames = roles.length === 0
    ? "Text to video"
    : roles.includes("first_frame") && roles.includes("last_frame") ? "First + last frame" : roles.includes("first_frame") ? "First frame" : "Last frame";
  return [frames, ...(model.supportsAudioToggle || model.defaultGenerateAudio ? ["Audio"] : []), ...(model.supportsSeed ? ["Seed"] : [])];
}
