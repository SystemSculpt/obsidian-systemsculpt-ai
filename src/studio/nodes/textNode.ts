import type { StudioJsonValue, StudioNodeDefinition } from "../types";
import {
  STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
  STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
} from "../StudioNodeGeometry";
import { getText } from "./shared";

// New text starts empty (tldraw-style): creation drops straight into edit
// mode and the renderer shows a faint "Text" placeholder until typed into.
const DEFAULT_TEXT_VALUE = "";
const DEFAULT_FONT_SIZE = 14;

export const textNode: StudioNodeDefinition = {
  kind: "studio.text",
  version: "1.0.0",
  requiredHostCapabilities: [],
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [],
  outputPorts: [{ id: "text", type: "text" }],
  configDefaults: {
    value: DEFAULT_TEXT_VALUE,
    fontSize: DEFAULT_FONT_SIZE,
  },
  configSchema: {
    fields: [
      {
        key: "value",
        label: "Text",
        type: "textarea",
        required: false,
        placeholder: "Text",
      },
      {
        key: "fontSize",
        label: "Font Size",
        type: "number",
        required: false,
        min: STUDIO_GRAPH_TEXT_NODE_MIN_FONT_SIZE,
        max: STUDIO_GRAPH_TEXT_NODE_MAX_FONT_SIZE,
        integer: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const text = getText(context.node.config.value as StudioJsonValue);
    return {
      outputs: {
        text,
      },
    };
  },
};
