const VISUAL_ONLY_NODE_KINDS = new Set<string>(["studio.terminal", "studio.run_collection", "studio.command_center", "studio.button"]);
export type StudioManagedOutputKind = "image" | "video";
const MANAGED_OUTPUT_KIND_BY_NODE_KIND: Readonly<Record<string, StudioManagedOutputKind>> = {
  "studio.image_generation": "image",
  "studio.video_generation": "video",
};
const MANAGED_OUTPUT_PRODUCER_NODE_KINDS = new Set<string>(Object.keys(MANAGED_OUTPUT_KIND_BY_NODE_KIND));

/** Which media a producer node materializes as connected output cards, or null for non-producers. */
export function resolveStudioManagedOutputKind(kind: string): StudioManagedOutputKind | null {
  return MANAGED_OUTPUT_KIND_BY_NODE_KIND[String(kind || "").trim()] || null;
}

export function isStudioVisualOnlyNodeKind(kind: string): boolean {
  return VISUAL_ONLY_NODE_KINDS.has(String(kind || "").trim());
}

export function isStudioManagedOutputProducerKind(kind: string): boolean {
  return MANAGED_OUTPUT_PRODUCER_NODE_KINDS.has(String(kind || "").trim());
}
