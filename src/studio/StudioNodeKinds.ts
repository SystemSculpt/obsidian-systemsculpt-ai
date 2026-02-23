import type { StudioNodeInstance } from "./types";

const VISUAL_ONLY_NODE_KINDS = new Set<string>(["studio.label"]);
const MANAGED_OUTPUT_PRODUCER_NODE_KINDS = new Set<string>([
  "studio.image_generation",
]);

export function isStudioVisualOnlyNodeKind(kind: string): boolean {
  return VISUAL_ONLY_NODE_KINDS.has(String(kind || "").trim());
}

export function isStudioManagedOutputProducerKind(kind: string): boolean {
  return MANAGED_OUTPUT_PRODUCER_NODE_KINDS.has(String(kind || "").trim());
}

export function isStudioVisualOnlyNode(node: Pick<StudioNodeInstance, "kind">): boolean {
  return isStudioVisualOnlyNodeKind(node.kind);
}
