import type {
  StudioJsonValue,
  StudioNodeConfigDynamicOptionsSource,
  StudioNodeConfigFieldDefinition,
  StudioNodeConfigSelectOption,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import {
  isNodeConfigFieldVisible,
  mergeNodeConfigWithDefaults,
} from "../../../studio/StudioNodeConfigValidation";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import { browseForNodeConfigPath } from "../StudioPathFieldPicker";
import { renderStudioSearchableDropdown } from "../StudioSearchableDropdown";

type RenderStudioNodeInlineEditorOptions = {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  definition: StudioNodeDefinition;
  inboundEdges?: Array<{
    fromNodeId: string;
    fromPortId: string;
    toPortId: string;
  }>;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodePresentationMutated?: (node: StudioNodeInstance) => void;
  getJsonEditorPreferredMode?: () => StudioJsonEditorMode;
  onJsonEditorPreferredModeChange?: (mode: StudioJsonEditorMode) => void;
  renderMarkdownPreview?: (
    node: StudioNodeInstance,
    markdown: string,
    containerEl: HTMLElement
  ) => Promise<void> | void;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
};

type StudioTextDisplayMode = "raw" | "rendered";
type StudioJsonEditorMode = "composer" | "raw";
type StudioJsonComposerValueType = "text" | "number" | "boolean" | "null" | "json";
type StudioJsonComposerRow = {
  id: string;
  key: string;
  value: string;
  valueType: StudioJsonComposerValueType;
  useTextarea: boolean;
};

const INLINE_EDITOR_NODE_KINDS = new Set<string>([
  "studio.input",
  "studio.json",
  "studio.value",
  "studio.label",
  "studio.cli_command",
  "studio.dataset",
  "studio.http_request",
  "studio.image_generation",
  "studio.media_ingest",
  "studio.audio_extract",
  "studio.note",
  "studio.text",
  "studio.text_generation",
  "studio.transcription",
]);

const OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS = new Set<string>([
  "studio.image_generation",
  "studio.json",
  "studio.value",
  "studio.media_ingest",
  "studio.dataset",
  "studio.note",
  "studio.text",
  "studio.text_generation",
  "studio.transcription",
]);

const TEXT_DISPLAY_MODE_CONFIG_KEY = "textDisplayMode";
const FORCE_INLINE_TEXT_RENDERED_MODE = true;
const JSON_VALUE_CONFIG_KEY = "value";
const HTTP_INPUT_BINDING_LABELS: Record<string, string> = {
  url: "URL",
  headers: "Headers",
  query: "Query Params",
  path_params: "Path Params",
  bearer_token: "Bearer Token",
  body_json: "Body JSON",
  body_text: "Body Text",
};
const JSON_COMPOSER_TYPE_OPTIONS: Array<{ value: StudioJsonComposerValueType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Bool" },
  { value: "null", label: "Null" },
  { value: "json", label: "JSON" },
];

function normalizeNodeKind(kind: string): string {
  return String(kind || "").trim();
}

function readConfigString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function readConfigNumber(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return numeric;
}

function readEditableNodeText(node: StudioNodeInstance, nodeRunState: StudioNodeRunDisplayState): string {
  const configuredValue = readConfigString(node.config.value);
  if (configuredValue.trim().length > 0) {
    return configuredValue;
  }
  const outputText = typeof nodeRunState.outputs?.text === "string" ? nodeRunState.outputs.text : "";
  return outputText;
}

function readTextDisplayMode(node: StudioNodeInstance): StudioTextDisplayMode {
  if (FORCE_INLINE_TEXT_RENDERED_MODE) {
    return "rendered";
  }
  const raw = readConfigString(node.config[TEXT_DISPLAY_MODE_CONFIG_KEY]).trim().toLowerCase();
  return raw === "raw" ? "raw" : "rendered";
}

function isInlineTextNodeKind(kind: string): boolean {
  const normalizedKind = normalizeNodeKind(kind);
  return (
    normalizedKind === "studio.note" ||
    normalizedKind === "studio.text" ||
    normalizedKind === "studio.text_generation" ||
    normalizedKind === "studio.transcription"
  );
}

function normalizeFieldLabel(field: StudioNodeConfigFieldDefinition): string {
  const raw = String(field.label || field.key || "").trim();
  return raw.toUpperCase();
}

function fieldKeyToCssSuffix(key: string): string {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveSearchableSelectPlaceholder(field: StudioNodeConfigFieldDefinition): string {
  if (field.required !== true) {
    return "Default";
  }
  const raw = String(field.label || field.key || "option").trim().toLowerCase();
  return raw ? `Select ${raw}` : "Select option";
}

function buildOrderedFieldList(options: {
  definition: StudioNodeDefinition;
  orderedKeys: string[];
}): StudioNodeConfigFieldDefinition[] {
  const { definition, orderedKeys } = options;
  const fields = definition.configSchema.fields || [];
  if (fields.length === 0) {
    return [];
  }

  const byKey = new Map<string, StudioNodeConfigFieldDefinition>();
  for (const field of fields) {
    byKey.set(field.key, field);
  }

  const output: StudioNodeConfigFieldDefinition[] = [];
  const seen = new Set<string>();
  for (const key of orderedKeys) {
    const field = byKey.get(key);
    if (!field) {
      continue;
    }
    output.push(field);
    seen.add(field.key);
  }
  for (const field of fields) {
    if (seen.has(field.key)) {
      continue;
    }
    output.push(field);
  }
  return output;
}

function isInlineConfigFieldFullWidth(field: StudioNodeConfigFieldDefinition): boolean {
  if (field.type === "select" && field.selectPresentation === "button_group") {
    return true;
  }
  if (
    field.type === "textarea" ||
    field.type === "media_path" ||
    field.type === "directory_path" ||
    field.type === "string_list"
  ) {
    return true;
  }
  return false;
}

function renderDatasetOutputPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
}): void {
  const { nodeEl, node, nodeRunState } = options;
  const outputText = typeof nodeRunState.outputs?.text === "string" ? nodeRunState.outputs.text : "";
  const outputWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-inline-output-preview" });
  outputWrapEl.createDiv({
    cls: "ss-studio-node-inline-output-preview-label",
    text: "LATEST RESULT",
  });
  const outputEditorEl = outputWrapEl.createEl("textarea", {
    cls: "ss-studio-node-inline-output-preview-text",
    attr: {
      "aria-label": `${node.title || "Dataset"} latest result`,
      readonly: "readonly",
    },
  });
  outputEditorEl.readOnly = true;
  outputEditorEl.value = outputText.trim()
    ? outputText
    : "Run this dataset node to preview the latest dataset result.";
}

function formatJsonPreview(value: unknown): string {
  if (typeof value === "undefined") {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

let jsonComposerRowIdCounter = 0;

function nextJsonComposerRowId(): string {
  jsonComposerRowIdCounter += 1;
  return `json_row_${jsonComposerRowIdCounter}`;
}

function isJsonObjectValue(
  value: StudioJsonValue | undefined
): value is Record<string, StudioJsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonNodeConfigValue(node: StudioNodeInstance): StudioJsonValue {
  const config = node.config as Record<string, StudioJsonValue>;
  if (!Object.prototype.hasOwnProperty.call(config, JSON_VALUE_CONFIG_KEY)) {
    return {};
  }
  const value = config[JSON_VALUE_CONFIG_KEY];
  return typeof value === "undefined" ? {} : value;
}

function writeJsonNodeConfigValue(node: StudioNodeInstance, value: StudioJsonValue): void {
  node.config[JSON_VALUE_CONFIG_KEY] = value;
}

function normalizeJsonEditorMode(raw: unknown): StudioJsonEditorMode {
  return String(raw || "").trim().toLowerCase() === "raw" ? "raw" : "composer";
}

function inferComposerValueType(value: StudioJsonValue): StudioJsonComposerValueType {
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return "json";
  }
  return "text";
}

function formatComposerRowValue(value: StudioJsonValue): {
  value: string;
  valueType: StudioJsonComposerValueType;
  useTextarea: boolean;
} {
  const valueType = inferComposerValueType(value);
  if (valueType === "text") {
    const textValue = typeof value === "string" ? value : String(value ?? "");
    return {
      value: textValue,
      valueType,
      useTextarea: textValue.includes("\n"),
    };
  }
  if (valueType === "number" || valueType === "boolean") {
    return {
      value: String(value),
      valueType,
      useTextarea: false,
    };
  }
  if (valueType === "null") {
    return {
      value: "",
      valueType,
      useTextarea: false,
    };
  }
  const jsonValue = formatJsonPreview(value);
  return {
    value: jsonValue,
    valueType,
    useTextarea: jsonValue.includes("\n"),
  };
}

function parseBooleanInput(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "n") {
    return false;
  }
  return null;
}

function parseComposerRowValue(row: StudioJsonComposerRow): {
  value: StudioJsonValue;
  error: string | null;
} {
  const raw = row.value;
  const trimmed = raw.trim();
  if (row.valueType === "null") {
    return {
      value: null,
      error: null,
    };
  }
  if (row.valueType === "text") {
    return {
      value: raw,
      error: null,
    };
  }
  if (row.valueType === "number") {
    if (!trimmed) {
      return {
        value: raw,
        error: "Expected a number value.",
      };
    }
    const parsedNumber = Number(trimmed);
    if (!Number.isFinite(parsedNumber)) {
      return {
        value: raw,
        error: "Expected a valid number value.",
      };
    }
    return {
      value: parsedNumber,
      error: null,
    };
  }
  if (row.valueType === "boolean") {
    const parsedBoolean = parseBooleanInput(raw);
    if (parsedBoolean === null) {
      return {
        value: raw,
        error: 'Expected a boolean: "true" or "false".',
      };
    }
    return {
      value: parsedBoolean,
      error: null,
    };
  }

  if (!trimmed) {
    return {
      value: raw,
      error: "Expected JSON object/array text.",
    };
  }
  try {
    return {
      value: JSON.parse(trimmed) as StudioJsonValue,
      error: null,
    };
  } catch {
    return {
      value: raw,
      error: "Invalid JSON value.",
    };
  }
}

function parseRawJsonEditorValue(raw: string): { value: StudioJsonValue | null; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      value: {},
      error: null,
    };
  }
  try {
    const parsed = JSON.parse(trimmed) as StudioJsonValue;
    return {
      value: parsed,
      error: null,
    };
  } catch (error) {
    return {
      value: null,
      error: error instanceof Error ? error.message : "Invalid JSON value.",
    };
  }
}

function buildComposerRowsFromJsonObject(
  value: Record<string, StudioJsonValue>
): StudioJsonComposerRow[] {
  return Object.entries(value).map(([key, rawValue]) => {
    const formatted = formatComposerRowValue(rawValue);
    return {
      id: nextJsonComposerRowId(),
      key,
      value: formatted.value,
      valueType: formatted.valueType,
      useTextarea: formatted.useTextarea,
    };
  });
}

function collectComposerRowsValue(rows: StudioJsonComposerRow[]): Record<string, StudioJsonValue> {
  const out: Record<string, StudioJsonValue> = {};
  for (const row of rows) {
    const key = String(row.key || "").trim();
    if (!key) {
      continue;
    }
    out[key] = parseComposerRowValue(row).value;
  }
  return out;
}

function collectDuplicateComposerKeys(rows: StudioJsonComposerRow[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const row of rows) {
    const key = String(row.key || "").trim();
    if (!key) {
      continue;
    }
    if (seen.has(key)) {
      duplicate.add(key);
      continue;
    }
    seen.add(key);
  }
  return Array.from(duplicate.values()).sort((a, b) => a.localeCompare(b));
}

function renderJsonOutputPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  configuredValue: StudioJsonValue;
}): void {
  const { nodeEl, node, nodeRunState, configuredValue } = options;
  const outputs = nodeRunState.outputs as Record<string, unknown> | null;
  const outputValue = outputs && Object.prototype.hasOwnProperty.call(outputs, "json")
    ? outputs.json
    : configuredValue;
  const previewText = formatJsonPreview(outputValue);
  const outputWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-json-output" });
  const summary = (() => {
    if (Array.isArray(outputValue)) {
      return `${outputValue.length} items`;
    }
    if (outputValue && typeof outputValue === "object") {
      return `${Object.keys(outputValue as Record<string, unknown>).length} keys`;
    }
    if (typeof outputValue === "string") {
      return outputValue.trim() ? `${outputValue.length} chars` : "empty text";
    }
    if (typeof outputValue === "number" || typeof outputValue === "boolean") {
      return "primitive";
    }
    if (outputValue === null) {
      return "null";
    }
    return "empty";
  })();
  const toggleEl = outputWrapEl.createEl("button", {
    cls: "ss-studio-node-json-output-toggle",
    text: `Latest Output (${summary})`,
  });
  toggleEl.type = "button";
  let expanded = false;
  const outputBodyEl = outputWrapEl.createDiv({ cls: "ss-studio-node-json-output-body is-hidden" });
  const outputEditorEl = outputBodyEl.createEl("textarea", {
    cls: "ss-studio-node-inline-output-preview-text",
    attr: {
      "aria-label": `${node.title || "JSON"} preview`,
      readonly: "readonly",
    },
  });
  const applyOutputExpandedState = (): void => {
    outputBodyEl.classList.toggle("is-hidden", !expanded);
    toggleEl.classList.toggle("is-active", expanded);
    toggleEl.setAttr("aria-expanded", expanded ? "true" : "false");
  };
  toggleEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    expanded = !expanded;
    applyOutputExpandedState();
  });
  outputEditorEl.readOnly = true;
  outputEditorEl.value = previewText.trim()
    ? previewText
    : "Run this JSON node to inspect the latest output.";
  applyOutputExpandedState();
}

function renderJsonNodeEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const {
    nodeEl,
    node,
    nodeRunState,
    interactionLocked,
    onNodeConfigMutated,
    getJsonEditorPreferredMode,
    onJsonEditorPreferredModeChange,
  } = options;

  const editorWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-json-editor" });
  editorWrapEl.createDiv({
    cls: "ss-studio-node-json-editor-label",
    text: "JSON",
  });

  const controlsEl = editorWrapEl.createDiv({ cls: "ss-studio-node-json-editor-controls" });
  const modeToggleEl = controlsEl.createDiv({ cls: "ss-studio-node-text-display-mode" });
  modeToggleEl.createEl("span", {
    cls: "ss-studio-node-text-display-mode-label",
    text: "View",
  });

  const composerButtonEl = modeToggleEl.createEl("button", {
    cls: "ss-studio-node-text-display-mode-button",
    text: "Composer",
    attr: {
      "aria-label": "Show JSON composer rows",
    },
  });
  composerButtonEl.type = "button";
  composerButtonEl.disabled = interactionLocked;

  const rawButtonEl = modeToggleEl.createEl("button", {
    cls: "ss-studio-node-text-display-mode-button",
    text: "Raw",
    attr: {
      "aria-label": "Show raw JSON editor",
    },
  });
  rawButtonEl.type = "button";
  rawButtonEl.disabled = interactionLocked;

  const composerSurfaceEl = editorWrapEl.createDiv({ cls: "ss-studio-node-json-composer-surface" });
  const rawSurfaceEl = editorWrapEl.createDiv({ cls: "ss-studio-node-json-raw-surface is-hidden" });

  const rawEditorEl = rawSurfaceEl.createEl("textarea", {
    cls: "ss-studio-node-json-raw-editor",
    attr: {
      "aria-label": `${node.title || "JSON"} raw JSON editor`,
    },
  });
  rawEditorEl.disabled = interactionLocked;
  const rawErrorEl = rawSurfaceEl.createDiv({
    cls: "ss-studio-node-json-raw-error is-hidden",
  });

  let composerRows: StudioJsonComposerRow[] = [];
  let editorMode = normalizeJsonEditorMode(getJsonEditorPreferredMode?.());

  const createEmptyComposerRow = (): StudioJsonComposerRow => ({
    id: nextJsonComposerRowId(),
    key: "",
    value: "",
    valueType: "text",
    useTextarea: false,
  });

  const syncRawEditorFromConfig = (): void => {
    rawEditorEl.value = formatJsonPreview(readJsonNodeConfigValue(node));
    rawErrorEl.addClass("is-hidden");
    rawErrorEl.setText("");
  };

  const hydrateComposerRowsFromConfig = (): void => {
    const configuredValue = readJsonNodeConfigValue(node);
    if (!isJsonObjectValue(configuredValue)) {
      composerRows = [];
      return;
    }
    composerRows = buildComposerRowsFromJsonObject(configuredValue);
  };

  const renderComposerRows = (focusRowId?: string): void => {
    composerSurfaceEl.empty();
    const configuredValue = readJsonNodeConfigValue(node);
    if (!isJsonObjectValue(configuredValue)) {
      const unsupportedEl = composerSurfaceEl.createDiv({ cls: "ss-studio-node-json-composer-unsupported" });
      unsupportedEl.createDiv({
        cls: "ss-studio-node-json-composer-unsupported-title",
        text: "Composer supports top-level JSON objects only.",
      });
      unsupportedEl.createDiv({
        cls: "ss-studio-node-json-composer-unsupported-body",
        text: "Switch to Raw for arrays/primitives or reset this node to an empty object.",
      });
      const resetButtonEl = unsupportedEl.createEl("button", {
        cls: "ss-studio-node-json-row-button",
        text: "Reset to {}",
      });
      resetButtonEl.type = "button";
      resetButtonEl.disabled = interactionLocked;
      resetButtonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (interactionLocked) {
          return;
        }
        writeJsonNodeConfigValue(node, {});
        onNodeConfigMutated(node);
        hydrateComposerRowsFromConfig();
        renderComposerRows();
      });
      return;
    }

    if (composerRows.length === 0 && Object.keys(configuredValue).length > 0) {
      hydrateComposerRowsFromConfig();
    }

    const rowsEl = composerSurfaceEl.createDiv({ cls: "ss-studio-node-json-composer-rows" });
    const duplicatesEl = composerSurfaceEl.createDiv({
      cls: "ss-studio-node-json-composer-duplicates is-hidden",
    });

    const commitComposerRows = (): void => {
      writeJsonNodeConfigValue(node, collectComposerRowsValue(composerRows));
      onNodeConfigMutated(node);
      syncRawEditorFromConfig();
    };

    const validationHandles = new Map<
      string,
      {
        row: StudioJsonComposerRow;
        rowEl: HTMLElement;
        keyErrorEl: HTMLElement;
        valueErrorEl: HTMLElement;
      }
    >();

    const refreshComposerValidation = (): void => {
      const duplicateKeySet = new Set<string>(collectDuplicateComposerKeys(composerRows));
      if (duplicateKeySet.size === 0) {
        duplicatesEl.addClass("is-hidden");
        duplicatesEl.setText("");
      } else {
        duplicatesEl.removeClass("is-hidden");
        duplicatesEl.setText(
          `Duplicate keys detected (${Array.from(duplicateKeySet.values()).join(", ")}). Last row wins.`
        );
      }

      for (const entry of validationHandles.values()) {
        const key = String(entry.row.key || "").trim();
        let keyError = "";
        if (!key) {
          keyError = "Key is required.";
        } else if (duplicateKeySet.has(key)) {
          keyError = "Duplicate key.";
        }
        entry.keyErrorEl.setText(keyError);
        entry.keyErrorEl.classList.toggle("is-hidden", !keyError);
        entry.rowEl.classList.toggle("is-key-invalid", !!keyError);

        const parsed = parseComposerRowValue(entry.row);
        const valueError = parsed.error || "";
        entry.valueErrorEl.setText(valueError);
        entry.valueErrorEl.classList.toggle("is-hidden", !valueError);
        entry.rowEl.classList.toggle("is-value-invalid", !!valueError);
      }
    };

    if (composerRows.length === 0) {
      rowsEl.createDiv({
        cls: "ss-studio-node-json-composer-empty",
        text: "No fields yet. Add a row to build this object.",
      });
    } else {
      for (const row of composerRows) {
        const rowEl = rowsEl.createDiv({ cls: "ss-studio-node-json-row" });
        const rowHeaderEl = rowEl.createDiv({ cls: "ss-studio-node-json-row-header" });
        const keyEl = rowHeaderEl.createEl("input", {
          cls: "ss-studio-node-json-row-key",
          type: "text",
          attr: {
            placeholder: "key",
            "aria-label": "JSON key",
          },
        });
        keyEl.value = row.key;
        keyEl.disabled = interactionLocked;
        keyEl.addEventListener("input", () => {
          row.key = keyEl.value;
          commitComposerRows();
          refreshComposerValidation();
        });

        const keyControlsEl = rowHeaderEl.createDiv({ cls: "ss-studio-node-json-row-key-controls" });
        const typeEl = keyControlsEl.createEl("select", {
          cls: "ss-studio-node-json-row-type",
          attr: {
            "aria-label": "JSON value type",
          },
        });
        for (const option of JSON_COMPOSER_TYPE_OPTIONS) {
          typeEl.createEl("option", {
            value: option.value,
            text: option.label,
          });
        }
        typeEl.value = row.valueType;
        typeEl.disabled = interactionLocked;
        typeEl.addEventListener("change", () => {
          const nextType = typeEl.value as StudioJsonComposerValueType;
          row.valueType = nextType;
          if (nextType === "null") {
            row.value = "";
            row.useTextarea = false;
          } else if (nextType === "json") {
            row.useTextarea = true;
          } else if (!row.value.includes("\n")) {
            row.useTextarea = false;
          }
          commitComposerRows();
          renderComposerRows(row.id);
        });

        const removeRowEl = keyControlsEl.createEl("button", {
          cls: "ss-studio-node-json-row-button ss-studio-node-json-row-remove",
          text: "×",
          attr: {
            "aria-label": "Remove JSON row",
            title: "Remove row",
          },
        });
        removeRowEl.type = "button";
        removeRowEl.disabled = interactionLocked;
        removeRowEl.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (interactionLocked) {
            return;
          }
          composerRows = composerRows.filter((entry) => entry.id !== row.id);
          commitComposerRows();
          renderComposerRows();
        });

        const valueWrapEl = rowEl.createDiv({ cls: "ss-studio-node-json-row-value-wrap" });
        const valueReadOnly = interactionLocked || row.valueType === "null";
        const valueInputClass = "ss-studio-node-json-row-value";
        if (row.useTextarea) {
          const valueEl = valueWrapEl.createEl("textarea", {
            cls: valueInputClass,
            attr: {
              placeholder: row.valueType === "null" ? "Null type ignores value input" : "value",
              "aria-label": `JSON value for ${row.key || "row"}`,
            },
          });
          valueEl.value = row.value;
          valueEl.disabled = valueReadOnly;
          valueEl.addEventListener("input", () => {
            row.value = valueEl.value;
            commitComposerRows();
            refreshComposerValidation();
          });
        } else {
          const valueEl = valueWrapEl.createEl("input", {
            cls: valueInputClass,
            type: "text",
            attr: {
              placeholder: row.valueType === "null" ? "Null type ignores value input" : "value",
              "aria-label": `JSON value for ${row.key || "row"}`,
            },
          });
          valueEl.value = row.value;
          valueEl.disabled = valueReadOnly;
          valueEl.addEventListener("input", () => {
            row.value = valueEl.value;
            commitComposerRows();
            refreshComposerValidation();
          });
        }

        const toggleValueEditorEl = valueWrapEl.createEl("button", {
          cls: "ss-studio-node-json-row-button ss-studio-node-json-row-mode",
          text: row.useTextarea ? "Line" : "Area",
          attr: {
            "aria-label": row.useTextarea ? "Use single-line input" : "Use multi-line input",
            title: row.useTextarea ? "Use single-line input" : "Use multi-line input",
          },
        });
        toggleValueEditorEl.type = "button";
        toggleValueEditorEl.disabled = interactionLocked || row.valueType === "null";
        toggleValueEditorEl.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (interactionLocked || row.valueType === "null") {
            return;
          }
          row.useTextarea = !row.useTextarea;
          renderComposerRows(row.id);
        });

        const keyErrorEl = rowEl.createDiv({
          cls: "ss-studio-node-json-row-error is-hidden",
        });
        const valueErrorEl = rowEl.createDiv({
          cls: "ss-studio-node-json-row-error is-hidden",
        });
        validationHandles.set(row.id, {
          row,
          rowEl,
          keyErrorEl,
          valueErrorEl,
        });

        if (focusRowId && focusRowId === row.id) {
          window.setTimeout(() => {
            keyEl.focus();
            keyEl.select();
          }, 0);
        }
      }
    }

    const footerEl = composerSurfaceEl.createDiv({ cls: "ss-studio-node-json-composer-footer" });
    const footerActionsEl = footerEl.createDiv({ cls: "ss-studio-node-json-composer-footer-actions" });
    const addRowEl = footerEl.createEl("button", {
      cls: "ss-studio-node-json-row-button",
      text: "Add Field",
      attr: {
        "aria-label": "Add JSON field",
      },
    });
    footerActionsEl.appendChild(addRowEl);
    addRowEl.type = "button";
    addRowEl.disabled = interactionLocked;
    addRowEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (interactionLocked) {
        return;
      }
      const newRow = createEmptyComposerRow();
      composerRows.push(newRow);
      commitComposerRows();
      renderComposerRows(newRow.id);
    });

    const quickEmailPresetEl = footerEl.createEl("button", {
      cls: "ss-studio-node-json-row-button",
      text: "Email Preset",
      attr: {
        "aria-label": "Insert email payload fields",
      },
    });
    footerActionsEl.appendChild(quickEmailPresetEl);
    quickEmailPresetEl.type = "button";
    quickEmailPresetEl.disabled = interactionLocked;
    quickEmailPresetEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (interactionLocked) {
        return;
      }
      const current = readJsonNodeConfigValue(node);
      const baseObject: Record<string, StudioJsonValue> = isJsonObjectValue(current)
        ? { ...(current as Record<string, StudioJsonValue>) }
        : {};
      baseObject.from = typeof baseObject.from === "string" ? baseObject.from : "";
      baseObject.to = typeof baseObject.to === "string" ? baseObject.to : "";
      baseObject.subject = typeof baseObject.subject === "string" ? baseObject.subject : "";
      baseObject.text = typeof baseObject.text === "string" ? baseObject.text : "";
      writeJsonNodeConfigValue(node, baseObject);
      onNodeConfigMutated(node);
      hydrateComposerRowsFromConfig();
      syncRawEditorFromConfig();
      renderComposerRows();
    });

    const hintEl = footerEl.createDiv({ cls: "ss-studio-node-json-composer-hint" });
    hintEl.setText("Choose value type per row. Use Raw for advanced nested JSON editing.");
    refreshComposerValidation();
  };

  const applyDisplayMode = (): void => {
    const showComposer = editorMode === "composer";
    composerSurfaceEl.toggleClass("is-hidden", !showComposer);
    rawSurfaceEl.toggleClass("is-hidden", showComposer);
    composerButtonEl.classList.toggle("is-active", showComposer);
    rawButtonEl.classList.toggle("is-active", !showComposer);
    composerButtonEl.setAttr("aria-pressed", showComposer ? "true" : "false");
    rawButtonEl.setAttr("aria-pressed", showComposer ? "false" : "true");
  };

  const setMode = (nextMode: StudioJsonEditorMode): void => {
    if (editorMode === nextMode) {
      return;
    }
    editorMode = nextMode;
    onJsonEditorPreferredModeChange?.(nextMode);
    if (editorMode === "raw") {
      syncRawEditorFromConfig();
    } else {
      hydrateComposerRowsFromConfig();
      renderComposerRows();
    }
    applyDisplayMode();
  };

  composerButtonEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked) {
      return;
    }
    setMode("composer");
  });

  rawButtonEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked) {
      return;
    }
    setMode("raw");
  });

  rawEditorEl.addEventListener("input", () => {
    const parsed = parseRawJsonEditorValue(rawEditorEl.value);
    if (parsed.error || parsed.value === null) {
      rawErrorEl.removeClass("is-hidden");
      rawErrorEl.setText(parsed.error || "Invalid JSON value.");
      return;
    }
    rawErrorEl.addClass("is-hidden");
    rawErrorEl.setText("");
    writeJsonNodeConfigValue(node, parsed.value);
    onNodeConfigMutated(node);
  });

  hydrateComposerRowsFromConfig();
  renderComposerRows();
  syncRawEditorFromConfig();
  applyDisplayMode();

  renderJsonOutputPreview({
    nodeEl,
    node,
    nodeRunState,
    configuredValue: readJsonNodeConfigValue(node),
  });

  return true;
}

function renderValueOutputPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
}): void {
  const { nodeEl, node, nodeRunState } = options;
  const outputs = nodeRunState.outputs as Record<string, unknown> | null;
  const seededValue = (node.config as Record<string, unknown>).__studio_seed_value;
  const outputValue = outputs && Object.prototype.hasOwnProperty.call(outputs, "value")
    ? outputs.value
    : seededValue;
  const previewText = formatJsonPreview(outputValue);
  const outputWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-inline-output-preview" });
  outputWrapEl.createDiv({
    cls: "ss-studio-node-inline-output-preview-label",
    text: "VALUE PREVIEW",
  });
  const outputEditorEl = outputWrapEl.createEl("textarea", {
    cls: "ss-studio-node-inline-output-preview-text",
    attr: {
      "aria-label": `${node.title || "Value"} preview`,
      readonly: "readonly",
    },
  });
  outputEditorEl.readOnly = true;
  outputEditorEl.value = previewText.trim()
    ? previewText
    : "Connect an output and run this node to inspect the value.";
}

function renderHttpRequestBindingSummary(options: {
  nodeEl: HTMLElement;
  inboundEdges?: Array<{
    fromNodeId: string;
    fromPortId: string;
    toPortId: string;
  }>;
}): void {
  const { nodeEl } = options;
  const inboundEdges = options.inboundEdges || [];
  const normalized = inboundEdges
    .filter((edge) => Object.prototype.hasOwnProperty.call(HTTP_INPUT_BINDING_LABELS, edge.toPortId))
    .map((edge) => ({
      ...edge,
      label: HTTP_INPUT_BINDING_LABELS[edge.toPortId] || edge.toPortId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.fromNodeId.localeCompare(b.fromNodeId));

  const wrapEl = nodeEl.createDiv({ cls: "ss-studio-node-http-bindings" });
  wrapEl.createDiv({
    cls: "ss-studio-node-http-bindings-label",
    text: "CONNECTED INPUTS",
  });

  if (normalized.length === 0) {
    wrapEl.createDiv({
      cls: "ss-studio-node-http-bindings-empty",
      text: "None. Use input ports to bind URL/body/auth/query dynamically.",
    });
    return;
  }

  const listEl = wrapEl.createEl("ul", { cls: "ss-studio-node-http-bindings-list" });
  for (const edge of normalized) {
    const itemEl = listEl.createEl("li", { cls: "ss-studio-node-http-bindings-item" });
    itemEl.createEl("span", {
      cls: "ss-studio-node-http-bindings-target",
      text: edge.label,
    });
    itemEl.createEl("code", {
      cls: "ss-studio-node-http-bindings-source",
      text: `${edge.fromNodeId}.${edge.fromPortId}`,
    });
  }
}

function renderInlineConfigSelectField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
}): void {
  const {
    node,
    field,
    fieldEl,
    interactionLocked,
    onNodeConfigMutated,
    resolveDynamicSelectOptions,
  } = options;

  if (field.selectPresentation === "button_group" && Array.isArray(field.options) && field.options.length > 0) {
    const rowEl = fieldEl.createDiv({ cls: "ss-studio-node-inline-config-select-button-group" });
    const refreshActiveState = (value: string): void => {
      for (const buttonEl of Array.from(rowEl.children)) {
        const element = buttonEl as HTMLElement;
        element.classList.toggle("is-active", element.dataset.optionValue === value);
      }
    };
    const currentValue = readConfigString(node.config[field.key]);
    for (const option of field.options) {
      const buttonEl = rowEl.createEl("button", {
        cls: "ss-studio-node-inline-config-select-button",
        text: option.label || option.value,
      });
      buttonEl.type = "button";
      buttonEl.dataset.optionValue = option.value;
      buttonEl.disabled = interactionLocked;
      buttonEl.addEventListener("click", (event) => {
        event.preventDefault();
        node.config[field.key] = option.value;
        refreshActiveState(option.value);
        onNodeConfigMutated(node);
      });
    }
    refreshActiveState(currentValue);
    return;
  }

  if (field.selectPresentation === "searchable_dropdown") {
    const loadOptions = async (): Promise<StudioNodeConfigSelectOption[]> => {
      if (field.optionsSource && resolveDynamicSelectOptions) {
        const resolved = await resolveDynamicSelectOptions(field.optionsSource, node);
        if (Array.isArray(resolved) && resolved.length > 0) {
          return resolved;
        }
      }
      return Array.isArray(field.options) ? field.options : [];
    };
    renderStudioSearchableDropdown({
      containerEl: fieldEl,
      ariaLabel: `${node.title || node.kind} ${field.label || field.key}`,
      value: readConfigString(node.config[field.key]),
      disabled: interactionLocked,
      placeholder: resolveSearchableSelectPlaceholder(field),
      noResultsText: "No matching options.",
      loadOptions,
      onValueChange: (value) => {
        node.config[field.key] = value;
        onNodeConfigMutated(node);
      },
    });
    return;
  }

  const selectEl = fieldEl.createEl("select", {
    cls: "ss-studio-node-inline-config-select",
    attr: {
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  selectEl.disabled = interactionLocked;

  if (field.required !== true) {
    selectEl.createEl("option", {
      value: "",
      text: "Default",
    });
  }

  const optionValues = new Set<string>();
  for (const option of field.options || []) {
    optionValues.add(option.value);
    selectEl.createEl("option", {
      value: option.value,
      text: option.label || option.value,
    });
  }

  const currentValue = readConfigString(node.config[field.key]);
  if (currentValue && !optionValues.has(currentValue)) {
    selectEl.createEl("option", {
      value: currentValue,
      text: `Custom (${currentValue})`,
    });
  }
  selectEl.value = currentValue;
  selectEl.addEventListener("change", () => {
    node.config[field.key] = selectEl.value;
    onNodeConfigMutated(node);
  });
}

function renderInlineConfigNumberField(options: {
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, definition, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
  const inputEl = fieldEl.createEl("input", {
    cls: "ss-studio-node-inline-config-input",
    type: "number",
    attr: {
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  inputEl.disabled = interactionLocked;

  if (Number.isFinite(field.min)) {
    inputEl.min = String(field.min);
  }
  if (Number.isFinite(field.max)) {
    inputEl.max = String(field.max);
  }
  if (Number.isFinite(field.step)) {
    inputEl.step = String(field.step);
  } else if (field.integer === true) {
    inputEl.step = "1";
  }

  const defaultNumeric = readConfigNumber(definition.configDefaults?.[field.key]);
  const configuredNumeric = readConfigNumber(node.config[field.key]);
  const fallback = defaultNumeric ?? field.min ?? 0;
  const initial = configuredNumeric ?? fallback;
  inputEl.value = String(initial);

  const commit = (): void => {
    const parsed = readConfigNumber(inputEl.value);
    let normalized = parsed ?? fallback;
    if (Number.isFinite(field.min)) {
      normalized = Math.max(field.min as number, normalized);
    }
    if (Number.isFinite(field.max)) {
      normalized = Math.min(field.max as number, normalized);
    }
    if (field.integer === true) {
      normalized = Math.round(normalized);
    }
    node.config[field.key] = normalized;
    inputEl.value = String(normalized);
    onNodeConfigMutated(node);
  };

  inputEl.addEventListener("change", commit);
  inputEl.addEventListener("blur", commit);
  inputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    commit();
  });
}

function renderInlineConfigTextField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
  const inputEl = fieldEl.createEl("input", {
    cls: "ss-studio-node-inline-config-input",
    type: field.inputType === "password" ? "password" : "text",
    attr: {
      placeholder: field.placeholder || "",
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  inputEl.disabled = interactionLocked;
  inputEl.value = readConfigString(node.config[field.key]);
  inputEl.addEventListener("input", () => {
    node.config[field.key] = inputEl.value;
    onNodeConfigMutated(node);
  });
}

function renderInlineConfigTextareaField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
  const textAreaEl = fieldEl.createEl("textarea", {
    cls: "ss-studio-node-inline-config-textarea",
    attr: {
      placeholder: field.placeholder || "",
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  textAreaEl.disabled = interactionLocked;
  textAreaEl.value = readConfigString(node.config[field.key]);
  textAreaEl.addEventListener("input", () => {
    node.config[field.key] = textAreaEl.value;
    onNodeConfigMutated(node);
  });
}

function renderInlineConfigBooleanField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
  const rowEl = fieldEl.createDiv({ cls: "ss-studio-node-inline-config-checkbox-row" });
  const checkboxEl = rowEl.createEl("input", {
    cls: "ss-studio-node-inline-config-checkbox",
    type: "checkbox",
    attr: {
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  checkboxEl.checked = node.config[field.key] === true;
  checkboxEl.disabled = interactionLocked;
  checkboxEl.addEventListener("change", () => {
    node.config[field.key] = checkboxEl.checked;
    onNodeConfigMutated(node);
  });
}

function renderInlineConfigJsonObjectField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
  const textAreaEl = fieldEl.createEl("textarea", {
    cls: "ss-studio-node-inline-config-textarea",
    attr: {
      placeholder: field.placeholder || "{\n  \"key\": \"value\"\n}",
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  textAreaEl.disabled = interactionLocked;
  const initial = node.config[field.key];
  textAreaEl.value =
    initial && typeof initial === "object" && !Array.isArray(initial)
      ? JSON.stringify(initial, null, 2)
      : "{}";

  const commit = (): void => {
    const raw = textAreaEl.value.trim();
    if (!raw) {
      node.config[field.key] = {};
      onNodeConfigMutated(node);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      node.config[field.key] = parsed as any;
      onNodeConfigMutated(node);
    } catch {
      // Keep local text for user correction; validation will fail loudly on run.
    }
  };

  textAreaEl.addEventListener("blur", commit);
}

function renderInlineConfigStringListField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
  const textAreaEl = fieldEl.createEl("textarea", {
    cls: "ss-studio-node-inline-config-textarea",
    attr: {
      placeholder: field.placeholder || "One value per line",
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  textAreaEl.disabled = interactionLocked;
  const current = Array.isArray(node.config[field.key]) ? (node.config[field.key] as unknown[]) : [];
  textAreaEl.value = current.map((entry) => String(entry ?? "")).join("\n");
  textAreaEl.addEventListener("input", () => {
    node.config[field.key] = textAreaEl.value
      .split(/\r?\n/g)
      .map((value) => value.trim())
      .filter((value) => value.length > 0) as any;
    onNodeConfigMutated(node);
  });
}

function appendPathBrowseButtonIcon(
  buttonEl: HTMLElement,
  iconClassName: string
): void {
  const iconEl = buttonEl.createSpan({ cls: iconClassName });
  iconEl.setAttr("aria-hidden", "true");
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const folderPath = document.createElementNS(namespace, "path");
  folderPath.setAttribute("d", "M1.75 4.75a1 1 0 0 1 1-1h3l1.1 1.2h6.4a1 1 0 0 1 1 1v5.3a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z");
  const linePath = document.createElementNS(namespace, "path");
  linePath.setAttribute("d", "M6.25 8.4h4.1m-2.05-2.05V10.5");
  svg.append(folderPath, linePath);
  iconEl.appendChild(svg);
}

function renderInlineConfigPathField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
  const rowEl = fieldEl.createDiv({ cls: "ss-studio-node-inline-config-path-row" });
  const inputEl = rowEl.createEl("input", {
    cls: "ss-studio-node-inline-config-input ss-studio-node-inline-config-path-input",
    type: "text",
    attr: {
      placeholder: field.placeholder || (field.type === "directory_path" ? "Choose folder" : "Choose file"),
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
    },
  });
  inputEl.disabled = interactionLocked;
  inputEl.value = readConfigString(node.config[field.key]);
  inputEl.addEventListener("input", () => {
    node.config[field.key] = inputEl.value;
    onNodeConfigMutated(node);
  });

  const browseButtonEl = rowEl.createEl("button", {
    cls: "ss-studio-node-inline-config-path-button ss-studio-path-browse-button",
    attr: {
      "aria-label":
        field.type === "directory_path" ? "Browse folders" : "Browse files",
      title: field.type === "directory_path" ? "Browse folders" : "Browse files",
    },
  });
  browseButtonEl.type = "button";
  browseButtonEl.disabled = interactionLocked;
  appendPathBrowseButtonIcon(
    browseButtonEl,
    "ss-studio-node-inline-config-path-button-icon ss-studio-path-browse-button-icon"
  );
  browseButtonEl.createSpan({
    cls: "ss-studio-node-inline-config-path-button-label ss-studio-path-browse-button-label",
    text: field.type === "directory_path" ? "Folder" : "Browse",
  });
  browseButtonEl.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked) {
      return;
    }
    const selected = await browseForNodeConfigPath(field);
    if (!selected) {
      return;
    }
    inputEl.value = selected;
    node.config[field.key] = selected;
    onNodeConfigMutated(node);
  });
}

function renderInlineConfigPanel(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  orderedFieldKeys: string[];
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  panelClassName?: string;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
}): boolean {
  const {
    nodeEl,
    node,
    definition,
    orderedFieldKeys,
    interactionLocked,
    onNodeConfigMutated,
    panelClassName,
    resolveDynamicSelectOptions,
  } = options;

  const fields = buildOrderedFieldList({
    definition,
    orderedKeys: orderedFieldKeys,
  });
  if (fields.length === 0) {
    return false;
  }

  const panelEl = nodeEl.createDiv({ cls: "ss-studio-node-inline-config" });
  if (panelClassName) {
    panelEl.addClass(panelClassName);
  }
  const gridEl = panelEl.createDiv({ cls: "ss-studio-node-inline-config-grid" });
  const fieldWrappers = new Map<string, { field: StudioNodeConfigFieldDefinition; wrapper: HTMLElement }>();
  const refreshVisibilityState = (): void => {
    const mergedConfig = mergeNodeConfigWithDefaults(definition, node.config);
    for (const entry of fieldWrappers.values()) {
      const isVisible = isNodeConfigFieldVisible(entry.field, mergedConfig);
      entry.wrapper.classList.toggle("is-hidden", !isVisible);
    }
  };
  const handleNodeConfigMutated = (mutatedNode: StudioNodeInstance): void => {
    refreshVisibilityState();
    onNodeConfigMutated(mutatedNode);
  };
  let renderedAnyField = false;

  for (const field of fields) {
    const fullWidth = isInlineConfigFieldFullWidth(field);
    const fieldKeySuffix = fieldKeyToCssSuffix(field.key);
    const fieldEl = gridEl.createDiv({
      cls: `ss-studio-node-inline-config-field ss-studio-node-inline-config-field--${fieldKeySuffix}${fullWidth ? " is-full" : ""}`,
    });
    fieldWrappers.set(field.key, { field, wrapper: fieldEl });
    fieldEl.createDiv({
      cls: "ss-studio-node-inline-config-label",
      text: normalizeFieldLabel(field),
    });

    if (field.description) {
      fieldEl.createDiv({
        cls: "ss-studio-node-inline-config-help",
        text: field.description,
      });
    }

    if (field.type === "select") {
      renderInlineConfigSelectField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
        resolveDynamicSelectOptions,
      });
      renderedAnyField = true;
      continue;
    }
    if (field.type === "number") {
      renderInlineConfigNumberField({
        node,
        definition,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
      });
      renderedAnyField = true;
      continue;
    }
    if (
      field.type === "media_path" ||
      field.type === "file_path" ||
      field.type === "directory_path"
    ) {
      renderInlineConfigPathField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
      });
      renderedAnyField = true;
      continue;
    }
    if (field.type === "textarea") {
      renderInlineConfigTextareaField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
      });
      renderedAnyField = true;
      continue;
    }
    if (field.type === "text") {
      renderInlineConfigTextField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
      });
      renderedAnyField = true;
      continue;
    }
    if (field.type === "boolean") {
      renderInlineConfigBooleanField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
      });
      renderedAnyField = true;
      continue;
    }
    if (field.type === "json_object") {
      renderInlineConfigJsonObjectField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
      });
      renderedAnyField = true;
      continue;
    }
    if (field.type === "string_list") {
      renderInlineConfigStringListField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
      });
      renderedAnyField = true;
    }
  }

  if (!renderedAnyField) {
    panelEl.remove();
    return false;
  }
  refreshVisibilityState();
  return true;
}

function resolveInlineTextEditorLabel(nodeKind: string): string {
  return nodeKind === "studio.transcription" ? "TRANSCRIPT" : "TEXT";
}

function resolveInlineTextEditorPlaceholder(nodeKind: string): string {
  if (nodeKind === "studio.transcription") {
    return "Transcribed text appears here...";
  }
  if (nodeKind === "studio.note") {
    return "Edit note text...";
  }
  if (nodeKind === "studio.text_generation") {
    return "Generated text appears here...";
  }
  return "Write or paste text...";
}

function resolveInlineTextEditorAriaLabel(node: StudioNodeInstance): string {
  if (node.kind === "studio.transcription") {
    return `${node.title || "Transcription"} transcript`;
  }
  if (node.kind === "studio.note") {
    return `${node.title || "Note"} content`;
  }
  if (node.kind === "studio.text_generation") {
    return `${node.title || "Text Generation"} text`;
  }
  return `${node.title || "Text"} content`;
}

function resolveInlineRenderedEmptyState(nodeKind: string): string {
  if (nodeKind === "studio.note") {
    return "Note is empty.";
  }
  if (nodeKind === "studio.text_generation") {
    return "Generated text appears here after a run.";
  }
  return "No markdown content yet.";
}

function renderInlineTextNodeEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const {
    nodeEl,
    node,
    nodeRunState,
    interactionLocked,
    onNodeConfigMutated,
    onNodePresentationMutated,
    renderMarkdownPreview,
  } = options;
  if (!isInlineTextNodeKind(node.kind)) {
    return false;
  }
  const outputLocked = node.kind === "studio.text_generation" && node.config.lockOutput === true;
  const editorReadOnly = interactionLocked || outputLocked;
  let textDisplayMode = readTextDisplayMode(node);
  let previewRenderRequest = 0;

  const editorWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-text-editor-wrap" });
  editorWrapEl.createDiv({
    cls: "ss-studio-node-text-editor-label",
    text: resolveInlineTextEditorLabel(node.kind),
  });

  const controlsEl = editorWrapEl.createDiv({ cls: "ss-studio-node-text-editor-controls" });
  const modeToggleEl = controlsEl.createDiv({ cls: "ss-studio-node-text-display-mode" });
  modeToggleEl.createEl("span", {
    cls: "ss-studio-node-text-display-mode-label",
    text: "Mode",
  });

  const rawModeButtonEl = modeToggleEl.createEl("button", {
    cls: "ss-studio-node-text-display-mode-button",
    text: "Raw",
    attr: {
      "aria-label": "Show raw markdown source",
    },
  });
  rawModeButtonEl.type = "button";
  rawModeButtonEl.disabled = interactionLocked;

  const renderedModeButtonEl = modeToggleEl.createEl("button", {
    cls: "ss-studio-node-text-display-mode-button",
    text: "Rendered",
    attr: {
      "aria-label": "Show rendered markdown preview",
    },
  });
  renderedModeButtonEl.type = "button";
  renderedModeButtonEl.disabled = interactionLocked;

  const rawSurfaceEl = editorWrapEl.createDiv({ cls: "ss-studio-node-text-editor-surface" });
  const textEditorEl = rawSurfaceEl.createEl("textarea", {
    cls: "ss-studio-node-text-editor",
    attr: {
      placeholder: resolveInlineTextEditorPlaceholder(node.kind),
      "aria-label": resolveInlineTextEditorAriaLabel(node),
    },
  });
  textEditorEl.value = readEditableNodeText(node, nodeRunState);
  textEditorEl.disabled = editorReadOnly;
  textEditorEl.addEventListener("input", (event) => {
    node.config.value = (event.target as HTMLTextAreaElement).value;
    onNodeConfigMutated(node);
  });

  const renderedSurfaceEl = editorWrapEl.createDiv({
    cls: "ss-studio-node-text-rendered is-hidden",
    attr: {
      "aria-label": `${resolveInlineTextEditorAriaLabel(node)} rendered markdown`,
    },
  });
  renderedSurfaceEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  renderedSurfaceEl.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const commitPresentationMutation = (): void => {
    if (onNodePresentationMutated) {
      onNodePresentationMutated(node);
      return;
    }
    onNodeConfigMutated(node);
  };

  const renderMarkdownSurface = (): void => {
    const content = textEditorEl.value;
    renderedSurfaceEl.empty();
    if (!content.trim()) {
      renderedSurfaceEl.createDiv({
        cls: "ss-studio-node-text-rendered-empty",
        text: resolveInlineRenderedEmptyState(node.kind),
      });
      return;
    }

    if (!renderMarkdownPreview) {
      renderedSurfaceEl.setText(content);
      return;
    }

    const currentRenderRequest = previewRenderRequest + 1;
    previewRenderRequest = currentRenderRequest;
    void Promise.resolve(renderMarkdownPreview(node, content, renderedSurfaceEl)).catch(() => {
      if (currentRenderRequest !== previewRenderRequest) {
        return;
      }
      renderedSurfaceEl.empty();
      renderedSurfaceEl.setText(content);
    });
  };

  const syncRenderedSurfaceHeightToRaw = (): void => {
    const rawHeight = Math.round(textEditorEl.getBoundingClientRect().height);
    if (rawHeight > 0) {
      renderedSurfaceEl.style.height = `${rawHeight}px`;
      return;
    }
    renderedSurfaceEl.style.removeProperty("height");
  };

  const applyDisplayMode = (): void => {
    const showRaw = textDisplayMode === "raw";
    if (!showRaw) {
      syncRenderedSurfaceHeightToRaw();
      renderMarkdownSurface();
    }
    rawSurfaceEl.toggleClass("is-hidden", !showRaw);
    renderedSurfaceEl.toggleClass("is-hidden", showRaw);
    rawModeButtonEl.classList.toggle("is-active", showRaw);
    renderedModeButtonEl.classList.toggle("is-active", !showRaw);
    rawModeButtonEl.setAttr("aria-pressed", showRaw ? "true" : "false");
    renderedModeButtonEl.setAttr("aria-pressed", showRaw ? "false" : "true");
    textEditorEl.disabled = editorReadOnly || !showRaw;
  };

  rawModeButtonEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked || textDisplayMode === "raw") {
      return;
    }
    textDisplayMode = "raw";
    node.config[TEXT_DISPLAY_MODE_CONFIG_KEY] = "raw";
    commitPresentationMutation();
    applyDisplayMode();
  });

  renderedModeButtonEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (interactionLocked || textDisplayMode === "rendered") {
      return;
    }
    textDisplayMode = "rendered";
    node.config[TEXT_DISPLAY_MODE_CONFIG_KEY] = "rendered";
    commitPresentationMutation();
    applyDisplayMode();
  });

  applyDisplayMode();
  return true;
}

function renderNodeSpecificInlineConfig(options: RenderStudioNodeInlineEditorOptions): boolean {
  const {
    node,
    nodeEl,
    nodeRunState,
    definition,
    interactionLocked,
    onNodeConfigMutated,
    resolveDynamicSelectOptions,
  } = options;
  const kind = normalizeNodeKind(node.kind);

  if (kind === "studio.image_generation") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["modelId", "count", "aspectRatio"],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.media_ingest") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["sourcePath"],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.audio_extract") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["ffmpegCommand", "outputFormat", "outputPath", "timeoutMs", "maxOutputBytes"],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.note") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["vaultPath"],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.text_generation") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["sourceMode", "modelId", "localModelId", "reasoningEffort", "systemPrompt"],
      interactionLocked,
      onNodeConfigMutated,
      panelClassName: "ss-studio-node-inline-config--text-generation",
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.dataset") {
    const rendered = renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: [
        "workingDirectory",
        "customQuery",
        "adapterCommand",
        "adapterArgs",
        "refreshHours",
        "timeoutMs",
        "maxOutputBytes",
      ],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
    if (rendered) {
      renderDatasetOutputPreview({
        nodeEl,
        node,
        nodeRunState,
      });
    }
    return rendered;
  }

  if (kind === "studio.json") {
    return renderJsonNodeEditor(options);
  }

  if (kind === "studio.value") {
    renderValueOutputPreview({
      nodeEl,
      node,
      nodeRunState,
    });
    return true;
  }

  if (kind === "studio.http_request") {
    const rendered = renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: [
        "method",
        "url",
        "headers",
        "bearerToken",
        "body",
        "maxRetries",
      ],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
    renderHttpRequestBindingSummary({
      nodeEl,
      inboundEdges: options.inboundEdges,
    });
    return rendered || nodeEl.hasChildNodes();
  }

  if (kind === "studio.cli_command") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["command", "args", "cwd", "timeoutMs", "maxOutputBytes"],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
  }

  if (kind === "studio.input") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["value"],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
  }

  if (isInlineTextNodeKind(kind)) {
    return false;
  }

  return renderInlineConfigPanel({
    nodeEl,
    node,
    definition,
    orderedFieldKeys: definition.configSchema.fields.map((field) => field.key),
    interactionLocked,
    onNodeConfigMutated,
    resolveDynamicSelectOptions,
  });
}

export function renderStudioNodeInlineEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const renderedConfig = renderNodeSpecificInlineConfig(options);
  const renderedTextEditor = renderInlineTextNodeEditor(options);
  return renderedConfig || renderedTextEditor;
}

export function hasStudioNodeInlineEditor(kind: string): boolean {
  return INLINE_EDITOR_NODE_KINDS.has(normalizeNodeKind(kind));
}

export function shouldSuppressNodeOutputPreview(kind: string): boolean {
  return OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS.has(normalizeNodeKind(kind));
}
