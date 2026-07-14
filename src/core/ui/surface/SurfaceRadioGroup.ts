export interface UiRadioBinding<T extends string = string> {
  value: T;
  button: HTMLButtonElement;
}

export type UiRadioChangeSource = "click" | "keyboard" | "programmatic";

export interface UiRadioGroupOptions<T extends string = string> {
  value: T;
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  selectedClass?: string;
  onChange?: (
    value: T,
    previousValue: T,
    source: UiRadioChangeSource,
  ) => boolean | void | Promise<boolean | void>;
  onError?: (error: unknown, attemptedValue: T, previousValue: T) => void;
}

export interface UiRadioSelectOptions {
  focus?: boolean;
  source?: UiRadioChangeSource;
}

export interface UiRadioGroupHandle<T extends string = string> {
  readonly value: T;
  readonly pending: boolean;
  select(value: T, options?: UiRadioSelectOptions): Promise<boolean>;
  setValue(value: T, options?: { focus?: boolean }): void;
  setDisabled(disabled: boolean): void;
  destroy(): void;
}

let radioGroupInstance = 0;

/**
 * Owns the complete radio-group interaction contract for pre-rendered buttons:
 * stable semantics, roving focus, keyboard selection, async pending state, and
 * rollback. Product surfaces keep only their domain-specific commit callback.
 */
export function createUiRadioGroup<T extends string>(
  group: HTMLElement,
  bindings: readonly UiRadioBinding<T>[],
  options: UiRadioGroupOptions<T>,
): UiRadioGroupHandle<T> {
  if (bindings.length === 0) {
    throw new Error("Radio groups require at least one binding");
  }
  if (!bindings.some((binding) => binding.value === options.value)) {
    throw new Error(`Unknown initial radio value: ${options.value}`);
  }

  const instanceId = ++radioGroupInstance;
  const selectedClass = options.selectedClass || "is-selected";
  const listeners: Array<() => void> = [];
  let value = options.value;
  let disabled = options.disabled === true;
  let pending = false;
  let destroyed = false;
  let requestVersion = 0;

  group.setAttribute("role", "radiogroup");
  if (options.label) group.setAttribute("aria-label", options.label);
  if (options.labelledBy) group.setAttribute("aria-labelledby", options.labelledBy);

  function findBinding(nextValue: T): UiRadioBinding<T> | undefined {
    return bindings.find((binding) => binding.value === nextValue);
  }

  function sync(): void {
    if (destroyed) return;
    if (disabled) group.setAttribute("aria-disabled", "true");
    else group.removeAttribute("aria-disabled");
    if (pending) group.setAttribute("aria-busy", "true");
    else group.removeAttribute("aria-busy");
    for (const [index, binding] of bindings.entries()) {
      const selected = binding.value === value;
      binding.button.id ||= `ss-radio-${instanceId}-${index}`;
      binding.button.setAttribute("role", "radio");
      binding.button.setAttribute("aria-checked", String(selected));
      binding.button.classList.toggle(selectedClass, selected);
      binding.button.tabIndex = selected ? 0 : -1;
      binding.button.disabled = disabled || pending;
    }
  }

  async function select(
    nextValue: T,
    selectOptions: UiRadioSelectOptions = {},
  ): Promise<boolean> {
    const binding = findBinding(nextValue);
    if (!binding || destroyed || disabled || pending) return false;
    if (nextValue === value) {
      if (selectOptions.focus) binding.button.focus();
      return false;
    }

    const previousValue = value;
    const version = ++requestVersion;
    value = nextValue;
    sync();
    if (selectOptions.focus) binding.button.focus();

    try {
      const result = options.onChange?.(
        nextValue,
        previousValue,
        selectOptions.source || "programmatic",
      );
      const then = (result as unknown as { then?: unknown } | null)?.then;
      if (typeof then === "function") {
        pending = true;
        sync();
      }
      const accepted = (await result) !== false;
      if (!accepted && !destroyed && version === requestVersion) {
        value = previousValue;
      }
      return accepted;
    } catch (error) {
      if (!destroyed && version === requestVersion) {
        value = previousValue;
      }
      options.onError?.(error, nextValue, previousValue);
      return false;
    } finally {
      if (!destroyed && version === requestVersion) {
        pending = false;
        sync();
      }
    }
  }

  for (const [index, binding] of bindings.entries()) {
    const onClick = (event: MouseEvent): void => {
      event.preventDefault();
      void select(binding.value, { source: "click" });
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (disabled || pending) return;
      let nextIndex: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (index + 1) % bindings.length;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        nextIndex = (index - 1 + bindings.length) % bindings.length;
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = bindings.length - 1;
      }
      if (nextIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      const nextBinding = bindings[nextIndex];
      void select(nextBinding.value, { focus: true, source: "keyboard" });
    };
    binding.button.addEventListener("click", onClick);
    binding.button.addEventListener("keydown", onKeydown);
    listeners.push(() => {
      binding.button.removeEventListener("click", onClick);
      binding.button.removeEventListener("keydown", onKeydown);
    });
  }

  sync();

  return {
    get value(): T {
      return value;
    },
    get pending(): boolean {
      return pending;
    },
    select,
    setValue(nextValue: T, setOptions: { focus?: boolean } = {}): void {
      const binding = findBinding(nextValue);
      if (!binding || destroyed) return;
      requestVersion += 1;
      pending = false;
      value = nextValue;
      sync();
      if (setOptions.focus) binding.button.focus();
    },
    setDisabled(nextDisabled: boolean): void {
      disabled = nextDisabled;
      sync();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      requestVersion += 1;
      listeners.forEach((remove) => remove());
      listeners.length = 0;
    },
  };
}
