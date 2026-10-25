import type { StudioNodeDefinition } from "../types";

/** Saved image cards retain their definition and connections, but never execute. */
export const retiredImageGenerationNode: StudioNodeDefinition = {
  kind: "studio.image_generation",
  version: "1.0.0",
  hiddenFromInsertMenu: true,
  requiredHostCapabilities: [],
  capabilityClass: "local_cpu",
  cachePolicy: "never",
  inputPorts: [
    { id: "prompt", type: "text", required: false },
    { id: "images", type: "any", required: false },
  ],
  outputPorts: [{ id: "images", type: "json" }],
  configDefaults: {},
  configSchema: { fields: [], allowUnknownKeys: true },
  async execute() {
    return { outputs: {} };
  },
};
