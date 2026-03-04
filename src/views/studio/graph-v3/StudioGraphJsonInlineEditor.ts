import type { StudioJsonValue, StudioNodeInstance } from "../../../studio/types";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";

export type StudioJsonEditorMode = "composer" | "raw";
type StudioJsonHtmlViewMode = "source" | "preview";
type StudioJsonComposerValueType = "text" | "html" | "number" | "boolean" | "null" | "json";
type StudioJsonComposerRow = {
  id: string;
  key: string;
  value: string;
  valueType: StudioJsonComposerValueType;
  useTextarea: boolean;
  htmlViewMode: StudioJsonHtmlViewMode;
};
type StudioJsonEditorSourceKind = "config" | "runtime" | "default";

type RenderStudioJsonNodeEditorOptions = {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  getJsonEditorPreferredMode?: () => StudioJsonEditorMode;
  onJsonEditorPreferredModeChange?: (mode: StudioJsonEditorMode) => void;
  showOutputPreview?: boolean;
};

const JSON_VALUE_CONFIG_KEY = "value";
const JSON_COMPOSER_TYPE_OPTIONS: Array<{ value: StudioJsonComposerValueType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "html", label: "HTML" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Bool" },
  { value: "null", label: "Null" },
  { value: "json", label: "JSON" },
];

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

function hasConfiguredJsonNodeValue(node: StudioNodeInstance): boolean {
  const config = node.config as Record<string, StudioJsonValue>;
  return Object.prototype.hasOwnProperty.call(config, JSON_VALUE_CONFIG_KEY);
}

function readJsonNodeEditorValue(
  node: StudioNodeInstance,
  nodeRunState: StudioNodeRunDisplayState
): StudioJsonValue {
  if (hasConfiguredJsonNodeValue(node)) {
    return readJsonNodeConfigValue(node);
  }
  const outputs = nodeRunState.outputs as Record<string, unknown> | null;
  if (outputs && Object.prototype.hasOwnProperty.call(outputs, "json")) {
    return outputs.json as StudioJsonValue;
  }
  return readJsonNodeConfigValue(node);
}

function hasRuntimeJsonOutput(nodeRunState: StudioNodeRunDisplayState): boolean {
  const outputs = nodeRunState.outputs as Record<string, unknown> | null;
  return Boolean(outputs && Object.prototype.hasOwnProperty.call(outputs, "json"));
}

function resolveJsonEditorSourceKind(
  node: StudioNodeInstance,
  nodeRunState: StudioNodeRunDisplayState
): StudioJsonEditorSourceKind {
  if (hasConfiguredJsonNodeValue(node)) {
    return "config";
  }
  if (hasRuntimeJsonOutput(nodeRunState)) {
    return "runtime";
  }
  return "default";
}

function resolveJsonEditorSourceLabel(sourceKind: StudioJsonEditorSourceKind): string {
  if (sourceKind === "config") {
    return "Config";
  }
  if (sourceKind === "runtime") {
    return "Runtime";
  }
  return "Default";
}

function resolveJsonEditorSourceHint(sourceKind: StudioJsonEditorSourceKind): string {
  if (sourceKind === "config") {
    return "Using saved config.value";
  }
  if (sourceKind === "runtime") {
    return "Using latest run output";
  }
  return "Using default empty object";
}

function isLikelyHtmlFieldKey(key: string): boolean {
  const normalized = String(key || "").trim().toLowerCase();
  return normalized.length > 0 && normalized.includes("html");
}

function sanitizeHtmlPreviewSource(rawHtml: string): string {
  const template = document.createElement("template");
  template.innerHTML = rawHtml;

  for (const selector of ["script", "iframe", "object", "embed", "meta", "base", "link"]) {
    for (const element of Array.from(template.content.querySelectorAll(selector))) {
      element.remove();
    }
  }

  for (const element of Array.from(template.content.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const attributeValue = attribute.value;
      if (attributeName.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        (attributeName === "src" ||
          attributeName === "href" ||
          attributeName === "xlink:href" ||
          attributeName === "action" ||
          attributeName === "formaction") &&
        /^\s*javascript:/i.test(attributeValue)
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attributeName === "srcdoc") {
        element.removeAttribute(attribute.name);
      }
    }
  }

  return template.innerHTML;
}

function writeJsonNodeConfigValue(node: StudioNodeInstance, value: StudioJsonValue): void {
  node.config[JSON_VALUE_CONFIG_KEY] = value;
}

function normalizeJsonEditorMode(raw: unknown): StudioJsonEditorMode {
  return String(raw || "").trim().toLowerCase() === "raw" ? "raw" : "composer";
}

function inferComposerValueType(value: StudioJsonValue, key = ""): StudioJsonComposerValueType {
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
  if (typeof value === "string" && isLikelyHtmlFieldKey(key)) {
    return "html";
  }
  return "text";
}

function formatComposerRowValue(value: StudioJsonValue, key = ""): {
  value: string;
  valueType: StudioJsonComposerValueType;
  useTextarea: boolean;
  htmlViewMode: StudioJsonHtmlViewMode;
} {
  const valueType = inferComposerValueType(value, key);
  if (valueType === "text") {
    const textValue = typeof value === "string" ? value : String(value ?? "");
    return {
      value: textValue,
      valueType,
      useTextarea: textValue.includes("\n"),
      htmlViewMode: "source",
    };
  }
  if (valueType === "html") {
    const htmlValue = typeof value === "string" ? value : String(value ?? "");
    return {
      value: htmlValue,
      valueType,
      useTextarea: true,
      htmlViewMode: "source",
    };
  }
  if (valueType === "number" || valueType === "boolean") {
    return {
      value: String(value),
      valueType,
      useTextarea: false,
      htmlViewMode: "source",
    };
  }
  if (valueType === "null") {
    return {
      value: "",
      valueType,
      useTextarea: false,
      htmlViewMode: "source",
    };
  }
  const jsonValue = formatJsonPreview(value);
  return {
    value: jsonValue,
    valueType,
    useTextarea: jsonValue.includes("\n"),
    htmlViewMode: "source",
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
  if (row.valueType === "html") {
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
    const formatted = formatComposerRowValue(rawValue, key);
    return {
      id: nextJsonComposerRowId(),
      key,
      value: formatted.value,
      valueType: formatted.valueType,
      useTextarea: formatted.useTextarea,
      htmlViewMode: formatted.htmlViewMode,
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

export function renderJsonNodeEditor(options: RenderStudioJsonNodeEditorOptions): boolean {
  const {
    nodeEl,
    node,
    nodeRunState,
    interactionLocked,
    onNodeConfigMutated,
    getJsonEditorPreferredMode,
    onJsonEditorPreferredModeChange,
    showOutputPreview = true,
  } = options;

  const editorWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-json-editor" });
  editorWrapEl.createDiv({
    cls: "ss-studio-node-json-editor-label",
    text: "JSON",
  });

  const controlsEl = editorWrapEl.createDiv({ cls: "ss-studio-node-json-editor-controls" });
  const sourceStateEl = controlsEl.createDiv({ cls: "ss-studio-node-json-source-state" });
  sourceStateEl.createDiv({
    cls: "ss-studio-node-json-source-state-label",
    text: "Source",
  });
  const sourceStateBadgeEl = sourceStateEl.createDiv({
    cls: "ss-studio-node-json-source-badge",
    text: "Default",
  });

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

  const effectivePayloadEl = editorWrapEl.createDiv({ cls: "ss-studio-node-json-effective-payload" });
  const effectiveHeaderEl = effectivePayloadEl.createDiv({ cls: "ss-studio-node-json-effective-header" });
  effectiveHeaderEl.createDiv({
    cls: "ss-studio-node-json-effective-label",
    text: "Effective Payload",
  });
  const effectiveHintEl = effectiveHeaderEl.createDiv({
    cls: "ss-studio-node-json-effective-hint",
    text: "",
  });
  const effectiveEditorEl = effectivePayloadEl.createEl("textarea", {
    cls: "ss-studio-node-inline-output-preview-text ss-studio-node-json-effective-editor",
    attr: {
      "aria-label": `${node.title || "JSON"} effective payload`,
      readonly: "readonly",
    },
  });
  effectiveEditorEl.readOnly = true;

  let composerRows: StudioJsonComposerRow[] = [];
  let editorMode = normalizeJsonEditorMode(getJsonEditorPreferredMode?.());

  const createEmptyComposerRow = (): StudioJsonComposerRow => ({
    id: nextJsonComposerRowId(),
    key: "",
    value: "",
    valueType: "text",
    useTextarea: false,
    htmlViewMode: "source",
  });

  const refreshJsonEditorSourceState = (): void => {
    const sourceKind = resolveJsonEditorSourceKind(node, nodeRunState);
    sourceStateBadgeEl.setText(resolveJsonEditorSourceLabel(sourceKind));
    sourceStateBadgeEl.classList.toggle("is-config", sourceKind === "config");
    sourceStateBadgeEl.classList.toggle("is-runtime", sourceKind === "runtime");
    sourceStateBadgeEl.classList.toggle("is-default", sourceKind === "default");
    effectiveHintEl.setText(resolveJsonEditorSourceHint(sourceKind));
    effectiveEditorEl.value = formatJsonPreview(readJsonNodeEditorValue(node, nodeRunState));
  };

  const syncRawEditorFromConfig = (): void => {
    rawEditorEl.value = formatJsonPreview(readJsonNodeEditorValue(node, nodeRunState));
    rawErrorEl.addClass("is-hidden");
    rawErrorEl.setText("");
    refreshJsonEditorSourceState();
  };

  const hydrateComposerRowsFromConfig = (): void => {
    const configuredValue = readJsonNodeEditorValue(node, nodeRunState);
    if (!isJsonObjectValue(configuredValue)) {
      composerRows = [];
      return;
    }
    composerRows = buildComposerRowsFromJsonObject(configuredValue);
  };

  const renderComposerRows = (focusRowId?: string): void => {
    composerSurfaceEl.empty();
    const configuredValue = readJsonNodeEditorValue(node, nodeRunState);
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
        refreshJsonEditorSourceState();
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
      refreshJsonEditorSourceState();
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
          } else if (nextType === "json" || nextType === "html") {
            row.useTextarea = true;
          } else if (nextType === "text") {
            row.useTextarea = row.value.includes("\n");
          } else if (!row.value.includes("\n")) {
            row.useTextarea = false;
          }
          if (nextType === "html") {
            row.htmlViewMode = "source";
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
        valueWrapEl.classList.toggle("is-html-row", row.valueType === "html");
        const valueReadOnly = interactionLocked || row.valueType === "null";
        const valueInputClass = "ss-studio-node-json-row-value";
        if (row.valueType === "html") {
          const htmlValueWrapEl = valueWrapEl.createDiv({ cls: "ss-studio-node-json-row-html-wrap" });
          const htmlModeEl = htmlValueWrapEl.createDiv({ cls: "ss-studio-node-json-row-html-mode" });
          const sourceModeEl = htmlModeEl.createEl("button", {
            cls: "ss-studio-node-json-row-button ss-studio-node-json-row-html-mode-button",
            text: "Source",
          });
          sourceModeEl.type = "button";
          sourceModeEl.disabled = interactionLocked;
          const previewModeEl = htmlModeEl.createEl("button", {
            cls: "ss-studio-node-json-row-button ss-studio-node-json-row-html-mode-button",
            text: "Preview",
          });
          previewModeEl.type = "button";
          previewModeEl.disabled = interactionLocked;

          const htmlSourceSurfaceEl = htmlValueWrapEl.createDiv({
            cls: "ss-studio-node-json-row-html-source-surface",
          });
          const valueEl = htmlSourceSurfaceEl.createEl("textarea", {
            cls: `${valueInputClass} ss-studio-node-json-row-html-source`,
            attr: {
              placeholder: "html source",
              "aria-label": `HTML value for ${row.key || "row"}`,
            },
          });
          valueEl.value = row.value;
          valueEl.disabled = interactionLocked;

          const htmlPreviewSurfaceEl = htmlValueWrapEl.createDiv({
            cls: "ss-studio-node-json-row-html-preview-surface is-hidden",
          });
          const htmlPreviewFrameEl = htmlPreviewSurfaceEl.createEl("iframe", {
            cls: "ss-studio-node-json-row-html-preview-frame",
            attr: {
              sandbox: "",
              referrerpolicy: "no-referrer",
              title: `HTML preview for ${row.key || "field"}`,
            },
          });

          const applyHtmlMode = (): void => {
            const showSource = row.htmlViewMode !== "preview";
            htmlSourceSurfaceEl.classList.toggle("is-hidden", !showSource);
            htmlPreviewSurfaceEl.classList.toggle("is-hidden", showSource);
            sourceModeEl.classList.toggle("is-active", showSource);
            previewModeEl.classList.toggle("is-active", !showSource);
            sourceModeEl.setAttr("aria-pressed", showSource ? "true" : "false");
            previewModeEl.setAttr("aria-pressed", showSource ? "false" : "true");
            if (!showSource) {
              htmlPreviewFrameEl.setAttr("srcdoc", sanitizeHtmlPreviewSource(row.value));
            }
          };

          sourceModeEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (interactionLocked || row.htmlViewMode === "source") {
              return;
            }
            row.htmlViewMode = "source";
            applyHtmlMode();
          });

          previewModeEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (interactionLocked || row.htmlViewMode === "preview") {
              return;
            }
            row.htmlViewMode = "preview";
            applyHtmlMode();
          });

          valueEl.addEventListener("input", () => {
            row.value = valueEl.value;
            commitComposerRows();
            refreshComposerValidation();
            if (row.htmlViewMode === "preview") {
              htmlPreviewFrameEl.setAttr("srcdoc", sanitizeHtmlPreviewSource(row.value));
            }
          });

          applyHtmlMode();
        } else if (row.useTextarea) {
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

        if (row.valueType !== "html") {
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
        }

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
      const current = readJsonNodeEditorValue(node, nodeRunState);
      const baseObject: Record<string, StudioJsonValue> = isJsonObjectValue(current)
        ? { ...(current as Record<string, StudioJsonValue>) }
        : {};
      baseObject.from = typeof baseObject.from === "string" ? baseObject.from : "";
      if (Array.isArray(baseObject.to)) {
        baseObject.to = baseObject.to.map((entry) => String(entry ?? "")).filter((entry) => entry.trim().length > 0);
      } else if (typeof baseObject.to === "string" && baseObject.to.trim().length > 0) {
        baseObject.to = [baseObject.to];
      } else {
        baseObject.to = [];
      }
      baseObject.reply_to = typeof baseObject.reply_to === "string" ? baseObject.reply_to : "";
      baseObject.subject = typeof baseObject.subject === "string" ? baseObject.subject : "";
      baseObject.text = typeof baseObject.text === "string" ? baseObject.text : "";
      baseObject.html = typeof baseObject.html === "string" ? baseObject.html : "";
      writeJsonNodeConfigValue(node, baseObject);
      onNodeConfigMutated(node);
      hydrateComposerRowsFromConfig();
      syncRawEditorFromConfig();
      renderComposerRows();
      refreshJsonEditorSourceState();
    });

    const hintEl = footerEl.createDiv({ cls: "ss-studio-node-json-composer-hint" });
    hintEl.setText("Choose value type per row. HTML rows support Source/Preview. Use Raw for advanced nested JSON.");
    refreshComposerValidation();
    refreshJsonEditorSourceState();
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
    refreshJsonEditorSourceState();
  });

  hydrateComposerRowsFromConfig();
  renderComposerRows();
  syncRawEditorFromConfig();
  applyDisplayMode();
  refreshJsonEditorSourceState();

  if (showOutputPreview) {
    renderJsonOutputPreview({
      nodeEl,
      node,
      nodeRunState,
      configuredValue: readJsonNodeEditorValue(node, nodeRunState),
    });
  }

  return true;
}

