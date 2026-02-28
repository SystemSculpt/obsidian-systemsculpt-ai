import type { StudioNodeConfigFieldDefinition } from "../../studio/types";

export function resolveStudioSearchableSelectPlaceholder(
  field: StudioNodeConfigFieldDefinition
): string {
  if (field.required !== true) {
    return "Default";
  }
  const raw = String(field.label || field.key || "option").trim().toLowerCase();
  return raw ? `Select ${raw}` : "Select option";
}
