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
import {
  deriveStudioNoteTitleFromPath,
  parseStudioNoteItems,
  serializeStudioNoteItems,
} from "../../../studio/StudioNoteConfig";
import {
  appendStudioPathBrowseButtonIcon,
  resolveStudioNotePathState,
  type StudioNotePathStateTone,
} from "../StudioPathFieldUi";
import { browseForNodeConfigPath } from "../StudioPathFieldPicker";
import { renderStudioSearchableDropdown } from "../StudioSearchableDropdown";
import type { StudioGraphNodeMutationOptions } from "./StudioGraphNodeCardTypes";

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

function commitInlineConfigValueChange(options: {
  node: StudioNodeInstance;
  key: string;
  value: StudioJsonValue;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  mutationOptions?: StudioGraphNodeMutationOptions;
}): void {
  if (options.onNodeConfigValueChange) {
    options.onNodeConfigValueChange(
      options.node.id,
      options.key,
      options.value,
      options.mutationOptions
    );
    return;
  }
  options.node.config[options.key] = options.value;
  options.onNodeConfigMutated(options.node);
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
    field.type === "string_list" ||
    field.type === "note_selector"
  ) {
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
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
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
    onNodeConfigValueChange,
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
        commitInlineConfigValueChange({
          node,
          key: field.key,
          value: option.value,
          onNodeConfigMutated,
          onNodeConfigValueChange,
          mutationOptions: { mode: "discrete" },
        });
        refreshActiveState(option.value);
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
        commitInlineConfigValueChange({
          node,
          key: field.key,
          value,
          onNodeConfigMutated,
          onNodeConfigValueChange,
          mutationOptions: { mode: "discrete" },
        });
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
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: selectEl.value,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "discrete" },
    });
  });
}

function renderInlineConfigNumberField(options: {
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const { node, definition, field, fieldEl, interactionLocked, onNodeConfigMutated, onNodeConfigValueChange } = options;
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
    inputEl.value = String(normalized);
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: normalized,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "discrete" },
    });
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
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated, onNodeConfigValueChange } = options;
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
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: inputEl.value,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "continuous" },
    });
  });
}

function renderInlineConfigTextareaField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  compactSingleRow?: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const {
    node,
    field,
    fieldEl,
    interactionLocked,
    compactSingleRow = false,
    onNodeConfigMutated,
    onNodeConfigValueChange,
  } = options;
  const textareaClassName = compactSingleRow
    ? "ss-studio-node-inline-config-textarea is-single-row"
    : "ss-studio-node-inline-config-textarea";
  const textAreaEl = fieldEl.createEl("textarea", {
    cls: textareaClassName,
    attr: {
      placeholder: field.placeholder || "",
      "aria-label": `${node.title || node.kind} ${field.label || field.key}`,
      ...(compactSingleRow ? { rows: "1" } : {}),
    },
  });
  textAreaEl.disabled = interactionLocked;
  textAreaEl.value = readConfigString(node.config[field.key]);
  textAreaEl.addEventListener("input", () => {
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: textAreaEl.value,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "continuous" },
    });
  });
}

function renderInlineConfigBooleanField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated, onNodeConfigValueChange } = options;
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
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: checkboxEl.checked,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "discrete" },
    });
  });
}

function renderInlineConfigJsonObjectField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated, onNodeConfigValueChange } = options;
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
      commitInlineConfigValueChange({
        node,
        key: field.key,
        value: {},
        onNodeConfigMutated,
        onNodeConfigValueChange,
        mutationOptions: { mode: "discrete" },
      });
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      commitInlineConfigValueChange({
        node,
        key: field.key,
        value: parsed as Record<string, StudioJsonValue>,
        onNodeConfigMutated,
        onNodeConfigValueChange,
        mutationOptions: { mode: "discrete" },
      });
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
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated, onNodeConfigValueChange } = options;
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
    const nextValues = textAreaEl.value
      .split(/\r?\n/g)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: nextValues,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "continuous" },
    });
  });
}

function renderInlineConfigNoteSelectorField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated, onNodeConfigValueChange } = options;

  const items = parseStudioNoteItems(node.config[field.key] as StudioJsonValue | undefined);
  const container = fieldEl.createDiv({ cls: "ss-studio-note-selector" });
  const toolbarEl = container.createDiv({ cls: "ss-studio-note-selector-toolbar" });
  const summaryEl = toolbarEl.createDiv({ cls: "ss-studio-note-selector-summary" });
  const countBadgeEl = summaryEl.createSpan({ cls: "ss-studio-note-selector-count" });
  const statusEl = summaryEl.createSpan({ cls: "ss-studio-note-selector-status" });
  const addButton = toolbarEl.createEl("button", {
    cls: "ss-studio-note-selector-add-button",
    text: "Add Note",
    attr: {
      "aria-label": "Add note entry",
    },
  });
  addButton.type = "button";
  addButton.disabled = interactionLocked;
  const itemsContainer = container.createDiv({ cls: "ss-studio-note-selector-items" });

  const updateSummary = (): void => {
    const total = items.length;
    const enabled = items.filter((entry) => entry.enabled).length;
    const skipped = total - enabled;
    countBadgeEl.setText(`${total} ${total === 1 ? "note" : "notes"}`);
    if (total === 0) {
      statusEl.setText("Add markdown notes to include in this node.");
      return;
    }
    if (enabled === total) {
      statusEl.setText("All notes included.");
      return;
    }
    if (enabled === 0) {
      statusEl.setText("All notes are skipped.");
      return;
    }
    statusEl.setText(`${enabled} included, ${skipped} skipped.`);
  };

  const emitChange = (mutationOptions?: StudioGraphNodeMutationOptions): void => {
    const serialized = serializeStudioNoteItems(items);
    updateSummary();
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: serialized,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions,
    });
  };

  const bindActionButton = (
    buttonEl: HTMLButtonElement,
    handler: () => Promise<void> | void
  ): void => {
    buttonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (interactionLocked) {
        return;
      }
      void handler();
    });
  };

  const formatNoteCardLabel = (index: number, path: string): string => {
    const noteTitle = deriveStudioNoteTitleFromPath(path);
    if (!noteTitle) {
      return `Note ${index + 1}`;
    }
    return `Note ${index + 1} (${noteTitle})`;
  };

  const renderItems = (): void => {
    itemsContainer.empty();
    if (items.length === 0) {
      itemsContainer.createDiv({
        cls: "ss-studio-note-selector-empty",
        text: "No notes yet. Add one or more markdown notes.",
      });
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const cardEl = itemsContainer.createDiv({ cls: "ss-studio-note-selector-card" });
      if (!item.enabled) {
        cardEl.addClass("is-disabled");
      }

      const cardHeaderEl = cardEl.createDiv({ cls: "ss-studio-note-selector-card-head" });
      const toggleLabel = cardHeaderEl.createEl("label", {
        cls: "ss-studio-note-selector-control-label",
      });
      const checkbox = toggleLabel.createEl("input", {
        type: "checkbox",
        cls: "ss-studio-note-selector-toggle-checkbox",
        attr: {
          "aria-label": `Include note ${i + 1} in output`,
        },
      });
      checkbox.checked = item.enabled;
      checkbox.disabled = interactionLocked;
      const cardIndexEl = toggleLabel.createSpan({
        cls: "ss-studio-note-selector-card-index",
        text: "",
      });
      const syncCardIndex = (): void => {
        cardIndexEl.setText(formatNoteCardLabel(i, item.path));
      };
      syncCardIndex();

      const actionsEl = cardHeaderEl.createDiv({ cls: "ss-studio-note-selector-card-actions" });
      const moveUpButton = actionsEl.createEl("button", {
        cls: "ss-studio-note-selector-action-button",
        text: "Up",
        attr: {
          "aria-label": `Move note ${i + 1} up`,
          title: "Move note up",
        },
      });
      moveUpButton.type = "button";
      moveUpButton.disabled = interactionLocked || i === 0;
      bindActionButton(moveUpButton, () => {
        if (i === 0) {
          return;
        }
        const previous = items[i - 1];
        items[i - 1] = item;
        items[i] = previous;
        renderItems();
        emitChange({ mode: "discrete" });
      });

      const moveDownButton = actionsEl.createEl("button", {
        cls: "ss-studio-note-selector-action-button",
        text: "Down",
        attr: {
          "aria-label": `Move note ${i + 1} down`,
          title: "Move note down",
        },
      });
      moveDownButton.type = "button";
      moveDownButton.disabled = interactionLocked || i === items.length - 1;
      bindActionButton(moveDownButton, () => {
        if (i >= items.length - 1) {
          return;
        }
        const next = items[i + 1];
        items[i + 1] = item;
        items[i] = next;
        renderItems();
        emitChange({ mode: "discrete" });
      });

      const removeButton = actionsEl.createEl("button", {
        cls: "ss-studio-note-selector-remove-button",
        text: "Remove",
        attr: {
          "aria-label": `Remove note ${i + 1}`,
          title: "Remove note",
        },
      });
      removeButton.type = "button";
      removeButton.disabled = interactionLocked;
      bindActionButton(removeButton, () => {
        items.splice(i, 1);
        renderItems();
        emitChange({ mode: "discrete" });
      });

      const syncEnabledState = (): void => {
        const isEnabled = item.enabled;
        cardEl.classList.toggle("is-disabled", !isEnabled);
      };
      syncEnabledState();
      checkbox.addEventListener("change", () => {
        item.enabled = checkbox.checked;
        syncEnabledState();
        emitChange({ mode: "discrete" });
      });

      const fieldsEl = cardEl.createDiv({ cls: "ss-studio-note-selector-fields" });
      const pathField = fieldsEl.createDiv({ cls: "ss-studio-note-selector-field" });
      const pathRow = pathField.createDiv({
        cls: "ss-studio-node-inline-config-path-row ss-studio-note-selector-path-row",
      });
      const pathInput = pathRow.createEl("input", {
        type: "text",
        cls: "ss-studio-node-inline-config-input ss-studio-node-inline-config-path-input",
        attr: {
          placeholder: "Vault path to markdown note",
          "aria-label": `Markdown path for note ${i + 1}`,
        },
      });
      pathInput.value = item.path;
      pathInput.disabled = interactionLocked;
      const pathStateEl = pathField.createDiv({
        cls: "ss-studio-note-selector-path-state",
      });
      const syncPathState = (): void => {
        const state: { tone: StudioNotePathStateTone; message: string } =
          resolveStudioNotePathState(item.path);
        pathStateEl.setText(state.message);
        pathStateEl.classList.toggle("is-ready", state.tone === "ready");
        pathStateEl.classList.toggle("is-invalid", state.tone === "invalid");
      };
      syncPathState();
      pathInput.addEventListener("input", () => {
        item.path = pathInput.value;
        syncCardIndex();
        syncPathState();
        emitChange({ mode: "continuous" });
      });

      const browseButtonEl = pathRow.createEl("button", {
        cls: "ss-studio-node-inline-config-path-button ss-studio-path-browse-button",
        attr: {
          "aria-label": "Browse files",
          title: "Browse files",
        },
      });
      browseButtonEl.type = "button";
      browseButtonEl.disabled = interactionLocked;
      appendStudioPathBrowseButtonIcon(
        browseButtonEl,
        "ss-studio-node-inline-config-path-button-icon ss-studio-path-browse-button-icon"
      );
      browseButtonEl.createSpan({
        cls: "ss-studio-node-inline-config-path-button-label ss-studio-path-browse-button-label",
        text: "Browse",
      });
      bindActionButton(browseButtonEl, async () => {
        const browseField: StudioNodeConfigFieldDefinition = {
          key: field.key,
          label: field.label,
          type: "file_path",
          accept: ".md,text/markdown",
        };
        const selected = await browseForNodeConfigPath(browseField);
        if (!selected) {
          return;
        }
        item.path = selected;
        pathInput.value = selected;
        syncCardIndex();
        syncPathState();
        emitChange({ mode: "discrete" });
      });
    }
    updateSummary();
  };

  bindActionButton(addButton, () => {
    items.push({ path: "", enabled: true });
    renderItems();
    emitChange({ mode: "discrete" });
  });

  renderItems();
  updateSummary();
}

function renderInlineConfigPathField(options: {
  node: StudioNodeInstance;
  field: StudioNodeConfigFieldDefinition;
  fieldEl: HTMLElement;
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
}): void {
  const { node, field, fieldEl, interactionLocked, onNodeConfigMutated, onNodeConfigValueChange } = options;
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
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: inputEl.value,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "continuous" },
    });
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
  appendStudioPathBrowseButtonIcon(
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
    commitInlineConfigValueChange({
      node,
      key: field.key,
      value: selected,
      onNodeConfigMutated,
      onNodeConfigValueChange,
      mutationOptions: { mode: "discrete" },
    });
  });
}

export function renderInlineConfigPanel(options: {
  nodeEl: HTMLElement;
  node: StudioNodeInstance;
  definition: StudioNodeDefinition;
  orderedFieldKeys: string[];
  interactionLocked: boolean;
  onNodeConfigMutated: (node: StudioNodeInstance) => void;
  onNodeConfigValueChange?: (
    nodeId: string,
    key: string,
    value: StudioJsonValue,
    options?: StudioGraphNodeMutationOptions
  ) => void;
  panelClassName?: string;
  hiddenFieldKeys?: Set<string>;
  compactTextareaFieldKeys?: Set<string>;
  showFieldHelp?: boolean;
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
    onNodeConfigValueChange,
    panelClassName,
    hiddenFieldKeys,
    compactTextareaFieldKeys,
    showFieldHelp = true,
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
  const handleNodeConfigValueChange = onNodeConfigValueChange
    ? (
        nodeId: string,
        key: string,
        value: StudioJsonValue,
        mutationOptions?: StudioGraphNodeMutationOptions
      ): void => {
        onNodeConfigValueChange(nodeId, key, value, mutationOptions);
        refreshVisibilityState();
      }
    : undefined;
  let renderedAnyField = false;

  for (const field of fields) {
    if (hiddenFieldKeys?.has(field.key)) {
      continue;
    }
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

    if (showFieldHelp && field.description) {
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
        onNodeConfigValueChange: handleNodeConfigValueChange,
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
        onNodeConfigValueChange: handleNodeConfigValueChange,
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
        onNodeConfigValueChange: handleNodeConfigValueChange,
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
        compactSingleRow: compactTextareaFieldKeys?.has(field.key) === true,
        onNodeConfigMutated: handleNodeConfigMutated,
        onNodeConfigValueChange: handleNodeConfigValueChange,
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
        onNodeConfigValueChange: handleNodeConfigValueChange,
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
        onNodeConfigValueChange: handleNodeConfigValueChange,
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
        onNodeConfigValueChange: handleNodeConfigValueChange,
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
        onNodeConfigValueChange: handleNodeConfigValueChange,
      });
      renderedAnyField = true;
      continue;
    }
    if (field.type === "note_selector") {
      renderInlineConfigNoteSelectorField({
        node,
        field,
        fieldEl,
        interactionLocked,
        onNodeConfigMutated: handleNodeConfigMutated,
        onNodeConfigValueChange: handleNodeConfigValueChange,
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

