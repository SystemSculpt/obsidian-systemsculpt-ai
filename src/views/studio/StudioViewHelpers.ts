import type { StudioJsonValue, StudioNodeDefinition, StudioNodeInstance } from "../../studio/types";

export function definitionKey(definition: StudioNodeDefinition): string {
  return `${definition.kind}@${definition.version}`;
}

const NODE_DESCRIPTION_BY_KIND: Record<string, string> = {
  "studio.input": "Injects starter text or JSON into your graph.",
  "studio.json": "Pass-through JSON preview node for inspecting structured values.",
  "studio.value": "Generic value preview node for scalar or unknown output types.",
  "studio.label": "Adds a visual-only label card for organizing your canvas.",
  "studio.note": "Mirrors a markdown note from your vault with live text editing.",
  "studio.text": "Stores editable text and outputs it for downstream nodes.",
  "studio.text_generation": "Calls a text model and returns generated text output.",
  "studio.image_generation": "Generates one or more images from your prompt.",
  "studio.media_ingest": "Stores media files and outputs a reusable media path.",
  "studio.audio_extract": "Extracts an audio track from a media file.",
  "studio.transcription": "Transcribes audio media into text.",
  "studio.dataset":
    "Runs a custom query through a configurable adapter, caches results, and outputs text plus discovered structured fields.",
  "studio.http_request":
    "Runs authenticated HTTP requests in single or batch mode with configurable retries and request shaping.",
  "studio.cli_command": "Runs a local shell command and captures output.",
};

const NODE_DISPLAY_NAME_BY_KIND: Record<string, string> = {
  "studio.json": "JSON",
  "studio.value": "Value",
  "studio.label": "Label",
  "studio.media_ingest": "Media",
};

export function prettifyNodeKind(kind: string): string {
  const mapped = NODE_DISPLAY_NAME_BY_KIND[kind];
  if (mapped) {
    return mapped;
  }
  const leaf = kind.split(".").pop() || kind;
  return leaf
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function cloneConfigDefaults(
  definition: StudioNodeDefinition
): Record<string, StudioJsonValue> {
  try {
    return JSON.parse(
      JSON.stringify(definition.configDefaults || {})
    ) as Record<string, StudioJsonValue>;
  } catch {
    return {};
  }
}

export function describeNodeDefinition(definition: StudioNodeDefinition): string {
  const mapped = NODE_DESCRIPTION_BY_KIND[definition.kind];
  if (mapped) {
    return mapped;
  }

  const inputCount = definition.inputPorts.length;
  const outputCount = definition.outputPorts.length;
  const inputLabel = inputCount === 1 ? "1 input" : `${inputCount} inputs`;
  const outputLabel = outputCount === 1 ? "1 output" : `${outputCount} outputs`;
  return `${prettifyNodeKind(definition.kind)} node with ${inputLabel} and ${outputLabel}.`;
}

function valuePreview(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 80 ? `${serialized.slice(0, 77)}...` : serialized;
  } catch {
    return "[complex]";
  }
}

function isInternalConfigKey(key: string): boolean {
  return key.startsWith("__studio_");
}

export function formatNodeConfigPreview(node: Pick<StudioNodeInstance, "config">): string {
  const config = node.config || {};
  const keys = Object.keys(config).filter((key) => !isInternalConfigKey(key));
  if (keys.length === 0) {
    return "No config";
  }
  const preview = keys
    .slice(0, 3)
    .map((key) => `${key}: ${valuePreview(config[key])}`);
  const suffix = keys.length > 3 ? " ..." : "";
  return `${preview.join(" | ")}${suffix}`;
}
