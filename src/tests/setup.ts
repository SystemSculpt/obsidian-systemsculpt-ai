// Common Jest setup for non-embeddings tests

// Provide a minimal window with timer APIs that delegate to global timers
// so Jest's fake timers control both global and window timers consistently.
const g: any = globalThis as any;
try {
  const { TextDecoder, TextEncoder } = require('util');
  if (typeof g.TextDecoder === 'undefined') g.TextDecoder = TextDecoder;
  if (typeof g.TextEncoder === 'undefined') g.TextEncoder = TextEncoder;
  if (typeof g.window !== 'undefined') {
    if (typeof g.window.TextDecoder === 'undefined') g.window.TextDecoder = TextDecoder;
    if (typeof g.window.TextEncoder === 'undefined') g.window.TextEncoder = TextEncoder;
  }
} catch (_) {
  // util may be unavailable; ignore in that case
}

try {
  if (typeof g.Blob !== "undefined" && typeof g.Blob.prototype.arrayBuffer !== "function") {
    g.Blob.prototype.arrayBuffer = async function () {
      if (typeof this.text === "function") {
        const text = await this.text();
        const buf = Buffer.from(text);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      const buf = Buffer.from("");
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    };
  }
} catch (_) {
  // Blob may be unavailable; ignore in that case
}

if (typeof g.Headers === "undefined") {
  class SimpleHeaders {
    private map: Map<string, string>;

    constructor(init?: Record<string, string>) {
      this.map = new Map<string, string>();
      if (init && typeof init === "object") {
        Object.entries(init).forEach(([key, value]) => {
          this.set(key, value);
        });
      }
    }

    set(name: string, value: string) {
      this.map.set(name.toLowerCase(), String(value));
    }

    get(name: string) {
      return this.map.get(name.toLowerCase()) ?? null;
    }
  }

  g.Headers = SimpleHeaders;
}

if (typeof g.Response === "undefined") {
  class SimpleResponse {
    status: number;
    statusText: string;
    headers: InstanceType<typeof g.Headers>;
    private body: any;

    constructor(body: any = "", init?: { status?: number; statusText?: string; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.statusText = init?.statusText ?? "";
      this.headers = new g.Headers(init?.headers);
    }

    get ok() {
      return this.status >= 200 && this.status < 300;
    }

    async text() {
      return typeof this.body === "string" ? this.body : JSON.stringify(this.body ?? "");
    }

    async json() {
      return typeof this.body === "string" ? JSON.parse(this.body || "{}") : this.body;
    }
  }

  g.Response = SimpleResponse;
}
const realSetTimeout = globalThis.setTimeout.bind(globalThis) as typeof setTimeout;
const realClearTimeout = globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout;
const realSetInterval = globalThis.setInterval.bind(globalThis) as typeof setInterval;
const realClearInterval = globalThis.clearInterval.bind(globalThis) as typeof clearInterval;

if (typeof g.window === 'undefined') {
  g.window = {} as any;
}
g.window.setTimeout = realSetTimeout;
g.window.clearTimeout = realClearTimeout;

export {};
g.window.setInterval = realSetInterval;
g.window.clearInterval = realClearInterval;

// Default to real timers; tests opt-in to fake timers when needed
jest.useRealTimers();

if (!process.env.SYSTEMSCULPT_TEST_DEBUG) {
  jest.spyOn(global.console, 'log').mockImplementation(() => {});
  jest.spyOn(global.console, 'debug').mockImplementation(() => {});
}


// Obsidian DOM helper polyfills for JSDOM
const ensureObsidianDomHelpers = () => {
  const proto = (g.window as any).HTMLElement?.prototype as any;
  if (!proto) return;

  const applyClasses = (el: HTMLElement, cls: string | string[] | undefined) => {
    if (!cls) return;
    const classes = Array.isArray(cls) ? cls : `${cls}`.split(/\s+/);
    classes.filter(Boolean).forEach((c) => el.classList.add(c));
  };

  if (!proto.addClass) {
    proto.addClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`
            .split(/\s+/)
            .filter(Boolean)
            .forEach((c) => this.classList.add(c));
        });
      return this;
    };
  }

  if (!proto.removeClass) {
    proto.removeClass = function (...classes: any[]) {
      classes
        .flat()
        .filter(Boolean)
        .forEach((cls: string) => {
          `${cls}`
            .split(/\s+/)
            .filter(Boolean)
            .forEach((c) => this.classList.remove(c));
        });
      return this;
    };
  }

  if (!proto.toggleClass) {
    proto.toggleClass = function (cls: string, force?: boolean) {
      this.classList.toggle(cls, force === undefined ? undefined : !!force);
      return this;
    };
  }

  if (!proto.hasClass) {
    proto.hasClass = function (cls: string) {
      return this.classList.contains(cls);
    };
  }

  if (!proto.setText) {
    proto.setText = function (text: string) {
      this.textContent = text ?? "";
      return this;
    };
  }

  if (!proto.setAttr) {
    proto.setAttr = function (name: string, value: any) {
      if (value === null || value === undefined || value === false) {
        this.removeAttribute(name);
      } else if (value === true) {
        this.setAttribute(name, "");
      } else {
        this.setAttribute(name, `${value}`);
      }
      return this;
    };
  }

  if (!proto.setAttrs) {
    proto.setAttrs = function (attrs: Record<string, any>) {
      if (!attrs || typeof attrs !== "object") {
        return this;
      }
      Object.entries(attrs).forEach(([name, value]) => {
        this.setAttr(name, value);
      });
      return this;
    };
  }

  if (!proto.empty) {
    proto.empty = function () {
      while (this.firstChild) {
        this.removeChild(this.firstChild);
      }
      return this;
    };
  }

  if (!proto.toggle) {
    proto.toggle = function (value?: boolean) {
      if (typeof value === "boolean") {
        this.style.display = value ? "" : "none";
      } else {
        this.style.display = this.style.display === "none" ? "" : "none";
      }
      return this;
    };
  }

  if (!proto.createEl) {
    proto.createEl = function (tag: string, options?: any) {
      const normalized = typeof options === "string" ? { cls: options } : options ?? {};
      const el = (this.ownerDocument ?? document).createElement(tag);
      applyClasses(el, normalized.cls);
      if (normalized.text !== undefined) {
        el.textContent = `${normalized.text}`;
      }
      if (normalized.attr) {
        Object.entries(normalized.attr).forEach(([key, value]) => {
          el.setAttr(key, value as any);
        });
      }
      if (normalized.value !== undefined && "value" in el) {
        (el as any).value = normalized.value;
      }
      this.appendChild(el);
      return el;
    };
  }

  if (!proto.createDiv) {
    proto.createDiv = function (options?: any) {
      return this.createEl("div", options);
    };
  }

  if (!proto.createSpan) {
    proto.createSpan = function (options?: any) {
      return this.createEl("span", options);
    };
  }

  if (!proto.createFragment) {
    proto.createFragment = function () {
      const fragment = (this.ownerDocument ?? document).createDocumentFragment();
      this.appendChild(fragment);
      return fragment;
    };
  }

  if (!proto.appendText) {
    proto.appendText = function (text: string) {
      const textNode = (this.ownerDocument ?? document).createTextNode(text ?? "");
      this.appendChild(textNode);
      return this;
    };
  }
};

ensureObsidianDomHelpers();
