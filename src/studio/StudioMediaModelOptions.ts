import type SystemSculptPlugin from "../main";
import { getStudioMediaCatalogs } from "./StudioMediaCatalogs";
import {
  isStudioVideoOptionsSource,
  resolveStudioVideoModelOptions,
  STUDIO_VIDEO_GENERATION_NODE_KIND,
  STUDIO_VIDEO_MODEL_CONFIG_KEYS,
} from "./StudioVideoModelOptions";
import type { StudioNodeConfigDynamicOptionsSource, StudioNodeConfigSelectOption, StudioNodeInstance } from "./types";

/** Resolves dynamic video options; retired media controls never load a catalog. */
export function resolveStudioMediaModelOptionsForPlugin(
  plugin: SystemSculptPlugin,
  source: StudioNodeConfigDynamicOptionsSource,
  node: StudioNodeInstance,
): Promise<StudioNodeConfigSelectOption[]> {
  if (node.kind !== STUDIO_VIDEO_GENERATION_NODE_KIND || !isStudioVideoOptionsSource(source)) return Promise.resolve([]);
  return resolveStudioVideoModelOptions(getStudioMediaCatalogs(plugin).videos, source, node);
}

/** Whether changing this config key must re-render the card so dependent pickers reload. */
export function isStudioMediaModelConfigKey(kind: string, key: string): boolean {
  return kind === STUDIO_VIDEO_GENERATION_NODE_KIND && STUDIO_VIDEO_MODEL_CONFIG_KEYS.includes(key);
}
