import {
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "./StudioGraphInteractionTypes";

const CONTEXT_MENU_DEFAULT_WIDTH = 220;
const CONTEXT_MENU_EDGE_PADDING = 8;
const MIN_CONTEXT_MENU_SCALE = STUDIO_GRAPH_MIN_ZOOM;
const MAX_CONTEXT_MENU_SCALE = STUDIO_GRAPH_MAX_ZOOM;

export type StudioSimpleContextMenuItem = {
  id: string;
  title: string;
  summary?: string;
  onSelect: () => void;
};

function normalizeContextMenuScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_CONTEXT_MENU_SCALE, Math.max(MIN_CONTEXT_MENU_SCALE, value));
}

export class StudioSimpleContextMenuOverlay {
  private viewportEl: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private subtitleEl: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private graphZoom = 1;
  private anchorX = 0;
  private anchorY = 0;
  private menuWidth = CONTEXT_MENU_DEFAULT_WIDTH;
  private isVisible = false;
  private focusRafId: number | null = null;

  private readonly onWindowPointerDown = (event: PointerEvent): void => {
    if (!this.isVisible || !this.rootEl) {
      return;
    }
    const target = event.target as Node | null;
    if (target && this.rootEl.contains(target)) {
      return;
    }
    this.hide();
  };

  private readonly onWindowKeyDown = (event: KeyboardEvent): void => {
    if (!this.isVisible || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    this.hide();
  };

  private readonly onWindowContextMenu = (event: MouseEvent): void => {
    if (!this.isVisible || !this.rootEl) {
      return;
    }
    const target = event.target as Node | null;
    if (target && this.rootEl.contains(target)) {
      event.preventDefault();
      return;
    }
    this.hide();
  };

  mount(viewportEl: HTMLElement): void {
    this.viewportEl = viewportEl;
    if (!this.rootEl) {
      this.createDom();
    }
    if (this.rootEl && this.rootEl.parentElement !== viewportEl) {
      viewportEl.appendChild(this.rootEl);
    }
    this.applyLayout();
  }

  destroy(): void {
    this.hide();
    if (this.rootEl?.parentElement) {
      this.rootEl.parentElement.removeChild(this.rootEl);
    }
    this.viewportEl = null;
    this.rootEl = null;
    this.headerEl = null;
    this.titleEl = null;
    this.subtitleEl = null;
    this.listEl = null;
  }

  setGraphZoom(zoom: number): void {
    const nextZoom = normalizeContextMenuScale(zoom);
    if (Math.abs(this.graphZoom - nextZoom) < 0.0001) {
      return;
    }
    this.graphZoom = nextZoom;
    this.applyLayout();
  }

  open(options: {
    anchorX: number;
    anchorY: number;
    items: StudioSimpleContextMenuItem[];
    title?: string;
    subtitle?: string;
    width?: number;
  }): void {
    if (!this.rootEl || !this.listEl || !this.headerEl || !this.titleEl || !this.subtitleEl) {
      return;
    }

    this.anchorX = Number.isFinite(options.anchorX) ? options.anchorX : 0;
    this.anchorY = Number.isFinite(options.anchorY) ? options.anchorY : 0;
    this.menuWidth = Number.isFinite(options.width || NaN)
      ? Math.max(160, Math.round(options.width || CONTEXT_MENU_DEFAULT_WIDTH))
      : CONTEXT_MENU_DEFAULT_WIDTH;

    const title = String(options.title || "").trim();
    const subtitle = String(options.subtitle || "").trim();
    const hasHeader = Boolean(title || subtitle);
    this.headerEl.style.display = hasHeader ? "grid" : "none";
    this.titleEl.setText(title);
    this.subtitleEl.setText(subtitle);

    this.renderItems(Array.isArray(options.items) ? options.items : []);

    this.cancelPendingFocus();
    this.rootEl.style.display = "flex";
    this.rootEl.removeAttribute("inert");
    this.rootEl.setAttribute("aria-hidden", "false");
    this.isVisible = true;
    this.bindGlobalListeners();
    this.applyLayout();

    this.focusRafId = window.requestAnimationFrame(() => {
      this.focusRafId = null;
      if (!this.isVisible || !this.listEl) {
        return;
      }
      const firstButton = this.listEl.querySelector<HTMLButtonElement>(".ss-studio-simple-context-menu-item");
      if (!firstButton) {
        return;
      }
      try {
        firstButton.focus({ preventScroll: true });
      } catch {
        firstButton.focus();
      }
      this.applyLayout();
    });
  }

  hide(): void {
    this.cancelPendingFocus();
    this.unbindGlobalListeners();
    this.isVisible = false;
    if (this.rootEl) {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && this.rootEl.contains(activeElement) && typeof activeElement.blur === "function") {
        activeElement.blur();
      }
      this.rootEl.style.display = "none";
      this.rootEl.setAttribute("inert", "");
      this.rootEl.setAttribute("aria-hidden", "true");
    }
    if (this.listEl) {
      this.listEl.empty();
    }
    if (this.titleEl) {
      this.titleEl.empty();
    }
    if (this.subtitleEl) {
      this.subtitleEl.empty();
    }
  }

  private createDom(): void {
    if (!this.viewportEl) {
      return;
    }

    const root = this.viewportEl.createDiv({ cls: "ss-studio-simple-context-menu" });
    root.style.display = "none";
    root.setAttribute("inert", "");
    root.setAttribute("role", "menu");
    root.setAttribute("aria-hidden", "true");
    root.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    root.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    const header = root.createDiv({ cls: "ss-studio-simple-context-menu-header" });
    const title = header.createDiv({ cls: "ss-studio-simple-context-menu-title" });
    const subtitle = header.createDiv({ cls: "ss-studio-simple-context-menu-subtitle" });
    const list = root.createDiv({ cls: "ss-studio-simple-context-menu-list" });

    this.rootEl = root;
    this.headerEl = header;
    this.titleEl = title;
    this.subtitleEl = subtitle;
    this.listEl = list;
    this.applyLayout();
  }

  private renderItems(items: StudioSimpleContextMenuItem[]): void {
    if (!this.listEl) {
      return;
    }
    this.listEl.empty();
    for (const item of items) {
      const button = this.listEl.createEl("button", {
        cls: "ss-studio-simple-context-menu-item",
      });
      button.type = "button";
      button.setAttribute("role", "menuitem");
      const content = button.createDiv({ cls: "ss-studio-simple-context-menu-item-content" });
      content.createDiv({
        cls: "ss-studio-simple-context-menu-item-title",
        text: item.title,
      });
      const summary = String(item.summary || "").trim();
      if (summary) {
        content.createDiv({
          cls: "ss-studio-simple-context-menu-item-summary",
          text: summary,
        });
      }
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const onSelect = item.onSelect;
        this.hide();
        onSelect();
      });
    }
  }

  private cancelPendingFocus(): void {
    if (this.focusRafId === null) {
      return;
    }
    window.cancelAnimationFrame(this.focusRafId);
    this.focusRafId = null;
  }

  private applyLayout(): void {
    if (!this.rootEl || !this.viewportEl) {
      return;
    }

    const scale = normalizeContextMenuScale(this.graphZoom);
    this.rootEl.style.width = `${this.menuWidth}px`;
    this.rootEl.style.setProperty("--ss-studio-simple-context-menu-scale", String(scale));
    this.rootEl.style.transformOrigin = "top left";

    const height = Math.max(40, this.rootEl.offsetHeight || 80);
    const visualWidth = this.menuWidth * scale;
    const visualHeight = height * scale;
    const minX = this.viewportEl.scrollLeft + CONTEXT_MENU_EDGE_PADDING;
    const minY = this.viewportEl.scrollTop + CONTEXT_MENU_EDGE_PADDING;
    const maxX = Math.max(
      minX,
      this.viewportEl.scrollLeft + this.viewportEl.clientWidth - visualWidth - CONTEXT_MENU_EDGE_PADDING
    );
    const maxY = Math.max(
      minY,
      this.viewportEl.scrollTop + this.viewportEl.clientHeight - visualHeight - CONTEXT_MENU_EDGE_PADDING
    );
    const desiredX = this.anchorX + 8;
    const desiredY = this.anchorY + 8;
    const nextX = Math.min(maxX, Math.max(minX, desiredX));
    const nextY = Math.min(maxY, Math.max(minY, desiredY));

    this.rootEl.style.left = `${nextX}px`;
    this.rootEl.style.top = `${nextY}px`;
  }

  private bindGlobalListeners(): void {
    window.addEventListener("pointerdown", this.onWindowPointerDown, true);
    window.addEventListener("keydown", this.onWindowKeyDown, true);
    window.addEventListener("contextmenu", this.onWindowContextMenu, true);
  }

  private unbindGlobalListeners(): void {
    window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
    window.removeEventListener("keydown", this.onWindowKeyDown, true);
    window.removeEventListener("contextmenu", this.onWindowContextMenu, true);
  }
}
