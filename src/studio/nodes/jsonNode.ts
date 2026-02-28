import type { StudioJsonValue, StudioNodeDefinition } from "../types";

const JSON_VALUE_CONFIG_KEY = "value";

function hasKey(config: Record<string, StudioJsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function readConfiguredJsonValue(config: Record<string, StudioJsonValue>): StudioJsonValue {
  if (!hasKey(config, JSON_VALUE_CONFIG_KEY)) {
    return {};
  }
  const configured = config[JSON_VALUE_CONFIG_KEY];
  return typeof configured === "undefined" ? {} : configured;
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
    const jsonValue = hasInput ? inputs.json : readConfiguredJsonValue(config);
    return {
      outputs: {
        json: jsonValue,
      },
    };
  },
};
