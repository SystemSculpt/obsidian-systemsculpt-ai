import type SystemSculptPlugin from "../main";
import { resetStudioImageModelOptions, resolveStudioImageModelOptionsForPlugin } from "./StudioImageModelOptions";
import { getStudioMediaCatalogs } from "./StudioMediaCatalogs";
import {
  isStudioVideoOptionsSource,
  resetStudioVideoModelOptions,
  resolveStudioVideoModelOptions,
  STUDIO_VIDEO_GENERATION_NODE_KIND,
  STUDIO_VIDEO_MODEL_CONFIG_KEYS,
} from "./StudioVideoModelOptions";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeConfigSelectOption, StudioNodeInstance } from "./types";

const IMAGE_MODEL_CONFIG_KEYS: readonly string[] = ["model", "count", "aspectRatio", "imageSize", "quality"];

/** Routes a dynamic select source to the image or video catalog resolver. */
export function resolveStudioMediaModelOptionsForPlugin(
  plugin: SystemSculptPlugin,
  source: StudioNodeConfigDynamicOptionsSource,
  node: StudioNodeInstance,
): Promise<StudioNodeConfigSelectOption[]> {
  if (!isStudioVideoOptionsSource(source)) return resolveStudioImageModelOptionsForPlugin(plugin, source, node);
  return resolveStudioVideoModelOptions(getStudioMediaCatalogs(plugin).videos, source, node);
}

export function resetStudioMediaModelOptions(node: StudioNodeInstance, changedKey: string): void {
  resetStudioImageModelOptions(node, changedKey);
  resetStudioVideoModelOptions(node, changedKey);
}

/** Whether changing this config key must re-render the card so dependent pickers reload. */
export function isStudioMediaModelConfigKey(kind: string, key: string): boolean {
  if (kind === "studio.image_generation") return IMAGE_MODEL_CONFIG_KEYS.includes(key);
  if (kind === STUDIO_VIDEO_GENERATION_NODE_KIND) return STUDIO_VIDEO_MODEL_CONFIG_KEYS.includes(key);
  return false;
}
