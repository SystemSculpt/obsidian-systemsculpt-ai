// Common Jest setup for plugin tests

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
  const { webcrypto } = require("crypto");
  if (typeof g.crypto === "undefined") g.crypto = webcrypto;
  if (typeof g.window !== "undefined" && typeof g.window.crypto === "undefined") {
    g.window.crypto = webcrypto;
  }
} catch (_) {
  // crypto may be unavailable; ignore in that case
}
const sharedWebCrypto = g.crypto;

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
if (typeof g.window === 'undefined') {
  g.window = {} as any;
}
export {};

function syncWindowTimers(win: any = g.window) {
  if (!win || win === globalThis) return;
  win.setTimeout = (...args: Parameters<typeof globalThis.setTimeout>) =>
    globalThis.setTimeout(...args);
  win.clearTimeout = (...args: Parameters<typeof globalThis.clearTimeout>) =>
    globalThis.clearTimeout(...args);
  win.setInterval = (...args: Parameters<typeof globalThis.setInterval>) =>
    globalThis.setInterval(...args);
  win.clearInterval = (...args: Parameters<typeof globalThis.clearInterval>) =>
    globalThis.clearInterval(...args);
}

function ensureWindowCrypto(win: any = g.window) {
  if (!win || !sharedWebCrypto) return;
  if (typeof g.crypto === "undefined") g.crypto = sharedWebCrypto;
  if (typeof win.crypto === "undefined" || typeof win.crypto?.subtle === "undefined") {
    try {
      Object.defineProperty(win, "crypto", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: sharedWebCrypto,
      });
    } catch (_) {
      // Some JSDOM windows expose crypto through a read-only getter.
      // Leave the native object in place when it cannot be replaced.
    }
  }
}

function ensureBase64Helpers(win: any = g.window) {
  const atobImpl = (value: string) => Buffer.from(String(value), "base64").toString("binary");
  const btoaImpl = (value: string) => Buffer.from(String(value), "binary").toString("base64");
  if (typeof g.atob !== "function") g.atob = atobImpl;
  if (typeof g.btoa !== "function") g.btoa = btoaImpl;
  if (win && typeof win.atob !== "function") win.atob = atobImpl;
  if (win && typeof win.btoa !== "function") win.btoa = btoaImpl;
}

function ensureAnimationFrameHelpers(win: any = g.window) {
  const requestImpl = (callback: FrameRequestCallback) =>
    globalThis.setTimeout(() => callback(Date.now()), 16) as unknown as number;
  const cancelImpl = (handle: number) => {
    globalThis.clearTimeout(handle);
  };
  if (typeof g.requestAnimationFrame !== "function") g.requestAnimationFrame = requestImpl;
  if (typeof g.cancelAnimationFrame !== "function") g.cancelAnimationFrame = cancelImpl;
  if (win && typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = requestImpl;
  if (win && typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = cancelImpl;
}

// Default to real timers; tests opt-in to fake timers when needed
jest.useRealTimers();

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
};

const createMemoryStorage = (): StorageLike => {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      const keys = Array.from(store.keys());
      return keys[index] ?? null;
    },
    getItem(key: string) {
      return store.get(String(key)) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    clear() {
      store.clear();
    },
  };
};

const installWebStorageShim = () => {
  // Node 25+ exposes `localStorage` on the Node global. Without `--localstorage-file`,
  // Node returns a warning-emitting Proxy. Jest's teardown touches it (via Reflect.get),
  // which creates noisy warnings that hide real test failures.
  //
  // Provide a stable in-memory storage during Jest runs. Skip in JSDOM where
  // the browser-like implementation is expected/available.
  const isJSDOM = typeof (globalThis as any).document !== "undefined";
  if (isJSDOM) return;

  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: createMemoryStorage(),
    });
  } catch (_) {}
  try {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: createMemoryStorage(),
    });
  } catch (_) {}

  try {
    if (typeof g.window !== "undefined") {
      (g.window as any).localStorage = (globalThis as any).localStorage;
      (g.window as any).sessionStorage = (globalThis as any).sessionStorage;
    }
  } catch (_) {}
};

installWebStorageShim();

const isEnvEnabled = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const strictConsole = isEnvEnabled(process.env.SYSTEMSCULPT_TEST_STRICT_CONSOLE);
const debugConsole = isEnvEnabled(process.env.SYSTEMSCULPT_TEST_DEBUG);
const consoleOriginals = {
  log: global.console.log.bind(global.console),
  debug: global.console.debug.bind(global.console),
  info: global.console.info.bind(global.console),
  warn: global.console.warn.bind(global.console),
  error: global.console.error.bind(global.console),
};
type ConsoleMethod = keyof typeof consoleOriginals;
const { format } = require("util");
const consoleMethods: ConsoleMethod[] = ["log", "debug", "info", "warn", "error"];

const applyConsolePolicy = () => {
  for (const method of consoleMethods) {
    const impl = (...args: any[]) => {
      if (strictConsole) {
        const message = args.length ? format(...args) : "";
        throw new Error(
          [
            `[tests] Unexpected console.${method} call.`,
            message ? `Message: ${message}` : "",
            "If this is expected, mock/spyon console in the test.",
            "To see console output while keeping spies, run with SYSTEMSCULPT_TEST_DEBUG=1.",
          ]
            .filter(Boolean)
            .join("\n")
        );
      }

      if (debugConsole) {
        consoleOriginals[method](...args);
      }
    };

    jest.spyOn(global.console, method).mockImplementation(impl);
  }
};

applyConsolePolicy();

// Obsidian DOM helper polyfills for JSDOM
const ensureObsidianDomHelpers = (win: any = g.window) => {
  const nodeProto = win?.Node?.prototype as any;
  const proto = win?.HTMLElement?.prototype as any;
  const fragmentProto = win?.DocumentFragment?.prototype as any;
  if (nodeProto && !nodeProto.instanceOf) {
    nodeProto.instanceOf = function (ctor: any) {
      return this instanceof ctor;
    };
  }

  const applyClasses = (el: HTMLElement, cls: string | string[] | undefined) => {
    if (!cls) return;
    const classes = Array.isArray(cls) ? cls : `${cls}`.split(/\s+/);
    classes.filter(Boolean).forEach((c) => el.classList.add(c));
  };

  const installContainerHelpers = (targetProto: any) => {
    if (!targetProto) return;

    if (!targetProto.setText) {
      targetProto.setText = function (text: string) {
        this.textContent = text ?? "";
        return this;
      };
    }

    if (!targetProto.setAttr) {
      targetProto.setAttr = function (name: string, value: any) {
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

    if (!targetProto.setAttrs) {
      targetProto.setAttrs = function (attrs: Record<string, any>) {
        if (!attrs || typeof attrs !== "object") {
          return this;
        }
        Object.entries(attrs).forEach(([name, value]) => {
          this.setAttr(name, value);
        });
        return this;
      };
    }

    if (!targetProto.empty) {
      targetProto.empty = function () {
        while (this.firstChild) {
          this.removeChild(this.firstChild);
        }
        return this;
      };
    }

    if (!targetProto.createEl) {
      targetProto.createEl = function (tag: string, options?: any) {
        const normalized = typeof options === "string" ? { cls: options } : options ?? {};
        const doc = this.ownerDocument ?? win?.document ?? g.document ?? document;
        const el = doc.createElement(tag);
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

    if (!targetProto.createDiv) {
      targetProto.createDiv = function (options?: any) {
        return this.createEl("div", options);
      };
    }

    if (!targetProto.createSpan) {
      targetProto.createSpan = function (options?: any) {
        return this.createEl("span", options);
      };
    }

    if (!targetProto.appendText) {
      targetProto.appendText = function (text: string) {
        const doc = this.ownerDocument ?? win?.document ?? g.document ?? document;
        const textNode = doc.createTextNode(text ?? "");
        this.appendChild(textNode);
        return this;
      };
    }
  };

  installContainerHelpers(proto);
  installContainerHelpers(fragmentProto);

  if (!proto) return;

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

  if (!proto.setCssStyles) {
    proto.setCssStyles = function (styles: Record<string, string>) {
      if (!styles || typeof styles !== "object") {
        return this;
      }
      Object.assign(this.style, styles);
      return this;
    };
  }

  if (!proto.setCssProps) {
    proto.setCssProps = function (styles: Record<string, string>) {
      if (!styles || typeof styles !== "object") {
        return this;
      }
      Object.entries(styles).forEach(([name, value]) => {
        this.style.setProperty(name, value);
      });
      return this;
    };
  }

  if (!proto.hide) {
    proto.hide = function () {
      this.style.display = "none";
      return this;
    };
  }

  if (!proto.show) {
    proto.show = function () {
      this.style.display = "";
      return this;
    };
  }

  if (!proto.createFragment) {
    proto.createFragment = function () {
      const fragment = (this.ownerDocument ?? win?.document ?? g.document ?? document).createDocumentFragment();
      this.appendChild(fragment);
      return fragment;
    };
  }
};

const createRootElement = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options?: { cls?: string | string[]; text?: string; attr?: Record<string, any> }
): HTMLElementTagNameMap[K] => {
  const doc = g.document ?? g.window?.document ?? document;
  const el = doc.createElement(tag);
  const normalized = typeof options === "string" ? { cls: options } : options ?? {};
  if (normalized.cls) {
    const classes = Array.isArray(normalized.cls)
      ? normalized.cls
      : `${normalized.cls}`.split(/\s+/);
    classes.filter(Boolean).forEach((cls) => el.classList.add(cls));
  }
  if (normalized.text !== undefined) {
    el.textContent = `${normalized.text}`;
  }
  if (normalized.attr) {
    Object.entries(normalized.attr).forEach(([name, value]) => {
      if (value === null || value === undefined || value === false) {
        el.removeAttribute(name);
      } else if (value === true) {
        el.setAttribute(name, "");
      } else {
        el.setAttribute(name, `${value}`);
      }
    });
  }
  return el;
};

const createRootFragment = () => {
  const doc = g.document ?? g.window?.document ?? document;
  return doc.createDocumentFragment();
};

const syncGlobalDomFactories = () => {
  (g as any).createEl = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: { cls?: string | string[]; text?: string; attr?: Record<string, any> }
  ) => createRootElement(tag, options);
  (g as any).createDiv = (options?: { cls?: string | string[]; text?: string; attr?: Record<string, any> }) =>
    createRootElement("div", options);
  (g as any).createSpan = (options?: { cls?: string | string[]; text?: string; attr?: Record<string, any> }) =>
    createRootElement("span", options);
  (g as any).createFragment = () => createRootFragment();
};

const syncRuntimeWindowGlobals = (win: any = g.window) => {
  if (win?.document) {
    g.document = win.document;
  }
  syncWindowTimers(win);
  ensureWindowCrypto(win);
  ensureBase64Helpers(win);
  ensureAnimationFrameHelpers(win);
  ensureObsidianDomHelpers(win);
  syncGlobalDomFactories();
};
syncRuntimeWindowGlobals();

beforeEach(() => {
  // Guardrails so the suite can safely run in parallel and keep tests isolated.
  // Note: this must run in `beforeEach` (not `afterEach`) so it doesn't interfere
  // with test-file `afterEach` hooks that intentionally run under fake timers.
  jest.useRealTimers();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  syncRuntimeWindowGlobals();
  applyConsolePolicy();
});
