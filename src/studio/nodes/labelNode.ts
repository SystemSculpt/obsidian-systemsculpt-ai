import type { StudioNodeDefinition } from "../types";
import { getText } from "./shared";

const DEFAULT_LABEL_TEXT = "Label";
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 140;

function normalizeSize(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export const labelNode: StudioNodeDefinition = {
  kind: "studio.label",
  version: "1.0.0",
  capabilityClass: "local_cpu",
  cachePolicy: "by_inputs",
  inputPorts: [],
  outputPorts: [],
  configDefaults: {
    value: DEFAULT_LABEL_TEXT,
    fontSize: DEFAULT_FONT_SIZE,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  },
  configSchema: {
    fields: [
      {
        key: "value",
        label: "Label",
        type: "textarea",
        required: false,
        placeholder: "Write a label for this graph section.",
      },
      {
        key: "fontSize",
        label: "Font Size",
        type: "number",
        required: false,
        min: 10,
        max: 48,
        integer: true,
      },
      {
        key: "width",
        label: "Width",
        type: "number",
        required: false,
        min: 140,
        max: 1000,
        integer: true,
      },
      {
        key: "height",
        label: "Height",
        type: "number",
        required: false,
        min: 90,
        max: 800,
        integer: true,
      },
    ],
    allowUnknownKeys: true,
  },
  async execute(context) {
    const value = getText(context.node.config.value as never);
    const fontSize = normalizeSize(context.node.config.fontSize, DEFAULT_FONT_SIZE, 10, 48);
    const width = normalizeSize(context.node.config.width, DEFAULT_WIDTH, 140, 1000);
    const height = normalizeSize(context.node.config.height, DEFAULT_HEIGHT, 90, 800);
    return {
      outputs: {
        value,
        fontSize,
        width,
        height,
      },
    };
  },
};
