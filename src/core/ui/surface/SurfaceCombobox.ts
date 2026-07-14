import { getSurfaceOwnerDocument, getSurfaceOwnerWindow } from "./SurfaceDomContext";

export type SurfaceComboboxNavigation = "clamp" | "wrap";
export type SurfaceComboboxActiveMode = "first" | "none" | "selected";
export type SurfaceComboboxCommitEvent = "click" | "pointerdown";
export type SurfaceComboboxFocusMode = "input" | "options";
export type SurfaceComboboxOptionActivationEvent = "pointermove" | "mouseenter" | false;

export interface SurfaceComboboxCollectionUpdate {
  preserveActive?: boolean;
  preserveFocus?: boolean;
  preserveScroll?: boolean;
}

export interface SurfaceComboboxStateOptions {
  busy?: boolean;
  open?: boolean;
  retainListboxRole?: boolean;
}

export interface SurfaceComboboxRenderContext<T> {
  item: T;
  index: number;
  query: string;
  optionId: string;
  listbox: HTMLElement;
  ownerDocument: Document;
}

export interface SurfaceComboboxEmptyContext {
  query: string;
  listbox: HTMLElement;
  ownerDocument: Document;
}

export interface SurfaceComboboxCommitContext<T> {
  item: T;
  index: number;
  event: Event;
}

export interface SurfaceComboboxOptions<T> {
  input: HTMLInputElement;
  listbox: HTMLElement;
  getItemKey: (item: T) => string;
  filterItems: (items: readonly T[], query: string) => readonly T[];
  renderOption: (context: SurfaceComboboxRenderContext<T>) => HTMLElement;
  onCommit: (context: SurfaceComboboxCommitContext<T>) => void | Promise<void>;
  renderEmpty?: (context: SurfaceComboboxEmptyContext) => void;
  isSelected?: (item: T) => boolean;
  listboxId?: string;
  listboxLabel?: string;
  initiallyOpen?: boolean;
  activeMode?: SurfaceComboboxActiveMode;
  navigation?: SurfaceComboboxNavigation;
  selectionFollowsActive?: boolean;
  activeClass?: string;
  selectedClass?: string;
  optionCommitEvent?: SurfaceComboboxCommitEvent;
  optionActivationEvent?: SurfaceComboboxOptionActivationEvent;
  focusMode?: SurfaceComboboxFocusMode;
  returnInputOnFirstArrowUp?: boolean;
  closeOnCommit?: boolean;
  bindInputEvents?: boolean;
  focusTargetAfterClose?: HTMLElement | (() => HTMLElement | null);
  scrollBehavior?: ScrollBehavior;
  onEscape?: () => void;
  onOpenChange?: (open: boolean) => void;
  onResultsChange?: (items: readonly T[], query: string) => void;
  onRender?: () => void;
}

type RegisteredOptionListener = {
  element: HTMLElement;
  type: string;
  listener: EventListener;
};

type CollectionSnapshot = {
  activeKey: string | null;
  hadOptionFocus: boolean;
  preserveScroll: boolean;
  scrollTop: number;
};

let nextComboboxId = 0;

/**
 * Headless combobox state and interaction interface.
 *
 * Feature adapters retain complete control over markup and presentation while
 * this class owns the easy-to-drift behavior: stable relationships, filtering,
 * active option state, keyboard and pointer navigation, focus, scrolling, and
 * teardown. Both elements must belong to the same Obsidian document so popout
 * windows never fall back to the plugin's primary browser realm.
 */
export class SurfaceCombobox<T> {
  public readonly input: HTMLInputElement;
  public readonly listbox: HTMLElement;
  public readonly listboxId: string;
  public readonly ownerDocument: Document;
  public readonly ownerWindow: Window;

  private readonly options: SurfaceComboboxOptions<T>;
  private readonly optionIdByKey = new Map<string, string>();
  private optionListeners: RegisteredOptionListener[] = [];
  private optionElements: HTMLElement[] = [];
  private sourceItems: readonly T[] = [];
  private visibleItems: readonly T[] = [];
  private query = "";
  private currentActiveIndex = -1;
  private open: boolean;
  private busy = false;
  private destroyed = false;
  private nextOptionId = 0;

  private readonly handleInput = (): void => {
    this.setQuery(this.input.value, { writeInput: false });
  };

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (this.destroyed) return;

    if (event.key === "Escape") {
      if (!this.open) return;
      this.consumeKey(event);
      this.setOpen(false);
      this.options.onEscape?.();
      this.focusTarget(this.options.focusTargetAfterClose);
      return;
    }

    if (!this.open) return;

    if ((this.options.focusMode ?? "input") === "options") {
      if (event.key !== "ArrowDown" || this.visibleItems.length === 0) return;
      this.consumeKey(event);
      this.setActiveIndex(0);
      this.focusActiveOption();
      return;
    }

    if (event.key === "ArrowDown") {
      this.consumeKey(event);
      this.moveActive(1);
      return;
    }

    if (event.key === "ArrowUp") {
      this.consumeKey(event);
      this.moveActive(-1);
      return;
    }

    if (event.key === "Home") {
      if (this.visibleItems.length === 0) return;
      this.consumeKey(event);
      this.setActiveIndex(0);
      return;
    }

    if (event.key === "End") {
      if (this.visibleItems.length === 0) return;
      this.consumeKey(event);
      this.setActiveIndex(this.visibleItems.length - 1);
      return;
    }

    if (event.key === "Enter" && this.getActiveItem() !== null) {
      this.consumeKey(event);
      this.commitActive(event);
    }
  };

  constructor(options: SurfaceComboboxOptions<T>) {
    this.options = options;
    this.input = options.input;
    this.listbox = options.listbox;
    this.ownerDocument = getSurfaceOwnerDocument(this.input);
    if (this.listbox.ownerDocument !== this.ownerDocument) {
      throw new Error("SurfaceCombobox input and listbox must share an owner document.");
    }

    this.ownerWindow = getSurfaceOwnerWindow(this.input);

    const instanceId = `ss-surface-combobox-${++nextComboboxId}`;
    this.listboxId = options.listboxId || this.listbox.id || `${instanceId}-listbox`;
    this.listbox.id = this.listboxId;
    this.open = options.initiallyOpen ?? true;

    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.setAttribute("aria-controls", this.listboxId);
    this.input.setAttribute("aria-expanded", String(this.open));
    this.input.setAttribute("aria-busy", "false");
    this.listbox.setAttribute("role", "listbox");
    this.listbox.setAttribute("aria-busy", "false");
    if (options.listboxLabel) {
      this.listbox.setAttribute("aria-label", options.listboxLabel);
    }

    if (options.bindInputEvents !== false) {
      this.input.addEventListener("input", this.handleInput);
    }
    this.input.addEventListener("keydown", this.handleKeydown);
    this.renderFilteredItems();
  }

  public get isOpen(): boolean {
    return this.open;
  }

  public get isBusy(): boolean {
    return this.busy;
  }

  public get activeIndex(): number {
    return this.currentActiveIndex;
  }

  public get items(): readonly T[] {
    return this.visibleItems;
  }

  public get activeItem(): T | null {
    return this.getActiveItem();
  }

  public setItems(
    items: readonly T[],
    update: SurfaceComboboxCollectionUpdate = {},
  ): void {
    this.assertAlive();
    const snapshot = update.preserveActive
      ? this.captureCollectionSnapshot(update)
      : null;
    this.sourceItems = Array.from(items);
    this.applyFilter(snapshot);
  }

  public setQuery(
    query: string,
    options: { writeInput?: boolean; render?: boolean } = {},
  ): void {
    this.assertAlive();
    this.query = String(query ?? "");
    if (options.writeInput !== false && this.input.value !== this.query) {
      this.input.value = this.query;
    }
    if (options.render !== false) {
      this.applyFilter();
    }
  }

  /** Re-renders feature markup while preserving the active item by stable key. */
  public refresh(): void {
    this.assertAlive();
    const activeKey = this.getActiveItemKey();
    this.visibleItems = Array.from(this.options.filterItems(this.sourceItems, this.query));
    this.currentActiveIndex = activeKey === null
      ? this.resolveInitialActiveIndex()
      : this.visibleItems.findIndex((item) => this.options.getItemKey(item) === activeKey);
    if (this.currentActiveIndex < 0) {
      this.currentActiveIndex = this.resolveInitialActiveIndex();
    }
    this.renderFilteredItems();
  }

  /** Recomputes only active/selected semantics against already-rendered options. */
  public refreshSelection(): void {
    this.assertAlive();
    this.syncOptionStates();
  }

  /** Renders a feature-owned loading/error placeholder without leaking option state. */
  public showState(
    render: (listbox: HTMLElement) => void,
    state: SurfaceComboboxStateOptions = {},
  ): void {
    this.assertAlive();
    this.currentActiveIndex = -1;
    this.visibleItems = [];
    this.removeOptionListeners();
    this.optionElements = [];
    this.listbox.replaceChildren();
    this.input.removeAttribute("aria-activedescendant");
    if (state.retainListboxRole === false) {
      this.listbox.removeAttribute("role");
    } else {
      this.listbox.setAttribute("role", "listbox");
    }
    if (state.busy !== undefined) {
      this.setBusy(state.busy);
    }
    if (state.open !== undefined) {
      this.setOpen(state.open);
    }
    render(this.listbox);
    this.options.onResultsChange?.(this.visibleItems, this.query);
    this.options.onRender?.();
  }

  public setBusy(busy: boolean): void {
    this.assertAlive();
    this.busy = busy;
    const value = String(busy);
    this.input.setAttribute("aria-busy", value);
    this.listbox.setAttribute("aria-busy", value);
  }

  public setOpen(open: boolean, options: { focus?: boolean } = {}): void {
    this.assertAlive();
    const changed = this.open !== open;
    this.open = open;
    this.input.setAttribute("aria-expanded", String(open));
    this.syncActiveDescendant();
    if (changed) {
      this.options.onOpenChange?.(open);
    }
    if (open && options.focus) {
      this.focusInput();
    }
  }

  public focusInput(): void {
    this.assertAlive();
    this.input.focus();
  }

  public setActiveIndex(index: number, options: { scroll?: boolean } = {}): void {
    this.assertAlive();
    const nextIndex = this.normalizeActiveIndex(index);
    this.currentActiveIndex = nextIndex;
    this.syncOptionStates();
    if (options.scroll !== false) {
      this.scrollActiveOptionIntoView();
    }
  }

  public clearActive(): void {
    this.assertAlive();
    this.currentActiveIndex = -1;
    this.syncOptionStates();
  }

  public destroy(): void {
    if (this.destroyed) return;
    if (this.options.bindInputEvents !== false) {
      this.input.removeEventListener("input", this.handleInput);
    }
    this.input.removeEventListener("keydown", this.handleKeydown);
    this.removeOptionListeners();
    if (this.open) {
      this.open = false;
      this.options.onOpenChange?.(false);
    }
    this.input.setAttribute("aria-expanded", "false");
    this.input.setAttribute("aria-busy", "false");
    this.input.removeAttribute("aria-activedescendant");
    this.listbox.setAttribute("aria-busy", "false");
    this.optionElements = [];
    this.visibleItems = [];
    this.sourceItems = [];
    this.destroyed = true;
  }

  private applyFilter(snapshot: CollectionSnapshot | null = null): void {
    this.visibleItems = Array.from(this.options.filterItems(this.sourceItems, this.query));
    const preservedIndex = snapshot?.activeKey
      ? this.visibleItems.findIndex(
        (item) => this.options.getItemKey(item) === snapshot.activeKey,
      )
      : -1;
    this.currentActiveIndex = preservedIndex >= 0
      ? preservedIndex
      : this.resolveInitialActiveIndex();
    this.renderFilteredItems();
    this.restoreCollectionSnapshot(snapshot, preservedIndex);
  }

  private resolveInitialActiveIndex(): number {
    if (this.visibleItems.length === 0) return -1;
    const mode = this.options.activeMode ?? "first";
    if (mode === "none") return -1;
    if (mode === "selected") {
      const selectedIndex = this.options.isSelected
        ? this.visibleItems.findIndex((item) => this.options.isSelected?.(item))
        : -1;
      return selectedIndex >= 0 ? selectedIndex : 0;
    }
    return 0;
  }

  private renderFilteredItems(): void {
    this.removeOptionListeners();
    this.optionElements = [];
    this.listbox.replaceChildren();
    this.listbox.setAttribute("role", "listbox");
    this.options.onResultsChange?.(this.visibleItems, this.query);

    if (this.visibleItems.length === 0) {
      this.input.removeAttribute("aria-activedescendant");
      this.options.renderEmpty?.({
        query: this.query,
        listbox: this.listbox,
        ownerDocument: this.ownerDocument,
      });
      this.options.onRender?.();
      return;
    }

    const keys = new Set<string>();
    this.visibleItems.forEach((item, index) => {
      const key = this.options.getItemKey(item);
      if (keys.has(key)) {
        throw new Error(`SurfaceCombobox item keys must be unique: ${key}`);
      }
      keys.add(key);

      const optionId = this.resolveOptionId(key);
      const option = this.options.renderOption({
        item,
        index,
        query: this.query,
        optionId,
        listbox: this.listbox,
        ownerDocument: this.ownerDocument,
      });
      if (option.ownerDocument !== this.ownerDocument) {
        throw new Error("SurfaceCombobox option adapter returned an element from another document.");
      }
      if (!this.listbox.contains(option)) {
        this.listbox.appendChild(option);
      }
      option.id = optionId;
      option.setAttribute("role", "option");
      if ((this.options.focusMode ?? "input") === "options") {
        option.tabIndex = -1;
      }
      this.optionElements.push(option);
      this.bindOption(option, index);
    });

    this.syncOptionStates();
    this.options.onRender?.();
  }

  private bindOption(option: HTMLElement, index: number): void {
    const activationEvent = this.options.optionActivationEvent === undefined
      ? "pointermove"
      : this.options.optionActivationEvent;
    if (activationEvent) {
      const onActivate = (): void => {
        this.setActiveIndex(index, { scroll: false });
      };
      this.registerOptionListener(option, activationEvent, onActivate);
    }

    if ((this.options.focusMode ?? "input") === "options") {
      const onFocus = (): void => {
        this.setActiveIndex(index, { scroll: false });
      };
      const onKeydown = (event: Event): void => {
        this.handleOptionKeydown(event as KeyboardEvent, index);
      };
      this.registerOptionListener(option, "focus", onFocus);
      this.registerOptionListener(option, "keydown", onKeydown);
    }

    const commitEvent = this.options.optionCommitEvent ?? "click";
    const onCommit = (event: Event): void => {
      if (commitEvent === "pointerdown") {
        event.preventDefault();
        event.stopPropagation();
      }
      this.currentActiveIndex = index;
      this.syncOptionStates();
      this.commitActive(event);
    };
    this.registerOptionListener(option, commitEvent, onCommit);

    if (commitEvent === "pointerdown") {
      const suppressClick = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      this.registerOptionListener(option, "click", suppressClick);
    }
  }

  private registerOptionListener(
    element: HTMLElement,
    type: string,
    listener: EventListener,
  ): void {
    element.addEventListener(type, listener);
    this.optionListeners.push({ element, type, listener });
  }

  private removeOptionListeners(): void {
    this.optionListeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.optionListeners = [];
  }

  private resolveOptionId(key: string): string {
    const existing = this.optionIdByKey.get(key);
    if (existing) return existing;
    const id = `${this.listboxId}-option-${++this.nextOptionId}`;
    this.optionIdByKey.set(key, id);
    return id;
  }

  private moveActive(delta: -1 | 1): void {
    const count = this.visibleItems.length;
    if (count === 0) return;

    let nextIndex: number;
    if (this.currentActiveIndex < 0) {
      nextIndex = delta > 0 ? 0 : count - 1;
    } else if ((this.options.navigation ?? "clamp") === "wrap") {
      nextIndex = (this.currentActiveIndex + delta + count) % count;
    } else {
      nextIndex = Math.max(0, Math.min(count - 1, this.currentActiveIndex + delta));
    }
    this.setActiveIndex(nextIndex);
  }

  private normalizeActiveIndex(index: number): number {
    if (this.visibleItems.length === 0 || !Number.isFinite(index)) return -1;
    return Math.max(0, Math.min(this.visibleItems.length - 1, Math.trunc(index)));
  }

  private handleOptionKeydown(event: KeyboardEvent, index: number): void {
    if (this.destroyed) return;

    if (event.key === "Escape") {
      if (!this.open) return;
      this.consumeKey(event);
      this.setOpen(false);
      this.options.onEscape?.();
      this.focusTarget(this.options.focusTargetAfterClose);
      return;
    }

    if (!this.open) return;
    if (event.key === "Enter") {
      this.consumeKey(event);
      this.currentActiveIndex = index;
      this.syncOptionStates();
      this.commitActive(event);
      return;
    }

    if (event.key === "ArrowUp"
      && index === 0
      && this.options.returnInputOnFirstArrowUp) {
      this.consumeKey(event);
      this.clearActive();
      this.focusInput();
      return;
    }

    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") {
      nextIndex = this.resolveMovedIndex(index, 1);
    } else if (event.key === "ArrowUp") {
      nextIndex = this.resolveMovedIndex(index, -1);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = this.visibleItems.length - 1;
    }
    if (nextIndex === null || nextIndex < 0) return;
    this.consumeKey(event);
    this.setActiveIndex(nextIndex);
    this.focusActiveOption();
  }

  private syncOptionStates(): void {
    this.optionElements.forEach((option, index) => {
      const active = index === this.currentActiveIndex;
      const selected = this.options.selectionFollowsActive
        ? active
        : Boolean(this.options.isSelected?.(this.visibleItems[index]));
      option.classList.toggle(this.options.activeClass ?? "is-active", active);
      if (this.options.selectedClass) {
        option.classList.toggle(this.options.selectedClass, selected);
      }
      option.setAttribute("aria-selected", String(selected));
    });
    this.syncActiveDescendant();
  }

  private syncActiveDescendant(): void {
    const active = this.open ? this.optionElements[this.currentActiveIndex] : null;
    if (active?.id) {
      this.input.setAttribute("aria-activedescendant", active.id);
    } else {
      this.input.removeAttribute("aria-activedescendant");
    }
  }

  private scrollActiveOptionIntoView(): void {
    const active = this.optionElements[this.currentActiveIndex] as HTMLElement & {
      scrollIntoView?: (options?: ScrollIntoViewOptions) => void;
    };
    const requestedBehavior = this.options.scrollBehavior ?? "auto";
    const reducedMotion = requestedBehavior === "smooth"
      && this.ownerWindow.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    active?.scrollIntoView?.({
      block: "nearest",
      behavior: reducedMotion ? "auto" : requestedBehavior,
    });
  }

  private focusActiveOption(preventScroll = true): void {
    const option = this.optionElements[this.currentActiveIndex];
    if (!option) return;
    try {
      option.focus({ preventScroll });
    } catch {
      option.focus();
    }
  }

  private resolveMovedIndex(index: number, delta: -1 | 1): number {
    const count = this.visibleItems.length;
    if (count === 0) return -1;
    if ((this.options.navigation ?? "clamp") === "wrap") {
      return (index + delta + count) % count;
    }
    return Math.max(0, Math.min(count - 1, index + delta));
  }

  private captureCollectionSnapshot(
    update: SurfaceComboboxCollectionUpdate,
  ): CollectionSnapshot {
    const activeElement = this.ownerDocument.activeElement;
    const hadOptionFocus = update.preserveFocus === true
      && this.optionElements.some(
        (option) => option === activeElement || option.contains(activeElement),
      );
    return {
      activeKey: this.getActiveItemKey(),
      hadOptionFocus,
      preserveScroll: update.preserveScroll === true,
      scrollTop: this.listbox.scrollTop,
    };
  }

  private restoreCollectionSnapshot(
    snapshot: CollectionSnapshot | null,
    preservedIndex: number,
  ): void {
    if (!snapshot) return;
    if (snapshot.preserveScroll) {
      this.listbox.scrollTop = snapshot.scrollTop;
    }
    if (!snapshot.hadOptionFocus) return;
    if (preservedIndex >= 0) {
      this.focusActiveOption(true);
      return;
    }
    this.clearActive();
    try {
      this.input.focus({ preventScroll: true });
    } catch {
      this.input.focus();
    }
  }

  private commitActive(event: Event): void {
    const item = this.getActiveItem();
    if (item === null) return;
    const index = this.currentActiveIndex;
    void this.options.onCommit({ item, index, event });
    if (this.options.closeOnCommit) {
      this.setOpen(false);
    }
    this.focusTarget(this.options.focusTargetAfterClose);
  }

  private getActiveItem(): T | null {
    return this.currentActiveIndex >= 0
      ? this.visibleItems[this.currentActiveIndex] ?? null
      : null;
  }

  private getActiveItemKey(): string | null {
    const item = this.getActiveItem();
    return item === null ? null : this.options.getItemKey(item);
  }

  private focusTarget(target: HTMLElement | (() => HTMLElement | null) | undefined): void {
    const element = typeof target === "function" ? target() : target;
    if (element?.ownerDocument === this.ownerDocument) {
      element.focus();
    }
  }

  private consumeKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error("SurfaceCombobox has been destroyed.");
    }
  }
}
