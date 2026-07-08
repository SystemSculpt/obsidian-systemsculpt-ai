import type { StudioNodeDefinition } from "../types";
import {
  resolveStudioTextNodeFontSize,
  resolveStudioTextNodeHeight,
  resolveStudioTextNodeWidth,
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
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [],
  outputPorts: [],
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
    const value = getText(context.node.config.value as never);
    // Width/height are canvas geometry (node.size), not config; the resolvers
    // read size first with the migration-era legacy fallback and defaults.
    return {
      outputs: {
        value,
        fontSize: resolveStudioTextNodeFontSize(context.node),
        width: resolveStudioTextNodeWidth(context.node),
        height: resolveStudioTextNodeHeight(context.node),
      },
    };
  },
};
