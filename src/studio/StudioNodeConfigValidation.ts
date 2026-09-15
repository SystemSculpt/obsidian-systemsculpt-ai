import { readStudioCommandExecution } from './StudioCommandExecution';
import { readStudioCommandActions } from "./nodes/commandCenterNode";
import { readStudioScript } from "./StudioScript";
import type {
  StudioJsonValue,
  StudioNodeConfigFieldDefinition,
  StudioNodeConfigValidationResult,
  StudioNodeDefinition,
} from "./types";
import { isRecord } from "./utils";
import { isStudioDynamicPortId, isStudioPortDataType, isStudioProcessFixedOutputPortId, STUDIO_DYNAMIC_PORT_MAX_COUNT } from "./types";

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
  return config;
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

export function isNodeConfigFieldVisible(
  field: StudioNodeConfigFieldDefinition,
  mergedConfig: Record<string, StudioJsonValue>
): boolean {
  const rule = field.visibleWhen;
  if (!rule) {
    return true;
  }
  const actual = mergedConfig[rule.key];
  const expectedValues = Array.isArray(rule.equals) ? rule.equals : [rule.equals];
  return expectedValues.some((expected) => actual === expected);
}

export function mergeNodeConfigWithDefaults(
  definition: StudioNodeDefinition,
  config: Record<string, StudioJsonValue> | undefined | null
): Record<string, StudioJsonValue> {
  const defaults = cloneJsonValue(definition.configDefaults || {});
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
    if (!isNodeConfigFieldVisible(field, merged)) {
      continue;
    }
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
        if (field.optionsSource === "image_aspect_ratios" && value !== "" && !/^(auto|match_input_image|[0-9]{1,2}(?:\.[0-9]{1,2})?:[0-9]{1,2}(?:\.[0-9]{1,2})?)$/.test(value)) {
          errors.push({ fieldKey: field.key, message: "Must be an aspect ratio or the model default." });
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
      case 'port_list': {
        if (!Array.isArray(value)) {
          errors.push({ fieldKey: field.key, message: 'Must be a list of port definitions.' })
          break
        }
        if (value.length > STUDIO_DYNAMIC_PORT_MAX_COUNT) {
          errors.push({
            fieldKey: field.key,
            message: `Must have at most ${STUDIO_DYNAMIC_PORT_MAX_COUNT} ports.`
          })
          break
        }
        const seen = new Set<string>()
        for (const entry of value) {
          if (!isRecord(entry)) {
            errors.push({ fieldKey: field.key, message: 'Every port must be an object.' })
            break
          }
          const id = typeof entry.id === 'string' ? entry.id.trim() : ''
          const type = entry.type
          if (!isStudioDynamicPortId(id)) {
            errors.push({
              fieldKey: field.key,
              message: 'Port names must start with a letter and use only letters, numbers, _ or -.'
            })
            break
          }
          if (
            seen.has(id) ||
            (field.portDirection === 'output' && isStudioProcessFixedOutputPortId(id))
          ) {
            errors.push({
              fieldKey: field.key,
              message: `Port name "${id}" is reserved or repeated.`
            })
            break
          }
          seen.add(id)
          if (!isStudioPortDataType(type)) {
            errors.push({ fieldKey: field.key, message: `Port "${id}" has an invalid type.` })
            break
          }
          if (typeof entry.required !== 'undefined' && typeof entry.required !== 'boolean') {
            errors.push({
              fieldKey: field.key,
              message: `Port "${id}" has an invalid required flag.`
            })
            break
          }
        }
        break
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
      case "note_selector": {
        if (!isRecord(value)) {
          errors.push({
            fieldKey: field.key,
            message: "Must be a note selector object.",
          });
          break;
        }
        const nsValue = value as Record<string, StudioJsonValue>;
        const nsItems = nsValue.items;
        if (!Array.isArray(nsItems)) {
          errors.push({
            fieldKey: field.key,
            message: "Must have an 'items' array.",
          });
          break;
        }
        if (field.required === true && nsItems.length === 0) {
          errors.push({
            fieldKey: field.key,
            message: "At least one note entry is required.",
          });
          break;
        }
        for (let i = 0; i < nsItems.length; i++) {
          const item = nsItems[i];
          if (!isRecord(item)) {
            errors.push({
              fieldKey: field.key,
              message: `Item ${i} must be an object.`,
            });
            continue;
          }
          const itemObj = item as Record<string, StudioJsonValue>;
          if (typeof itemObj.path !== "string" || itemObj.path.trim() === "") {
            errors.push({
              fieldKey: field.key,
              message: `Item ${i} must have a non-empty path.`,
            });
          }
          if (
            Object.prototype.hasOwnProperty.call(itemObj, "enabled") &&
            typeof itemObj.enabled !== "boolean"
          ) {
            errors.push({
              fieldKey: field.key,
              message: `Item ${i} enabled must be true or false.`,
            });
          }
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

  if (definition.kind === "studio.command_center") {
    try { readStudioCommandExecution(merged.execution); } catch (error) { errors.push({ fieldKey: "execution", message: error instanceof Error ? error.message : "Invalid execution settings." }); }
    try { readStudioCommandActions(merged.actions); } catch (error) { errors.push({ fieldKey: "actions", message: error instanceof Error ? error.message : "Invalid commands." }); }
  }
  if (definition.kind === "studio.script") {
    try { readStudioScript(merged.source); } catch (error) { errors.push({ fieldKey: "source", message: error instanceof Error ? error.message : "Invalid script." }); }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
