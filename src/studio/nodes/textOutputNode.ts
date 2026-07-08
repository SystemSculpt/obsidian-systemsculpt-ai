import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import { getText } from "./shared";

export const textOutputNode: StudioNodeDefinition = {
  kind: "studio.text_output",
  version: "1.0.0",
  // Load-bearing dataflow node (managed outputs, edge-drop auto-create) that
  // is no longer offered on the user-facing insert surface; canvas text is
  // covered by studio.text ("Text").
  hiddenFromInsertMenu: true,
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [{ id: "text", type: "text", required: false }],
  outputPorts: [{ id: "text", type: "text" }],
  configDefaults: {
    value: "",
    textDisplayMode: "rendered",
  },
  configSchema: {
    fields: [
      {
        key: "value",
        label: "Text",
        type: "textarea",
        required: false,
        placeholder: "Write or paste text to use in this graph.",
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const configured = getText(context.node.config.value as StudioJsonValue);
    const fallbackInput = getText(context.inputs.text as StudioJsonValue);
    const text = configured.trim().length > 0 ? configured : fallbackInput;
    return {
      outputs: {
        text,
      },
    };
  },
};
