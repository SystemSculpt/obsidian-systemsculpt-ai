// Type augmentation for convenience methods provided by Obsidian's DOM utility layer
// This file is picked up automatically by TypeScript via the `include` pattern in tsconfig.json

import 'obsidian';

/**
 * Obsidian's DOM helper wraps standard elements with helpful shorthand
 * methods (createEl, addClass, etc.).  They are injected at runtime, so we
 * augment the TypeScript typings here to keep the compiler happy.
 */
declare global {
  interface Element {
    /** Create a child element with Obsidian-style options support */
    createEl<K extends keyof HTMLElementTagNameMap>(tag: K, options?: string | Partial<Record<string, any>>): HTMLElementTagNameMap[K];
    /** Add CSS class(es) */
    addClass(cls: string): this;
    /** Remove CSS class(es) */
    removeClass(cls: string): this;
    /** Set attribute helper */
    setAttr(attr: string, value: string): this;
    /** Obsidian helper to create a <div> */
    createDiv(opts?: string | Partial<Record<string, any>>): HTMLDivElement;
    /** Obsidian helper to create a <span> */
    createSpan(opts?: string | Partial<Record<string, any>>): HTMLSpanElement;
    /** Remove all child nodes */
    empty(): this;
    /** Toggle class presence */
    toggleClass(cls: string, force?: boolean): this;
  }

  // NodeJS namespace – minimal subset we actually use
  // (Only Timeout is referenced in browser code for setTimeout typings.)
  namespace NodeJS {
    interface Timeout {
      /** Node uses .ref()/.unref() but browsers polyfill with number IDs */
      ref?(): void;
      unref?(): void;
    }
  }
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export {};