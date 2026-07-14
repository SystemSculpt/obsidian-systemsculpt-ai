export interface UiTabBinding<T extends string = string> {
  id: T;
  button: HTMLButtonElement;
  panel: HTMLElement;
}

export interface UiTabsOptions<T extends string = string> {
  activeId: T;
  onChange?: (activeId: T, previousId: T) => void;
}

export interface UiTabsHandle<T extends string = string> {
  readonly activeId: T;
  activate(id: T, options?: { focus?: boolean }): void;
  destroy(): void;
}

let tabsInstance = 0;

/** Owns tab ARIA, roving focus, keyboard behavior, and selected panel state. */
export function createUiTabs<T extends string>(
  tablist: HTMLElement,
  bindings: readonly UiTabBinding<T>[],
  options: UiTabsOptions<T>,
): UiTabsHandle<T> {
  if (bindings.length === 0) {
    throw new Error("Tabs require at least one binding");
  }
  if (!bindings.some((binding) => binding.id === options.activeId)) {
    throw new Error(`Unknown initial tab: ${options.activeId}`);
  }

  const instanceId = ++tabsInstance;
  const listeners: Array<() => void> = [];
  let activeId = options.activeId;

  tablist.setAttribute("role", "tablist");
  for (const [index, binding] of bindings.entries()) {
    const stableId = String(binding.id).replace(/[^a-z0-9_-]/gi, "-");
    binding.button.id ||= `ss-tab-${instanceId}-${stableId}`;
    binding.panel.id ||= `ss-tab-panel-${instanceId}-${stableId}`;
    binding.button.setAttribute("role", "tab");
    binding.button.setAttribute("aria-controls", binding.panel.id);
    binding.panel.setAttribute("role", "tabpanel");
    binding.panel.setAttribute("aria-labelledby", binding.button.id);

    const onClick = (): void => activate(binding.id);
    const onKeydown = (event: KeyboardEvent): void => {
      const key = event.key;
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
      event.preventDefault();
      const nextIndex = key === "Home"
        ? 0
        : key === "End"
          ? bindings.length - 1
          : (index + (key === "ArrowRight" ? 1 : -1) + bindings.length) % bindings.length;
      activate(bindings[nextIndex].id, { focus: true });
    };
    binding.button.addEventListener("click", onClick);
    binding.button.addEventListener("keydown", onKeydown);
    listeners.push(() => {
      binding.button.removeEventListener("click", onClick);
      binding.button.removeEventListener("keydown", onKeydown);
    });
  }

  function sync(): void {
    for (const binding of bindings) {
      const selected = binding.id === activeId;
      binding.button.classList.toggle("is-selected", selected);
      binding.button.setAttribute("aria-selected", String(selected));
      binding.button.tabIndex = selected ? 0 : -1;
      binding.button.removeAttribute("aria-pressed");
      binding.panel.classList.toggle("is-active", selected);
      binding.panel.toggleAttribute("hidden", !selected);
    }
  }

  function activate(id: T, activateOptions: { focus?: boolean } = {}): void {
    const binding = bindings.find((candidate) => candidate.id === id);
    if (!binding) return;
    const previousId = activeId;
    activeId = id;
    sync();
    if (activateOptions.focus) binding.button.focus();
    if (id !== previousId) options.onChange?.(id, previousId);
  }

  sync();

  return {
    get activeId(): T {
      return activeId;
    },
    activate,
    destroy(): void {
      listeners.forEach((remove) => remove());
      listeners.length = 0;
    },
  };
}
