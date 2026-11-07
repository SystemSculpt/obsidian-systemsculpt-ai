import type SystemSculptPlugin from "../main";
import { getStudioMediaCatalogs } from "./StudioMediaCatalogs";
import {
  isStudioVideoOptionsSource,
  resolveStudioVideoModelOptions,
  STUDIO_VIDEO_GENERATION_NODE_KIND,
  STUDIO_VIDEO_MODEL_CONFIG_KEYS,
} from "./StudioVideoModelOptions";
import { resolveStudioImageModelOptions } from "./StudioImageModelOptions";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeConfigSelectOption, StudioNodeInstance } from "./types";

/** Resolves dynamic image and video options from the server catalogs. */
export function resolveStudioMediaModelOptionsForPlugin(
  plugin: SystemSculptPlugin,
  source: StudioNodeConfigDynamicOptionsSource,
  node: StudioNodeInstance,
): Promise<StudioNodeConfigSelectOption[]> {
  if (node.kind === "studio.image_generation" && source === "image_generation_models") {
    return resolveStudioImageModelOptions(getStudioMediaCatalogs(plugin).images, node);
  }
  if (node.kind !== STUDIO_VIDEO_GENERATION_NODE_KIND || !isStudioVideoOptionsSource(source)) return Promise.resolve([]);
  return resolveStudioVideoModelOptions(getStudioMediaCatalogs(plugin).videos, source, node);
}

/** Whether changing this config key must re-render the card so dependent pickers reload. */
export function isStudioMediaModelConfigKey(kind: string, key: string): boolean {
  return kind === STUDIO_VIDEO_GENERATION_NODE_KIND && STUDIO_VIDEO_MODEL_CONFIG_KEYS.includes(key);
}
