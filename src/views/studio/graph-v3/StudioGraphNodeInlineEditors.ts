import type {
  StudioNodeConfigFieldDefinition,
  StudioNodeDefinition,
  StudioNodeInstance,
} from "../../../studio/types";
import type { StudioNodeRunDisplayState } from "../StudioRunPresentationState";
import { browseForNodeConfigPath } from "../StudioPathFieldPicker";

type RenderStudioNodeInlineEditorOptions = {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  nodeRunState: StudioNodeRunDisplayState;
  definition: StudioNodeDefinition;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
};

const INLINE_EDITOR_NODE_KINDS = new Set<string>([
  "studio.image_generation",
  "studio.media_ingest",
  "studio.audio_extract",
  "studio.text",
  "studio.text_generation",
  "studio.transcription",
]);

const OUTPUT_PREVIEW_SUPPRESSED_NODE_KINDS = new Set<string>([
  "studio.image_generation",
  "studio.media_ingest",
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
    normalizedKind === "studio.text" ||
    normalizedKind === "studio.text_generation" ||
    normalizedKind === "studio.transcription"
  );
}

function normalizeFieldLabel(field: StudioNodeConfigFieldDefinition): string {
  const raw = String(field.label || field.key || "").trim();
  return raw.toUpperCase();
}

function isVisibleByRule(
  field: StudioNodeConfigFieldDefinition,
  config: Record<string, unknown>
): boolean {
  if (!field.visibleWhen) {
    return true;
  }
  const expected = Array.isArray(field.visibleWhen.equals)
    ? field.visibleWhen.equals
    : [field.visibleWhen.equals];
  const current = config[field.visibleWhen.key];
  return expected.some((value) => value === current);
}

function buildVisibleFieldList(options: {
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  orderedKeys: string[];
}): StudioNodeConfigFieldDefinition[] {
  const { node, definition, orderedKeys } = options;
  const visible = definition.configSchema.fields.filter((field) =>
    isVisibleByRule(field, node.config as Record<string, unknown>)
  );
  if (visible.length === 0) {
    return [];
  }

  const byKey = new Map<string, StudioNodeConfigFieldDefinition>();
  for (const field of visible) {
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
  for (const field of visible) {
    if (seen.has(field.key)) {
      continue;
    }
    output.push(field);
  }
  return output;
}

function isInlineConfigFieldFullWidth(field: StudioNodeConfigFieldDefinition): boolean {
  if (field.type === "textarea" || field.type === "media_path") {
    return true;
  }
  return false;
}

function renderInlineConfigSelectField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated } = options;
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
}): boolean {
  const {
    nodeEl,
    node,
    definition,
    orderedFieldKeys,
    interactionLocked,
    onNodeConfigMutated,
  } = options;

  const fields = buildVisibleFieldList({
    node,
    definition,
    orderedKeys: orderedFieldKeys,
  });
  if (fields.length === 0) {
    return false;
  }

  const panelEl = nodeEl.createDiv({ cls: "ss-studio-node-inline-config" });
  const gridEl = panelEl.createDiv({ cls: "ss-studio-node-inline-config-grid" });
  let renderedAnyField = false;

  for (const field of fields) {
    const fullWidth = isInlineConfigFieldFullWidth(field);
    const fieldEl = gridEl.createDiv({
      cls: `ss-studio-node-inline-config-field${fullWidth ? " is-full" : ""}`,
    });
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
        onNodeConfigMutated,
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
        onNodeConfigMutated,
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
        onNodeConfigMutated,
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
        onNodeConfigMutated,
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
        onNodeConfigMutated,
      });
      renderedAnyField = true;
    }
  }

  if (!renderedAnyField) {
    panelEl.remove();
    return false;
  }
  return true;
}

function renderInlineTextNodeEditor(options: RenderStudioNodeInlineEditorOptions): boolean {
  const { nodeEl, node, nodeRunState, interactionLocked, onNodeConfigMutated } = options;
  if (!isInlineTextNodeKind(node.kind)) {
    return false;
  }

  const editorLabel = node.kind === "studio.transcription"
    ? "TRANSCRIPT"
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
          : node.kind === "studio.text_generation"
            ? "Generated text appears here..."
            : "Write or paste text...",
      "aria-label":
        node.kind === "studio.transcription"
          ? `${node.title || "Transcription"} transcript`
          : node.kind === "studio.text_generation"
            ? `${node.title || "Text Generation"} text`
            : `${node.title || "Text"} content`,
    },
  });
  textEditorEl.value = readEditableNodeText(node, nodeRunState);
  textEditorEl.disabled = interactionLocked;
  textEditorEl.style.minHeight = "240px";
  textEditorEl.addEventListener("input", (event) => {
    node.config.value = (event.target as HTMLTextAreaElement).value;
    onNodeConfigMutated(node);
  });
  return true;
}

function renderNodeSpecificInlineConfig(options: RenderStudioNodeInlineEditorOptions): boolean {
  const { node, nodeEl, definition, interactionLocked, onNodeConfigMutated } = options;
  const kind = normalizeNodeKind(node.kind);

  if (kind === "studio.image_generation") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["systemPrompt", "modelId", "count", "aspectRatio"],
      interactionLocked,
      onNodeConfigMutated,
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
    });
  }

  if (kind === "studio.text_generation") {
    return renderInlineConfigPanel({
      nodeEl,
      node,
      definition,
      orderedFieldKeys: ["systemPrompt", "modelId"],
      interactionLocked,
      onNodeConfigMutated,
    });
  }

  return false;
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
