import type { StudioNodeInstance } from "./types";

// Persisted ownership protocol: keep these values stable across document versions.
export const MANAGED_MEDIA_OWNER_KEY = "__studio_managed_by";
export const MANAGED_MEDIA_OWNER = "studio.image_generation_output.v1";
export const MANAGED_MEDIA_SOURCE_NODE_ID_KEY = "__studio_source_node_id";
export const MANAGED_MEDIA_SLOT_INDEX_KEY = "__studio_source_output_index";
export const MANAGED_OUTPUT_PENDING_KEY = "__studio_pending";
export const MANAGED_OUTPUT_PENDING_RUN_ID_KEY = "__studio_pending_run_id";
export const MANAGED_TEXT_OWNER_KEY = "__studio_managed_by";
export const MANAGED_TEXT_OWNER = "studio.text_generation_output.v1";
export const MANAGED_TEXT_SOURCE_NODE_ID_KEY = "__studio_source_node_id";

export function isManagedMediaNode(node: StudioNodeInstance): boolean {
  return node.kind === "studio.media_ingest" && !!node.config &&
    typeof node.config === "object" && !Array.isArray(node.config) &&
    String(node.config[MANAGED_MEDIA_OWNER_KEY] || "").trim() === MANAGED_MEDIA_OWNER;
}

/** Invalid or absent slots have no identity; execution may fall back to the first input. */
export function readManagedMediaSlotIndex(config: StudioNodeInstance["config"]): number | null {
  const value = Number(config[MANAGED_MEDIA_SLOT_INDEX_KEY]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
