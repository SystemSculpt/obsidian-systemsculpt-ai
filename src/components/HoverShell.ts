import { setIcon } from "obsidian";

export type HoverShellLayout = "desktop" | "mobile";
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
  layout: HoverShellLayout;
  draggable?: boolean;
  defaultPosition?: HoverShellPosition;
  positionKey?: string;
  showStatusRow?: boolean;
  host?: HTMLElement;
  useFloatingLegacyClass?: boolean;
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

const parsePx = (value?: string): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.endsWith("px")) return null;
  const parsed = Number.parseFloat(trimmed.slice(0, -2));
  return Number.isFinite(parsed) ? parsed : null;
};

const readPositionMap = (): Record<string, StoredHoverPosition> => {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(HOVER_POSITION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, StoredHoverPosition>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writePositionMap = (map: Record<string, StoredHoverPosition>): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(HOVER_POSITION_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore persistence failures in private/sandboxed runtimes.
  }
};

const makeStorageKey = (positionKey: string, layout: HoverShellLayout): string => `${positionKey}:${layout}`;

const loadStoredPosition = (positionKey: string, layout: HoverShellLayout): StoredHoverPosition | null => {
  const map = readPositionMap();
  const key = makeStorageKey(positionKey, layout);
  const entry = map[key];
  if (!entry) return null;
  if (typeof entry.left !== "number" || typeof entry.top !== "number") return null;
  return entry;
};

const saveStoredPosition = (positionKey: string, layout: HoverShellLayout, value: StoredHoverPosition): void => {
  const map = readPositionMap();
  map[makeStorageKey(positionKey, layout)] = value;
  writePositionMap(map);
};

export function createHoverShell(options: HoverShellOptions): HoverShellHandle {
  const host = options.host ?? document.body;
  const root = document.createElement("div");
  root.className = "ss-hover-shell";
  root.dataset.layout = options.layout;
  root.dataset.state = "idle";
  if (options.className) {
    root.classList.add(...options.className.split(/\s+/).filter(Boolean));
  }
  if (options.useFloatingLegacyClass) {
    root.classList.add("systemsculpt-floating-widget");
  }
  if (options.width) {
    root.style.width = options.width;
  }

  const header = document.createElement("div");
  header.className = "ss-hover-shell__header";
  root.appendChild(header);

  const dragHandleEl = document.createElement("div");
  dragHandleEl.className = "ss-hover-shell__drag-handle";
  header.appendChild(dragHandleEl);

  const iconWrap = document.createElement("span");
  iconWrap.className = "ss-hover-shell__icon";
  if (options.icon) {
    setIcon(iconWrap, options.icon);
  } else {
    iconWrap.setAttribute("hidden", "true");
  }
  dragHandleEl.appendChild(iconWrap);

  const titleStack = document.createElement("div");
  titleStack.className = "ss-hover-shell__title-stack";
  dragHandleEl.appendChild(titleStack);

  const titleEl = document.createElement("div");
  titleEl.className = "ss-hover-shell__title";
  titleEl.textContent = options.title;
  titleStack.appendChild(titleEl);

  const subtitleEl = document.createElement("div");
  subtitleEl.className = "ss-hover-shell__subtitle";
  subtitleEl.textContent = options.subtitle ?? "";
  if (!options.subtitle) {
    subtitleEl.setAttribute("hidden", "true");
  }
  titleStack.appendChild(subtitleEl);

  const headerActionsEl = document.createElement("div");
  headerActionsEl.className = "ss-hover-shell__header-actions";
  header.appendChild(headerActionsEl);

  const statusEl = document.createElement("div");
  statusEl.className = "ss-hover-shell__status";
  statusEl.textContent = options.statusText ?? "";
  if (options.showStatusRow === false) {
    statusEl.setAttribute("hidden", "true");
  }
  root.appendChild(statusEl);

  const contentEl = document.createElement("div");
  contentEl.className = "ss-hover-shell__content";
  root.appendChild(contentEl);

  const footerActionsEl = document.createElement("div");
  footerActionsEl.className = "ss-hover-shell__footer-actions";
  root.appendChild(footerActionsEl);

  host.appendChild(root);

  const unsubscribers: Array<() => void> = [];

  const clampToViewport = (): void => {
    if (options.layout === "mobile") return;
    const rect = root.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    const left = Math.max(0, Math.min(rect.left, maxLeft));
    const top = Math.max(0, Math.min(rect.top, maxTop));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
  };

  const persistCurrentPosition = (): void => {
    if (!options.positionKey || options.layout === "mobile") return;
    const rect = root.getBoundingClientRect();
    saveStoredPosition(options.positionKey, options.layout, {
      left: rect.left,
      top: rect.top,
    });
  };

  const applyInitialPosition = (): void => {
    if (options.layout === "mobile") return;

    const fromStorage = options.positionKey
      ? loadStoredPosition(options.positionKey, options.layout)
      : null;
    if (fromStorage) {
      root.style.left = `${fromStorage.left}px`;
      root.style.top = `${fromStorage.top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
      clampToViewport();
      return;
    }

    const defaults = options.defaultPosition ?? {};
    const topPx = parsePx(defaults.top);
    const leftPx = parsePx(defaults.left);
    const rightPx = parsePx(defaults.right);
    const bottomPx = parsePx(defaults.bottom);
    const rect = root.getBoundingClientRect();

    const top = topPx ?? (bottomPx !== null ? window.innerHeight - rect.height - bottomPx : 72);
    const left = leftPx ?? (rightPx !== null ? window.innerWidth - rect.width - rightPx : 24);

    root.style.left = `${Math.max(0, left)}px`;
    root.style.top = `${Math.max(0, top)}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
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
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ss-hover-shell__action";
      button.dataset.actionId = action.id;
      button.textContent = action.label;
      if (action.variant === "primary") {
        button.classList.add("mod-cta");
      } else if (action.variant === "danger") {
        button.classList.add("mod-warning");
      }
      if (action.icon) {
        const iconEl = document.createElement("span");
        iconEl.className = "ss-hover-shell__action-icon";
        setIcon(iconEl, action.icon);
        button.prepend(iconEl);
      }
      if (action.disabled) {
        button.disabled = true;
      }
      if (action.title) {
        button.title = action.title;
      }
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        action.onClick();
      });
      container.appendChild(button);
    }
  };

  if (options.draggable !== false && options.layout === "desktop") {
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const onPointerDown = (event: PointerEvent) => {
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
      const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
      const left = Math.max(0, Math.min(event.clientX - offsetX, maxLeft));
      const top = Math.max(0, Math.min(event.clientY - offsetY, maxTop));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
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

  const onResize = () => {
    clampToViewport();
    persistCurrentPosition();
  };
  window.addEventListener("resize", onResize);
  unsubscribers.push(() => window.removeEventListener("resize", onResize));

  requestAnimationFrame(() => {
    applyInitialPosition();
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
    },
    setSubtitle: (subtitle: string) => {
      subtitleEl.textContent = subtitle;
      if (subtitle) {
        subtitleEl.removeAttribute("hidden");
      } else {
        subtitleEl.setAttribute("hidden", "true");
      }
    },
    setStatus: (status: string) => {
      statusEl.textContent = status;
    },
    setHeaderActions: (actions: HoverShellAction[]) => {
      renderActions(headerActionsEl, actions);
    },
    setFooterActions: (actions: HoverShellAction[]) => {
      renderActions(footerActionsEl, actions);
    },
    setState: (state: string) => {
      root.dataset.state = state;
    },
    show: () => {
      requestAnimationFrame(() => root.classList.add("is-visible"));
    },
    destroy: () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      root.classList.remove("is-visible");
      window.setTimeout(() => {
        root.remove();
      }, 140);
    },
  };
}

