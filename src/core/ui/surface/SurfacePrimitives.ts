import { setIcon } from "obsidian";

export type UiActionTone = "default" | "primary" | "danger" | "warning";
export type UiActionSize = "default" | "small" | "icon";

export interface UiActionOptions {
  label: string;
  icon?: string;
  tone?: UiActionTone;
  size?: UiActionSize;
  disabled?: boolean;
  selected?: boolean;
  busy?: boolean;
  title?: string;
  onSelect?: (event: MouseEvent) => void;
}

export interface UiActionState {
  label?: string;
  icon?: string | null;
  disabled?: boolean;
  selected?: boolean;
  busy?: boolean;
  title?: string;
}

export interface UiSearchOptions {
  label?: string;
  placeholder: string;
  value?: string;
  onQuery: (query: string) => void;
}

export interface UiSearchHandle {
  root: HTMLElement;
  input: HTMLInputElement;
  clear(): void;
  setValue(value: string): void;
  destroy(): void;
}

export type UiStateKind = "empty" | "loading" | "error" | "success" | "info";

export interface UiStateOptions {
  kind: UiStateKind;
  title: string;
  detail?: string;
  icon?: string;
  action?: UiActionOptions;
}

const ACTION_TONE_CLASS: Record<UiActionTone, string | undefined> = {
  default: undefined,
  primary: "ss-button--primary",
  danger: "ss-button--danger",
  warning: "mod-warning",
};

/** Creates an accessible action with the canonical state and tone grammar. */
export function createUiAction(
  parent: HTMLElement,
  options: UiActionOptions,
): HTMLButtonElement {
  const button = parent.createEl("button");
  button.type = "button";
  button.classList.add("ss-button");
  button.dataset.ssAction = options.size ?? "default";

  const toneClass = ACTION_TONE_CLASS[options.tone ?? "default"];
  if (toneClass) {
    button.classList.add(toneClass);
  }
  if (options.size === "small") {
    button.classList.add("ss-button--small");
  } else if (options.size === "icon") {
    button.classList.add("ss-button--icon");
  }

  if (options.size === "icon") {
    button.setAttribute("aria-label", options.label);
  } else {
    button.createSpan({ cls: "ss-button__label", text: options.label });
  }

  if (options.title || options.size === "icon") {
    button.title = options.title ?? options.label;
  }
  updateUiAction(button, options);

  if (options.onSelect) {
    button.addEventListener("click", options.onSelect);
  }
  return button;
}

/** Updates an action without leaking CSS class or ARIA state grammar to callers. */
export function updateUiAction(
  button: HTMLButtonElement,
  state: UiActionState,
): void {
  const iconOnly = button.dataset.ssAction === "icon";
  const previousLabel = iconOnly
    ? button.getAttribute("aria-label") ?? ""
    : button.querySelector<HTMLElement>(".ss-button__label")?.textContent ?? "";

  if (state.label !== undefined) {
    if (iconOnly) {
      button.setAttribute("aria-label", state.label);
    } else {
      const label = button.querySelector<HTMLElement>(".ss-button__label");
      if (label) label.textContent = state.label;
    }
    if (iconOnly && (!button.title || button.title === previousLabel)) {
      button.title = state.label;
    }
  }

  if (state.icon !== undefined) {
    let icon = button.querySelector<HTMLElement>(".ss-button__icon");
    if (state.icon === null) {
      icon?.remove();
    } else {
      if (!icon) {
        icon = button.createSpan({
          cls: "ss-button__icon",
          attr: { "aria-hidden": "true" },
        });
        button.prepend(icon);
      }
      icon.replaceChildren();
      setIcon(icon, state.icon);
    }
  }

  if (state.title !== undefined) button.title = state.title;
  if (state.disabled !== undefined) button.disabled = state.disabled;
  if (state.selected !== undefined) {
    button.classList.toggle("is-selected", state.selected);
    button.setAttribute("aria-pressed", String(state.selected));
  }
  if (state.busy !== undefined) {
    button.classList.toggle("is-busy", state.busy);
    button.setAttribute("aria-busy", String(state.busy));
  }
}

/** Creates the canonical searchable text field and owns its tiny local state. */
export function createUiSearch(
  parent: HTMLElement,
  options: UiSearchOptions,
): UiSearchHandle {
  const root = parent.createDiv({ cls: "ss-search-field" });

  const searchIcon = root.createSpan({
    cls: "ss-search-field__icon",
    attr: { "aria-hidden": "true" },
  });
  setIcon(searchIcon, "search");

  const input = root.createEl("input", { cls: "ss-search-field__input" });
  input.type = "search";
  input.placeholder = options.placeholder;
  input.value = options.value ?? "";
  input.setAttribute("aria-label", options.label ?? options.placeholder);

  const clearButton = createUiAction(root, {
    label: "Clear search",
    icon: "x",
    size: "icon",
  });
  clearButton.classList.add("ss-search-field__clear");

  const syncClearButton = (): void => {
    clearButton.hidden = input.value.length === 0;
  };
  const emitQuery = (): void => {
    syncClearButton();
    options.onQuery(input.value);
  };
  const onInput = (): void => emitQuery();
  const onClear = (): void => {
    input.value = "";
    emitQuery();
    input.focus();
  };

  input.addEventListener("input", onInput);
  clearButton.addEventListener("click", onClear);
  syncClearButton();

  return {
    root,
    input,
    clear: onClear,
    setValue(value: string): void {
      input.value = value;
      emitQuery();
    },
    destroy(): void {
      input.removeEventListener("input", onInput);
      clearButton.removeEventListener("click", onClear);
      root.remove();
    },
  };
}

/** Renders a consistent loading, empty, error, success, or informational state. */
export function createUiState(
  parent: HTMLElement,
  options: UiStateOptions,
): HTMLElement {
  const root = parent.createDiv({ cls: ["ss-ui-state", `is-${options.kind}`] });
  root.setAttribute("role", options.kind === "error" ? "alert" : "status");
  root.setAttribute("aria-live", options.kind === "error" ? "assertive" : "polite");

  const icon = root.createSpan({
    cls: "ss-ui-state__icon",
    attr: { "aria-hidden": "true" },
  });
  setIcon(icon, options.icon ?? defaultStateIcon(options.kind));

  const copy = root.createDiv({ cls: "ss-ui-state__copy" });
  copy.createDiv({ cls: "ss-ui-state__title", text: options.title });
  if (options.detail) {
    copy.createDiv({ cls: "ss-ui-state__detail", text: options.detail });
  }

  if (options.action) {
    createUiAction(root, { ...options.action, size: options.action.size ?? "small" });
  }

  return root;
}

function defaultStateIcon(kind: UiStateKind): string {
  switch (kind) {
    case "loading":
      return "loader-circle";
    case "error":
      return "circle-alert";
    case "success":
      return "circle-check";
    case "info":
      return "info";
    case "empty":
      return "inbox";
  }
}
