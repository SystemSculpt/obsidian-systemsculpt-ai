import type { StudioJsonValue, StudioNodeDefinition } from "../types";

const SEEDED_JSON_CONFIG_KEY = "__studio_seed_json";

function hasKey(config: Record<string, StudioJsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

export const jsonNode: StudioNodeDefinition = {
  kind: "studio.json",
  version: "1.0.0",
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "json", type: "json", required: false }],
  outputPorts: [{ id: "json", type: "json" }],
  configDefaults: {},
  configSchema: {
    fields: [],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const inputs = context.inputs as Record<string, StudioJsonValue>;
    const hasInput = hasKey(inputs, "json");
    const config = context.node.config as Record<string, StudioJsonValue>;
    const hasSeed = hasKey(config, SEEDED_JSON_CONFIG_KEY);
    const jsonValue = hasInput
      ? inputs.json
      : hasSeed
        ? config[SEEDED_JSON_CONFIG_KEY]
        : null;
    return {
      outputs: {
        json: jsonValue,
      },
    };
  },
};
