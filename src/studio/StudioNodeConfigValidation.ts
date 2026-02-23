import type {
  StudioJsonValue,
  StudioNodeConfigValidationResult,
  StudioNodeDefinition,
} from "./types";
import { isRecord } from "./utils";

function cloneJsonValue<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function normalizeConfigObject(
  config: Record<string, StudioJsonValue> | undefined | null
): Record<string, StudioJsonValue> {
  if (!isRecord(config)) {
    return {};
  }
  return config as Record<string, StudioJsonValue>;
}

function toFiniteNumber(value: StudioJsonValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

export function mergeNodeConfigWithDefaults(
  definition: StudioNodeDefinition,
  config: Record<string, StudioJsonValue> | undefined | null
): Record<string, StudioJsonValue> {
  const defaults = cloneJsonValue(definition.configDefaults || {}) as Record<string, StudioJsonValue>;
  const normalized = normalizeConfigObject(config);
  return {
    ...defaults,
    ...normalized,
  };
}

export function getUnknownNodeConfigKeys(
  definition: StudioNodeDefinition,
  config: Record<string, StudioJsonValue> | undefined | null
): Record<string, StudioJsonValue> {
  const normalized = normalizeConfigObject(config);
  const known = new Set(definition.configSchema.fields.map((field) => field.key));
  const unknown: Record<string, StudioJsonValue> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (!known.has(key)) {
      unknown[key] = value;
    }
  }
  return unknown;
}

export function rebuildConfigWithUnknownKeys(
  definition: StudioNodeDefinition,
  config: Record<string, StudioJsonValue> | undefined | null,
  unknownOverrides: Record<string, StudioJsonValue>
): Record<string, StudioJsonValue> {
  const normalized = normalizeConfigObject(config);
  const known = new Set(definition.configSchema.fields.map((field) => field.key));
  const next: Record<string, StudioJsonValue> = {};
  for (const [key, value] of Object.entries(normalized)) {
    if (known.has(key)) {
      next[key] = value;
    }
  }
  for (const [key, value] of Object.entries(unknownOverrides || {})) {
    if (key.trim().length > 0 && !known.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

export function validateNodeConfig(
  definition: StudioNodeDefinition,
  config: Record<string, StudioJsonValue> | undefined | null
): StudioNodeConfigValidationResult {
  const merged = mergeNodeConfigWithDefaults(definition, config);
  const errors: StudioNodeConfigValidationResult["errors"] = [];

  for (const field of definition.configSchema.fields) {
    const value = merged[field.key];
    const hasValue = typeof value !== "undefined" && value !== null;

    if (field.required === true) {
      if (!hasValue) {
        errors.push({
          fieldKey: field.key,
          message: "This field is required.",
        });
        continue;
      }
      if (
        (field.type === "text" ||
          field.type === "textarea" ||
          field.type === "select" ||
          field.type === "file_path" ||
          field.type === "directory_path" ||
          field.type === "media_path") &&
        String(value).trim() === ""
      ) {
        errors.push({
          fieldKey: field.key,
          message: "This field is required.",
        });
        continue;
      }
    }

    if (!hasValue) {
      continue;
    }

    switch (field.type) {
      case "text":
      case "textarea":
      case "select":
      case "file_path":
      case "directory_path":
      case "media_path": {
        if (typeof value !== "string") {
          errors.push({
            fieldKey: field.key,
            message: "Must be a string value.",
          });
          break;
        }
        if (field.type === "select" && Array.isArray(field.options) && field.options.length > 0) {
          const allowed = new Set(field.options.map((option) => option.value));
          if (!allowed.has(value)) {
            errors.push({
              fieldKey: field.key,
              message: "Must be one of the allowed options.",
            });
          }
        }
        break;
      }
      case "number": {
        const parsed = toFiniteNumber(value);
        if (parsed === null) {
          errors.push({
            fieldKey: field.key,
            message: "Must be a valid number.",
          });
          break;
        }
        if (field.integer === true && !Number.isInteger(parsed)) {
          errors.push({
            fieldKey: field.key,
            message: "Must be an integer.",
          });
          break;
        }
        if (typeof field.min === "number" && parsed < field.min) {
          errors.push({
            fieldKey: field.key,
            message: `Must be at least ${field.min}.`,
          });
          break;
        }
        if (typeof field.max === "number" && parsed > field.max) {
          errors.push({
            fieldKey: field.key,
            message: `Must be at most ${field.max}.`,
          });
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          errors.push({
            fieldKey: field.key,
            message: "Must be true or false.",
          });
        }
        break;
      }
      case "json_object": {
        if (!isRecord(value)) {
          errors.push({
            fieldKey: field.key,
            message: "Must be a JSON object.",
          });
        }
        break;
      }
      case "string_list": {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
          errors.push({
            fieldKey: field.key,
            message: "Must be a list of strings.",
          });
        }
        break;
      }
      default: {
        errors.push({
          fieldKey: field.key,
          message: "Unsupported field type.",
        });
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
