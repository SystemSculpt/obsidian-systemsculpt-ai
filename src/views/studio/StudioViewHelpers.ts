import type { StudioJsonValue, StudioNodeDefinition, StudioNodeInstance } from "../../studio/types";

export function definitionKey(definition: StudioNodeDefinition): string {
  return `${definition.kind}@${definition.version}`;
}

export function prettifyNodeKind(kind: string): string {
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
