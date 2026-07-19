import { setIcon } from "obsidian";
import {
  applyPluginSurface,
  createUiAction,
  resolveSurfaceDomContext,
} from "../core/ui/surface";
import { isMobileLayout } from "../platform/mobileLayout";

export type HoverShellActionVariant = "default" | "primary" | "danger";

export interface HoverShellAction {
  id: string;
  label: string;
  icon?: string;
  variant?: HoverShellActionVariant;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}

export interface HoverShellPosition {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

export interface HoverShellOptions {
  title: string;
  subtitle?: string;
  icon?: string;
  statusText?: string;
  className?: string;
  width?: string;
  draggable?: boolean;
  defaultPosition?: HoverShellPosition;
  positionKey?: string;
  showStatusRow?: boolean;
  host?: HTMLElement;
}

export interface HoverShellHandle {
  root: HTMLElement;
  dragHandleEl: HTMLElement;
  titleEl: HTMLElement;
  subtitleEl: HTMLElement;
  statusEl: HTMLElement;
  contentEl: HTMLElement;
  headerActionsEl: HTMLElement;
  footerActionsEl: HTMLElement;
  setTitle: (title: string) => void;
  setSubtitle: (subtitle: string) => void;
  setStatus: (status: string) => void;
  setHeaderActions: (actions: HoverShellAction[]) => void;
  setFooterActions: (actions: HoverShellAction[]) => void;
  setState: (state: string) => void;
  show: () => void;
  destroy: () => void;
}

interface StoredHoverPosition {
  left: number;
  top: number;
}

const HOVER_POSITION_STORAGE_KEY = "systemsculpt:hover-shell:positions:v1";
let nextHoverShellId = 0;

const parsePx = (value?: string): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.endsWith("px")) return null;
  const parsed = Number.parseFloat(trimmed.slice(0, -2));
  return Number.isFinite(parsed) ? parsed : null;
};

const readPositionMap = (storage?: Storage): Record<string, StoredHoverPosition> => {
  if (!storage) return {};
  try {
    const raw = storage.getItem(HOVER_POSITION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoredHoverPosition>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writePositionMap = (map: Record<string, StoredHoverPosition>, storage?: Storage): void => {
  if (!storage) return;
  try {
    storage.setItem(HOVER_POSITION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore persistence failures in private/sandboxed runtimes.
  }
};

const loadStoredPosition = (positionKey: string, storage?: Storage): StoredHoverPosition | null => {
  const map = readPositionMap(storage);
  const entry = map[positionKey];
  if (!entry) return null;
  if (typeof entry.left !== "number" || typeof entry.top !== "number") return null;
  return entry;
};

const saveStoredPosition = (
  positionKey: string,
  value: StoredHoverPosition,
  storage?: Storage,
): void => {
  const map = readPositionMap(storage);
  map[positionKey] = value;
  writePositionMap(map, storage);
};

export function createHoverShell(options: HoverShellOptions): HoverShellHandle {
  const {
    host,
    window: hostWindow,
  } = resolveSurfaceDomContext(options.host);
  const storage = (() => {
    try {
      return hostWindow.localStorage;
    } catch {
      return undefined;
    }
  })();
  const root = host.createDiv();
  root.className = "ss-hover-shell";
  root.dataset.layout = "desktop";
  root.dataset.state = "idle";
  applyPluginSurface(root, "transient");
  root.setAttribute("role", "region");
  if (options.className) {
    root.classList.add(...options.className.split(/\s+/).filter(Boolean));
  }
  if (options.width) {
    root.style.width = options.width;
  }

  const header = root.createDiv();
  header.className = "ss-hover-shell__header";

  const dragHandleEl = header.createDiv();
  dragHandleEl.className = "ss-hover-shell__drag-handle";

  const iconWrap = dragHandleEl.createSpan();
  iconWrap.className = "ss-hover-shell__icon";
  if (options.icon) {
    setIcon(iconWrap, options.icon);
  } else {
    iconWrap.setAttribute("hidden", "true");
  }

  const titleStack = dragHandleEl.createDiv();
  titleStack.className = "ss-hover-shell__title-stack";

  const titleEl = titleStack.createDiv();
  titleEl.className = "ss-hover-shell__title";
  titleEl.id = `ss-hover-shell-title-${++nextHoverShellId}`;
  titleEl.textContent = options.title;
  root.setAttribute("aria-labelledby", titleEl.id);

  const subtitleEl = titleStack.createDiv();
  subtitleEl.className = "ss-hover-shell__subtitle";
  subtitleEl.textContent = options.subtitle ?? "";
  if (!options.subtitle) {
    subtitleEl.setAttribute("hidden", "true");
  }

  const headerActionsEl = header.createDiv();
  headerActionsEl.className = "ss-hover-shell__header-actions";

  const statusEl = root.createDiv();
  statusEl.className = "ss-hover-shell__status";
  statusEl.setAttrs({ role: "status", "aria-live": "polite", "aria-atomic": "true" });
  statusEl.textContent = options.statusText ?? "";
  if (options.showStatusRow === false) {
    statusEl.setAttribute("hidden", "true");
  }

  const contentEl = root.createDiv();
  contentEl.className = "ss-hover-shell__content";

  const footerActionsEl = root.createDiv();
  footerActionsEl.className = "ss-hover-shell__footer-actions";

  const unsubscribers: Array<() => void> = [];
  const recorderStackOffsetProperty = "--ss-recorder-mobile-stack-offset";
  const ownsRecorderStackOffset = root.classList.contains("ss-recorder-hover");
  let recorderStackFrame: number | null = null;
  let destroyed = false;
  const updateRecorderStackOffset = (): void => {
    recorderStackFrame = null;
    if (!ownsRecorderStackOffset) return;
    if (destroyed || !isMobileLayout(root) || !root.isConnected) {
      host.style.removeProperty(recorderStackOffsetProperty);
      return;
    }
    const height = Math.max(0, Math.ceil(root.getBoundingClientRect().height));
    host.style.setProperty(
      recorderStackOffsetProperty,
      `calc(${height}px + var(--ss-space-2))`,
    );
  };
  const scheduleRecorderStackOffset = (): void => {
    if (!ownsRecorderStackOffset || destroyed || recorderStackFrame !== null) return;
    recorderStackFrame = hostWindow.requestAnimationFrame(updateRecorderStackOffset);
  };

  const ResizeObserverConstructor = (hostWindow as Window & {
    ResizeObserver?: typeof ResizeObserver;
  }).ResizeObserver;
  if (ownsRecorderStackOffset && ResizeObserverConstructor) {
    const resizeObserver = new ResizeObserverConstructor(updateRecorderStackOffset);
    resizeObserver.observe(root);
    unsubscribers.push(() => resizeObserver.disconnect());
  }

  const clampToViewport = (): void => {
    const rect = root.getBoundingClientRect();
    if (root.dataset.layout === "compact") return;
    const maxLeft = Math.max(0, hostWindow.innerWidth - rect.width);
    const maxTop = Math.max(0, hostWindow.innerHeight - rect.height);
    const left = Math.max(0, Math.min(rect.left, maxLeft));
    const top = Math.max(0, Math.min(rect.top, maxTop));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.setCssStyles({ right: "auto" });
    root.setCssStyles({ bottom: "auto" });
  };

  const persistCurrentPosition = (): void => {
    if (!options.positionKey) return;
    const rect = root.getBoundingClientRect();
    saveStoredPosition(options.positionKey, {
      left: rect.left,
      top: rect.top,
    }, storage);
  };

  const applyInitialPosition = (): void => {
    const fromStorage = options.positionKey
      ? loadStoredPosition(options.positionKey, storage)
      : null;
    if (fromStorage) {
      root.style.left = `${fromStorage.left}px`;
      root.style.top = `${fromStorage.top}px`;
      root.setCssStyles({ right: "auto" });
      root.setCssStyles({ bottom: "auto" });
      clampToViewport();
      return;
    }

    const defaults = options.defaultPosition ?? {};
    const topPx = parsePx(defaults.top);
    const leftPx = parsePx(defaults.left);
    const rightPx = parsePx(defaults.right);
    const bottomPx = parsePx(defaults.bottom);
    const rect = root.getBoundingClientRect();

    const top = topPx ?? (bottomPx !== null ? hostWindow.innerHeight - rect.height - bottomPx : 72);
    const left = leftPx ?? (rightPx !== null ? hostWindow.innerWidth - rect.width - rightPx : 24);

    root.style.left = `${Math.max(0, left)}px`;
    root.style.top = `${Math.max(0, top)}px`;
    root.setCssStyles({ right: "auto" });
    root.setCssStyles({ bottom: "auto" });
    clampToViewport();
  };

  const renderActions = (container: HTMLElement, actions: HoverShellAction[]): void => {
    container.replaceChildren();
    if (!actions.length) {
      container.setAttribute("hidden", "true");
      return;
    }
    container.removeAttribute("hidden");

    for (const action of actions) {
      const button = createUiAction(container, {
        label: action.label,
        icon: action.icon,
        tone: action.variant === "primary"
          ? "primary"
          : action.variant === "danger"
            ? "danger"
            : "default",
        size: "small",
        disabled: action.disabled,
        title: action.title,
        onSelect: (event) => {
          event.preventDefault();
          event.stopPropagation();
          action.onClick();
        },
      });
      button.classList.add("ss-hover-shell__action");
      button.dataset.actionId = action.id;
    }
  };

  if (options.draggable !== false) {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onPointerDown = (event: PointerEvent) => {
      if (root.dataset.layout === "compact") return;
      if (event.button !== 0 && event.pointerType === "mouse") return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      dragHandleEl.setPointerCapture(event.pointerId);
      root.classList.add("is-dragging");
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const maxLeft = Math.max(0, hostWindow.innerWidth - root.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - root.offsetHeight);
      const left = Math.max(0, Math.min(event.clientX - offsetX, maxLeft));
      const top = Math.max(0, Math.min(event.clientY - offsetY, maxTop));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.setCssStyles({ right: "auto" });
      root.setCssStyles({ bottom: "auto" });
    };

    const endDrag = (pointerId?: number) => {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("is-dragging");
      if (typeof pointerId === "number") {
        try {
          dragHandleEl.releasePointerCapture(pointerId);
        } catch {
          // Ignore release errors.
        }
      }
      persistCurrentPosition();
    };

    const onPointerUp = (event: PointerEvent) => endDrag(event.pointerId);

    dragHandleEl.addEventListener("pointerdown", onPointerDown);
    dragHandleEl.addEventListener("pointermove", onPointerMove);
    dragHandleEl.addEventListener("pointerup", onPointerUp);
    dragHandleEl.addEventListener("pointercancel", onPointerUp);
    unsubscribers.push(() => {
      dragHandleEl.removeEventListener("pointerdown", onPointerDown);
      dragHandleEl.removeEventListener("pointermove", onPointerMove);
      dragHandleEl.removeEventListener("pointerup", onPointerUp);
      dragHandleEl.removeEventListener("pointercancel", onPointerUp);
    });
  }

  const applyLayout = (): void => {
    const mobileLayout = isMobileLayout(root);
    const compact = mobileLayout || hostWindow.innerWidth <= 480;
    root.dataset.layout = compact ? "compact" : "desktop";
    if (compact) {
      root.setCssStyles({
        left: mobileLayout
          ? "max(var(--ss-space-3), env(safe-area-inset-left, 0px))"
          : "12px",
        right: mobileLayout
          ? "max(var(--ss-space-3), env(safe-area-inset-right, 0px))"
          : "12px",
        bottom: mobileLayout ? "var(--ss-mobile-bottom-clearance)" : "16px",
        top: "auto",
        width: "auto",
      });
      updateRecorderStackOffset();
      return;
    }

    if (ownsRecorderStackOffset) host.style.removeProperty(recorderStackOffsetProperty);
    root.style.width = options.width ?? "";
    root.setCssStyles({ bottom: "auto" });
    applyInitialPosition();
  };

  const onResize = () => {
    applyLayout();
    if (root.dataset.layout === "desktop") {
      persistCurrentPosition();
    }
  };
  hostWindow.addEventListener("resize", onResize);
  unsubscribers.push(() => hostWindow.removeEventListener("resize", onResize));

  hostWindow.requestAnimationFrame(() => {
    applyLayout();
  });

  return {
    root,
    dragHandleEl,
    titleEl,
    subtitleEl,
    statusEl,
    contentEl,
    headerActionsEl,
    footerActionsEl,
    setTitle: (title: string) => {
      titleEl.textContent = title;
      scheduleRecorderStackOffset();
    },
    setSubtitle: (subtitle: string) => {
      subtitleEl.textContent = subtitle;
      if (subtitle) {
        subtitleEl.removeAttribute("hidden");
      } else {
        subtitleEl.setAttribute("hidden", "true");
      }
      scheduleRecorderStackOffset();
    },
    setStatus: (status: string) => {
      statusEl.textContent = status;
      scheduleRecorderStackOffset();
    },
    setHeaderActions: (actions: HoverShellAction[]) => {
      renderActions(headerActionsEl, actions);
      scheduleRecorderStackOffset();
    },
    setFooterActions: (actions: HoverShellAction[]) => {
      renderActions(footerActionsEl, actions);
      scheduleRecorderStackOffset();
    },
    setState: (state: string) => {
      root.dataset.state = state;
    },
    show: () => {
      hostWindow.requestAnimationFrame(() => {
        root.classList.add("is-visible");
        updateRecorderStackOffset();
      });
    },
    destroy: () => {
      destroyed = true;
      if (recorderStackFrame !== null) {
        hostWindow.cancelAnimationFrame(recorderStackFrame);
        recorderStackFrame = null;
      }
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      if (ownsRecorderStackOffset) host.style.removeProperty(recorderStackOffsetProperty);
      root.classList.remove("is-visible");
      hostWindow.setTimeout(() => {
        root.remove();
      }, 140);
    },
  };
}
