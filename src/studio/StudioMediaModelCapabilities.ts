import type { ManagedVideoModel, ManagedVideoModelCatalogSnapshot } from "../services/videos/ManagedVideoModelCatalog";
import type { StudioNodeInstance } from "./types";

export type StudioMediaModelKind = "video";

/**
 * What the selected model can take, projected onto one node: ports it does
 * not accept are hidden, config fields it does not offer are hidden, and the
 * remaining ports carry the model's input requirements as help text.
 */
export type StudioMediaNodeInputPlan = Readonly<{
  kind: StudioMediaModelKind;
  modelId: string;
  model: ManagedVideoModel | null;
  hiddenInputPortIds: readonly string[];
  inputPortNotes: Readonly<Record<string, string>>;
  hiddenFieldKeys: readonly string[];
}>;

export function resolveStudioMediaNodeKind(kind: string): StudioMediaModelKind | null {
  const normalized = String(kind || "").trim();
  if (normalized === "studio.video_generation") return "video";
  return null;
}

function selectedModelId(node: Pick<StudioNodeInstance, "config">): string {
  const value = node.config?.model;
  return typeof value === "string" ? value.trim() : "";
}

export function planStudioVideoNodeInputs(model: ManagedVideoModel | null, modelId = model?.id ?? ""): StudioMediaNodeInputPlan {
  if (!model) {
    return { kind: "video", modelId, model: null, hiddenInputPortIds: [], inputPortNotes: {}, hiddenFieldKeys: [] };
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
  return { kind: "video", modelId, model, hiddenInputPortIds, inputPortNotes, hiddenFieldKeys };
}

/**
 * Plans a video node's inputs from whatever catalog snapshot is on hand. A
 * missing snapshot yields the model-agnostic plan so the card still renders;
 * the host re-renders once the catalog arrives.
 */
export function planStudioMediaNodeInputs(
  node: Pick<StudioNodeInstance, "kind" | "config">,
  snapshots: { videos: ManagedVideoModelCatalogSnapshot | null },
): StudioMediaNodeInputPlan | null {
  if (!resolveStudioMediaNodeKind(node.kind)) return null;
  const chosen = selectedModelId(node);
  const model = snapshots.videos?.models.find(entry => entry.id === chosen) ?? null;
  return planStudioVideoNodeInputs(model, chosen);
}

/** A human summary of what a model takes, for picker tags. */
export function describeStudioMediaModelInputs(model: ManagedVideoModel): string[] {
  const roles = model.supportedFrameRoles;
  const frames = roles.length === 0
    ? "Text to video"
    : roles.includes("first_frame") && roles.includes("last_frame") ? "First + last frame" : roles.includes("first_frame") ? "First frame" : "Last frame";
  return [frames, ...(model.supportsAudioToggle || model.defaultGenerateAudio ? ["Audio"] : []), ...(model.supportsSeed ? ["Seed"] : [])];
}
