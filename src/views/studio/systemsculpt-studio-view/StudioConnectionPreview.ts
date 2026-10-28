import type { StudioJsonValue, StudioNodeInstance, StudioNodeOutputMap } from "../../../studio/types";
import type { ConnectionAutoCreateDescriptor } from "../StudioGraphInteractionTypes";
import { cloneJsonValue, prettifyNodeKind } from "../StudioViewHelpers";

export function resolveConnectionAutoCreateTemplate(sourceType: string): {
  nodeKind: string;
  targetPortId: string;
  label: string;
} | null {
  const normalizedType = String(sourceType || "").trim();
  if (normalizedType === "text") {
    return {
      nodeKind: "studio.text_output",
      targetPortId: "text",
      label: "text output preview",
    };
  }
  if (normalizedType === "json" || normalizedType === "any") {
    return {
      nodeKind: normalizedType === "json" ? "studio.json" : "studio.value",
      targetPortId: normalizedType === "json" ? "json" : "value",
      label: normalizedType === "json" ? "JSON preview" : "value preview",
    };
  }
  if (normalizedType === "number" || normalizedType === "boolean") {
    return {
      nodeKind: "studio.value",
      targetPortId: "value",
      label: "value preview",
    };
  }
  return null;
}

function normalizeSeededTextValue(value: StudioJsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function buildAutoCreatedNodeTitle(nodeKind: string, fromPortId: string): string {
  const baseTitle = prettifyNodeKind(nodeKind);
  const sourcePort = String(fromPortId || "").trim();
  if (!sourcePort) {
    return baseTitle;
  }
  return `${baseTitle} (${sourcePort})`;
}

export function seedAutoCreatedNodeConfig(
  node: StudioNodeInstance,
  nodeKind: string,
  value: StudioJsonValue
): void {
  if (nodeKind === "studio.text_output") {
    node.config.value = normalizeSeededTextValue(value);
    return;
  }
  if (nodeKind === "studio.json") {
    node.config.value = cloneJsonValue(value);
    return;
  }
  if (nodeKind === "studio.value") {
    node.config.__studio_seed_value = cloneJsonValue(value);
  }
}

export function buildSeededPreviewOutputs(
  nodeKind: string,
  value: StudioJsonValue
): StudioNodeOutputMap | null {
  if (nodeKind === "studio.text_output") {
    return {
      text: normalizeSeededTextValue(value),
    };
  }
  if (nodeKind === "studio.json") {
    return {
      json: cloneJsonValue(value),
    };
  }
  if (nodeKind === "studio.value") {
    return {
      value: cloneJsonValue(value),
    };
  }
  return null;
}

export function describeConnectionAutoCreate(sourceType: string): ConnectionAutoCreateDescriptor | null {
  const template = resolveConnectionAutoCreateTemplate(sourceType);
  if (!template) {
    return null;
  }
  return {
    label: template.label,
  };
}

