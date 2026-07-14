import { Platform } from "obsidian";
import type { StudioNodeDefinition, StudioNodeInstance, StudioProjectV1 } from "./types";

export type StudioNodeHostAvailability = Readonly<{
  available: boolean;
  reason: string | null;
}>;

export type StudioHostUnavailableNode = Readonly<{
  nodeId: string;
  label: string;
  kind: string;
  reason: string;
}>;

const AVAILABLE: StudioNodeHostAvailability = Object.freeze({
  available: true,
  reason: null,
});

const DESKTOP_ONLY: StudioNodeHostAvailability = Object.freeze({
  available: false,
  reason: "This node requires Obsidian Desktop.",
});

/** One host policy shared by the Studio registry, presentation, and runtime. */
export function resolveStudioNodeHostAvailability(
  definition: Pick<StudioNodeDefinition, "hostRequirement">,
): StudioNodeHostAvailability {
  if (definition.hostRequirement !== "desktop" || Platform.isDesktopApp) {
    return AVAILABLE;
  }
  return DESKTOP_ONLY;
}

export function assertStudioNodeHostAvailable(
  definition: Pick<StudioNodeDefinition, "hostRequirement" | "kind">,
): void {
  const availability = resolveStudioNodeHostAvailability(definition);
  if (!availability.available) {
    throw new Error(`${definition.kind}: ${availability.reason}`);
  }
}

export function collectStudioHostUnavailableNodes(
  project: Pick<StudioProjectV1, "graph">,
  resolveDefinition: (node: StudioNodeInstance) => Pick<StudioNodeDefinition, "hostRequirement" | "kind"> | null,
): StudioHostUnavailableNode[] {
  const blocked: StudioHostUnavailableNode[] = [];
  for (const node of project.graph.nodes) {
    const definition = resolveDefinition(node);
    if (!definition) {
      continue;
    }
    const availability = resolveStudioNodeHostAvailability(definition);
    if (availability.available || !availability.reason) {
      continue;
    }
    blocked.push({
      nodeId: node.id,
      label: String(node.title || node.kind).trim() || node.kind,
      kind: definition.kind,
      reason: availability.reason,
    });
  }
  return blocked;
}

export function formatStudioHostUnavailableNodesNotice(
  nodes: readonly Pick<StudioHostUnavailableNode, "label" | "kind">[],
): string {
  const labels = nodes.map((node) => `${node.label} (${node.kind})`);
  return `Desktop-only nodes: ${labels.join(", ")}.`;
}
