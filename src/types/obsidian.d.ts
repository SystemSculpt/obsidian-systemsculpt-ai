// Minimal Obsidian API surface for type-checking in the browser build.
// It is **not** feature-complete – only the symbols referenced in the
// SystemSculpt codebase are declared.  Extend as required.

declare module 'obsidian' {
  /* ------------------------------------------------------------------ */
  /*  Core application scaffolding                                       */
  /* ------------------------------------------------------------------ */
  export interface App {
    workspace: any;
    vault: any;
    /** Simplified replacement for Obsidian's MetadataCache */
    metadataCache: any;
  }

  /**
   * Augment the existing Vault interface with undocumented methods
   */
  export interface Vault {
    /**
     * Undocumented method to get vault configuration values
     * @param key - Configuration key (e.g., 'userIgnoreFilters')
     * @returns Configuration value or undefined if not found
     */
    getConfig(key: string): any;
  }

  export interface WorkspaceLeaf {
    view?: any;
    /** Obsidian method to get persisted state object for this leaf */
    getViewState(): any;
    /** Set state – declaration for completeness */
    setViewState(state: any, opts?: any): Promise<void>;
  }

  /* ------------------------------------------------------------------ */
  /*  Component – base class for views / modals / managers               */
  /* ------------------------------------------------------------------ */
  export class Component {
    /**
     * Register a disposable callback – executed automatically on unload.
     */
    register(cb: () => void): void;

    /**
     * Register a DOM event listener that is automatically removed on unload.
     */
    registerDomEvent<T extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: T,
      listener: (this: HTMLElement, ev: HTMLElementEventMap[T]) => any,
      options?: boolean | AddEventListenerOptions
    ): void;

    /** Clean-up hook */
    unload(): void;
  }

  /* ------------------------------------------------------------------ */
  /*  ItemView – dockable workspace pane                                 */
  /* ------------------------------------------------------------------ */
  export abstract class ItemView extends Component {
    constructor(leaf: WorkspaceLeaf);

    app: App;
    leaf: WorkspaceLeaf;

    /** Unique string identifying the view type */
    abstract getViewType(): string;

    /** Human-readable name for the tab header */
    abstract getDisplayText(): string;

    /** Lifecycle hooks (optional) */
    onOpen?(): Promise<void> | void;
    onClose?(): Promise<void> | void;
  }

  /* ------------------------------------------------------------------ */
  /*  Frequently used helper classes / utilities                         */
  /* ------------------------------------------------------------------ */
  export interface TFile {
    path: string;
    basename: string;
    extension: string;
  }

  export class ButtonComponent {
    constructor(container: HTMLElement);
    setButtonText(text: string): this;
    setIcon(icon: string): this;
    setTooltip(text: string): this;
    setClass(cls: string): this;
    setWarning(): this;
    setCta(): this;
    setDisabled(disabled: boolean): this;
    onClick(callback: (evt: MouseEvent) => void): this;
    readonly buttonEl: HTMLElement;
  }

  export class Notice {
    constructor(message: string, timeout?: number);
  }

  export class Modal extends Component {
    readonly contentEl: HTMLElement;
    open(): void;
    close(): void;
  }

  export function setIcon(el: HTMLElement, icon: string): void;

  export namespace MarkdownRenderer {
    function render(
      app: App,
      markdown: string,
      container: HTMLElement,
      sourcePath: string,
      component: Component
    ): Promise<void>;
  }

  /* ------------------------------------------------------------------ */
  /*  Platform helper                                                   */
  /* ------------------------------------------------------------------ */
  export const Platform: {
    isMobile?: boolean;
    isDesktopApp?: boolean;
    isMacOS?: boolean;
  };
}

export {};

/* ------------------------------------------------------------------ */
/*  DOM helper method augmentations                                    */
/* ------------------------------------------------------------------ */

interface Element {
  /** Shorthand for `document.createElement` that also appends */
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    opts?: string | Partial<Record<string, any>>
  ): HTMLElementTagNameMap[K];

  createDiv(opts?: string | Partial<Record<string, any>>): HTMLDivElement;
  createSpan(opts?: string | Partial<Record<string, any>>): HTMLSpanElement;

  addClass(cls: string): this;
  removeClass(...cls: string[]): this;
  toggleClass(cls: string, force?: boolean): this;
  setAttr(attr: string, value: string): this;
  empty(): this;
  /** Convenience wrapper to assign textContent and chain */
  setText(text: string): this;
}