import { resolveDatasetOutputPorts } from "./nodes/datasetNode";
import type { StudioNodeDefinition, StudioNodeInstance } from "./types";

export function resolveNodeDefinitionPorts(
  node: StudioNodeInstance,
  definition: StudioNodeDefinition
): StudioNodeDefinition {
  if (node.kind !== "studio.dataset") {
    return definition;
  }
  return {
    ...definition,
    outputPorts: resolveDatasetOutputPorts(node.config),
  };
}
