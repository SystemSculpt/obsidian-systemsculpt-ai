import type { StudioJsonValue, StudioNodeDefinition } from "../types";

const SEEDED_VALUE_CONFIG_KEY = "__studio_seed_value";

function hasKey(record: Record<string, StudioJsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export const valueNode: StudioNodeDefinition = {
  kind: "studio.value",
  version: "1.0.0",
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "value", type: "any", required: false }],
  outputPorts: [{ id: "value", type: "any" }],
  configDefaults: {},
  configSchema: {
    fields: [],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const inputs = context.inputs as Record<string, StudioJsonValue>;
    const hasInput = hasKey(inputs, "value");
    const config = context.node.config as Record<string, StudioJsonValue>;
    const hasSeed = hasKey(config, SEEDED_VALUE_CONFIG_KEY);
    const value = hasInput
      ? inputs.value
      : hasSeed
        ? config[SEEDED_VALUE_CONFIG_KEY]
        : null;
    return {
      outputs: {
        value,
      },
    };
  },
};
