type PointerListenerType = "pointermove" | "pointerup" | "pointercancel";

export function createElementStub(): HTMLElement {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  return {
    style,
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
  } as unknown as HTMLElement;
}

export function installWindowPointerListenerHarness(): {
  emit: (type: PointerListenerType, event: PointerEvent) => void;
  has: (type: PointerListenerType) => boolean;
  restore: () => void;
} {
  const globalRef = globalThis as { window?: Record<string, unknown> };
  const hadWindow = Boolean(globalRef.window);
  const windowRef = (globalRef.window || {}) as {
    addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
    removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  };
  const originalAdd = windowRef.addEventListener;
  const originalRemove = windowRef.removeEventListener;
  const listeners = new Map<string, EventListener>();

  windowRef.addEventListener = (type, listener) => {
    if (typeof listener === "function") {
      listeners.set(String(type), listener as EventListener);
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

  globalRef.window = windowRef as unknown as Record<string, unknown>;
  return {
    emit: (type, event) => {
      const listener = listeners.get(type);
      if (!listener) {
        throw new Error(`Missing listener for ${type}`);
      }
      listener(event as unknown as Event);
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
        delete globalRef.window;
      }
    },
  };
}
