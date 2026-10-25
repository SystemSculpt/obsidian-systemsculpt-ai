type PointerListenerType = "pointermove" | "pointerup" | "pointercancel";
type PointerListenerWindow = {
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
};

export function createElementStub(): HTMLElement {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const stub = {
    ...(typeof document !== "undefined" ? { ownerDocument: document } : {}),
    style,
    setCssStyles: (styles: Record<string, string>) => {
      Object.assign(style, styles);
    },
    setCssProps: (styles: Record<string, string>) => {
      Object.entries(styles).forEach(([name, value]) => {
        style[name] = value;
      });
    },
    setText: (text: string) => {
      (stub as any).textContent = text;
    },
    classList: {
      add: (...tokens: string[]) => {
        for (const token of tokens) {
          classes.add(token);
        }
      },
      remove: (...tokens: string[]) => {
        for (const token of tokens) {
          classes.delete(token);
        }
      },
      contains: (token: string) => classes.has(token),
      toggle: (token: string, force?: boolean) => {
        if (force === true) {
          classes.add(token);
          return true;
        }
        if (force === false) {
          classes.delete(token);
          return false;
        }
        if (classes.has(token)) {
          classes.delete(token);
          return false;
        }
        classes.add(token);
        return true;
      },
    },
  };
  return stub as unknown as HTMLElement;
}

export function installWindowPointerListenerHarness(): {
  emit: (type: PointerListenerType, event: PointerEvent) => void;
  has: (type: PointerListenerType) => boolean;
  restore: () => void;
} {
  const hadWindow = typeof window !== "undefined";
  const windowRef: PointerListenerWindow = hadWindow ? window : {};
  const originalAdd = windowRef.addEventListener;
  const originalRemove = windowRef.removeEventListener;
  const listeners = new Map<string, EventListener>();

  windowRef.addEventListener = (type, listener) => {
    if (typeof listener === "function") {
      listeners.set(String(type), listener);
    }
  };
  windowRef.removeEventListener = (type, listener) => {
    if (typeof listener !== "function") {
      return;
    }
    const key = String(type);
    if (listeners.get(key) === listener) {
      listeners.delete(key);
    }
  };

  if (!hadWindow) {
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: windowRef });
  }
  return {
    emit: (type, event) => {
      const listener = listeners.get(type);
      if (!listener) {
        throw new Error(`Missing listener for ${type}`);
      }
      listener(event);
    },
    has: (type) => listeners.has(type),
    restore: () => {
      if (originalAdd) {
        windowRef.addEventListener = originalAdd;
      } else {
        delete windowRef.addEventListener;
      }
      if (originalRemove) {
        windowRef.removeEventListener = originalRemove;
      } else {
        delete windowRef.removeEventListener;
      }
      if (!hadWindow) {
        Reflect.deleteProperty(globalThis, "window");
      }
    },
  };
}
