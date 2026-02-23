import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { getText } from "./shared";

export const inputNode: StudioNodeDefinition = {
  kind: "studio.input",
  version: "1.0.0",
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [],
  outputPorts: [
    { id: "out", type: "any" },
    { id: "text", type: "text" },
  ],
  configDefaults: {
    value: "",
  },
  configSchema: {
    fields: [
      {
        key: "value",
        label: "Value",
        type: "textarea",
        required: false,
        placeholder: "Enter input text for downstream nodes.",
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const rawValue = context.node.config.value as StudioJsonValue;
    return {
      outputs: {
        out: rawValue ?? "",
        text: getText(rawValue),
      },
    };
  },
};
