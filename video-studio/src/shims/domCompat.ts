type CreateOptions = {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean>;
  [key: string]: unknown;
};

const normalizeClasses = (value: string | string[]): string[] =>
  (Array.isArray(value) ? value : [value])
    .flatMap((token) => token.split(/\s+/))
    .map((token) => token.trim())
    .filter(Boolean);

declare global {
  interface HTMLElement {
    createDiv(options?: string | CreateOptions): HTMLDivElement;
    createSpan(options?: string | CreateOptions): HTMLSpanElement;
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      options?: string | CreateOptions
    ): HTMLElementTagNameMap[K];
    empty(): void;
    addClass(...classes: string[]): void;
    removeClass(...classes: string[]): void;
    toggleClass(className: string | string[], value?: boolean): void;
    setText(text: string): void;
    setAttr(name: string, value: string): void;
    setAttrs(attrs: Record<string, string | number | boolean>): void;
  }

  var createDiv: (options?: string | CreateOptions) => HTMLDivElement;
  var createSpan: (options?: string | CreateOptions) => HTMLSpanElement;
}

const applyNativeOption = (el: HTMLElement, name: string, value: unknown): void => {
  if (value === undefined || value === null) {
    return;
  }

  if (name in el) {
    try {
      (el as unknown as Record<string, unknown>)[name] = value;
      return;
    } catch {}
  }

  if (typeof value === "boolean") {
    if (value) {
      el.setAttribute(name, "");
    } else {
      el.removeAttribute(name);
    }
    return;
  }

  el.setAttribute(name, String(value));
};

const applyOptions = <T extends HTMLElement>(
  el: T,
  options?: string | CreateOptions
): T => {
  if (!options) {
    return el;
  }

  if (typeof options === "string") {
    el.className = options;
    return el;
  }

  if (options.cls) {
    const classes = normalizeClasses(options.cls);
    if (classes.length > 0) {
      el.classList.add(...classes);
    }
  }

  if (typeof options.text === "string") {
    el.textContent = options.text;
  }

  if (options.attr) {
    for (const [name, value] of Object.entries(options.attr)) {
      applyNativeOption(el, name, value);
    }
  }

  for (const [name, value] of Object.entries(options)) {
    if (name === "cls" || name === "text" || name === "attr") {
      continue;
    }
    applyNativeOption(el, name, value);
  }

  return el;
};

const createChild = <K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  options?: string | CreateOptions
): HTMLElementTagNameMap[K] => {
  const el = applyOptions(document.createElement(tag), options);
  parent.appendChild(el);
  return el;
};

let installed = false;

export const ensureObsidianDomCompat = (): void => {
  if (installed || typeof window === "undefined") {
    return;
  }

  installed = true;

  HTMLElement.prototype.createDiv = function createDiv(
    options?: string | CreateOptions
  ): HTMLDivElement {
    return createChild(this, "div", options);
  };

  HTMLElement.prototype.createSpan = function createSpan(
    options?: string | CreateOptions
  ): HTMLSpanElement {
    return createChild(this, "span", options);
  };

  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: string | CreateOptions
  ): HTMLElementTagNameMap[K] {
    return createChild(this, tag, options);
  };

  HTMLElement.prototype.empty = function empty(): void {
    this.innerHTML = "";
  };

  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    if (classes.length > 0) {
      this.classList.add(...classes);
    }
  };

  HTMLElement.prototype.removeClass = function removeClass(...classes: string[]): void {
    if (classes.length > 0) {
      this.classList.remove(...classes);
    }
  };

  HTMLElement.prototype.toggleClass = function toggleClass(
    className: string | string[],
    value?: boolean
  ): void {
    const classNames = normalizeClasses(className);
    if (classNames.length === 0) {
      return;
    }

    if (typeof value === "boolean") {
      classNames.forEach((token) => this.classList.toggle(token, value));
      return;
    }

    classNames.forEach((token) => this.classList.toggle(token));
  };

  HTMLElement.prototype.setText = function setText(text: string): void {
    this.textContent = text;
  };

  HTMLElement.prototype.setAttr = function setAttr(name: string, value: string): void {
    applyNativeOption(this, name, value);
  };

  HTMLElement.prototype.setAttrs = function setAttrs(
    attrs: Record<string, string | number | boolean>
  ): void {
    for (const [name, value] of Object.entries(attrs)) {
      applyNativeOption(this, name, value);
    }
  };

  globalThis.createDiv = (options?: string | CreateOptions) =>
    applyOptions(document.createElement("div"), options);
  globalThis.createSpan = (options?: string | CreateOptions) =>
    applyOptions(document.createElement("span"), options);
};
