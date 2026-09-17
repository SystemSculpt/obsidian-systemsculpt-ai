import { runCollectionPorts } from "./nodes/runCollectionNode";
import { readStudioScript } from "./StudioScript";
import { resolveStudioProcessInputPorts, resolveStudioProcessOutputPorts } from "./nodes/processNode";
import { resolveDatasetOutputPorts } from "./nodes/datasetNode";
import type { StudioNodeDefinition, StudioNodeInstance } from "./types";

export function resolveNodeDefinitionPorts(
  node: StudioNodeInstance,
  definition: StudioNodeDefinition
): StudioNodeDefinition {
  if (node.kind === "studio.run_collection") return { ...definition, inputPorts: runCollectionPorts(node.config.sources) };
  if (node.kind === "studio.script") {
    try {
      const { processConfig } = readStudioScript(node.config.source);
      return { ...definition, inputPorts: resolveStudioProcessInputPorts(processConfig), outputPorts: resolveStudioProcessOutputPorts(processConfig) };
    } catch { return definition; }
  }
  if (node.kind === "studio.process") {
    return { ...definition, inputPorts: resolveStudioProcessInputPorts(node.config), outputPorts: resolveStudioProcessOutputPorts(node.config) };
  }
  if (node.kind !== "studio.dataset") {
    return definition;
  }
  return {
    ...definition,
    outputPorts: resolveDatasetOutputPorts(node.config),
  };
}
