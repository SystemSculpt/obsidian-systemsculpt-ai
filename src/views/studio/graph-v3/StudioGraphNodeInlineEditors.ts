import type {
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
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  resolveDynamicSelectOptions?: (
    source: StudioNodeConfigDynamicOptionsSource,
    node: StudioNodeInstance
  ) => Promise<StudioNodeConfigSelectOption[]>;
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

function renderJsonOutputPreview(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
}): void {
  const { nodeEl, node, nodeRunState } = options;
  const outputs = nodeRunState.outputs as Record<string, unknown> | null;
  const seededValue = (node.config as Record<string, unknown>).__studio_seed_json;
  const outputValue = outputs && Object.prototype.hasOwnProperty.call(outputs, "json")
    ? outputs.json
    : seededValue;
  const previewText = formatJsonPreview(outputValue);
  const outputWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-inline-output-preview" });
  outputWrapEl.createDiv({
    cls: "ss-studio-node-inline-output-preview-label",
    text: "JSON PREVIEW",
  });
  const outputEditorEl = outputWrapEl.createEl("textarea", {
    cls: "ss-studio-node-inline-output-preview-text",
    attr: {
      "aria-label": `${node.title || "JSON"} preview`,
      readonly: "readonly",
    },
  });
  outputEditorEl.readOnly = true;
  outputEditorEl.value = previewText.trim()
    ? previewText
    : "Connect a JSON output and run this node to inspect the value.";
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
      placeholder: field.required ? "Select model" : "Default",
      noResultsText: "No matching models.",
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
    type: "text",
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
    const fieldEl = gridEl.createDiv({
      cls: `ss-studio-node-inline-config-field${fullWidth ? " is-full" : ""}`,
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

function renderInlineTextNodeEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const { nodeEl, node, nodeRunState, interactionLocked, onNodeConfigMutated } = options;
  if (!isInlineTextNodeKind(node.kind)) {
    return false;
  }
  const outputLocked = node.kind === "studio.text_generation" && node.config.lockOutput === true;

  const editorLabel = node.kind === "studio.transcription"
    ? "TRANSCRIPT"
    : node.kind === "studio.note"
      ? "NOTE"
    : node.kind === "studio.text_generation"
      ? "TEXT"
      : "TEXT";
  const editorWrapEl = nodeEl.createDiv({ cls: "ss-studio-node-text-editor-wrap" });
  editorWrapEl.createDiv({
    cls: "ss-studio-node-text-editor-label",
    text: editorLabel,
  });
  const textEditorEl = editorWrapEl.createEl("textarea", {
    cls: "ss-studio-node-text-editor",
    attr: {
      placeholder:
        node.kind === "studio.transcription"
          ? "Transcribed text appears here..."
          : node.kind === "studio.note"
            ? "Edit note text..."
          : node.kind === "studio.text_generation"
            ? "Generated text appears here..."
            : "Write or paste text...",
      "aria-label":
        node.kind === "studio.transcription"
          ? `${node.title || "Transcription"} transcript`
          : node.kind === "studio.note"
            ? `${node.title || "Note"} content`
          : node.kind === "studio.text_generation"
            ? `${node.title || "Text Generation"} text`
            : `${node.title || "Text"} content`,
    },
  });
  textEditorEl.value = readEditableNodeText(node, nodeRunState);
  textEditorEl.disabled = interactionLocked || outputLocked;
  textEditorEl.style.minHeight = "240px";
  textEditorEl.addEventListener("input", (event) => {
    node.config.value = (event.target as HTMLTextAreaElement).value;
    onNodeConfigMutated(node);
  });
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
      orderedFieldKeys: ["systemPrompt", "modelId", "count", "aspectRatio"],
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
      orderedFieldKeys: ["sourceMode", "systemPrompt", "modelId", "localModelId"],
      interactionLocked,
      onNodeConfigMutated,
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
    renderJsonOutputPreview({
      nodeEl,
      node,
      nodeRunState,
    });
    return true;
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
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: [
        "mode",
        "method",
        "authSource",
        "authTokenRef",
        "authToken",
        "authHeaderName",
        "authScheme",
        "url",
        "headers",
        "body",
        "bodyTemplate",
        "itemBodyField",
        "mergeItemObject",
        "maxRequests",
        "throttleMs",
        "maxRetries",
        "dryRun",
        "continueOnHttpError",
      ],
      interactionLocked,
      onNodeConfigMutated,
      resolveDynamicSelectOptions,
    });
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
