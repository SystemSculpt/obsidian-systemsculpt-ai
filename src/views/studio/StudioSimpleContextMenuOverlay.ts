import { applyPluginSurface } from "../../core/ui/surface";
import {
  normalizeStudioMenuScale,
  resolveStudioAnchoredMenuPosition,
} from "./StudioFloatingMenuUtils";
import { StudioMenuLifecycle } from "./StudioMenuLifecycle";

const CONTEXT_MENU_DEFAULT_WIDTH = 220;

export type StudioSimpleContextMenuItem = {
  id: string;
  title: string;
  summary?: string;
  onSelect: () => void;
};

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
  private itemButtons: HTMLButtonElement[] = [];
  private lifecycle: StudioMenuLifecycle | null = null;

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
    this.lifecycle = null;
    this.viewportEl = null;
    this.rootEl = null;
    this.headerEl = null;
    this.titleEl = null;
    this.subtitleEl = null;
    this.listEl = null;
    this.itemButtons = [];
  }

  setGraphZoom(zoom: number): void {
    const nextZoom = normalizeStudioMenuScale(zoom);
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
    this.rootEl.setAttribute("aria-label", title || "Studio actions");

    this.renderItems(Array.isArray(options.items) ? options.items : []);

    this.lifecycle?.show(() => {
      this.focusMenuItem(0);
      this.applyLayout();
    });
    this.applyLayout();
  }

  hide(): void {
    this.lifecycle?.hide();
    if (this.listEl) {
      this.listEl.empty();
    }
    this.itemButtons = [];
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
    applyPluginSurface(root, "transient");
    root.setCssStyles({ display: "none" });
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
    header.setAttribute("role", "presentation");
    const title = header.createDiv({ cls: "ss-studio-simple-context-menu-title" });
    const subtitle = header.createDiv({ cls: "ss-studio-simple-context-menu-subtitle" });
    const list = root.createDiv({ cls: "ss-studio-simple-context-menu-list" });
    list.setAttribute("role", "presentation");

    this.rootEl = root;
    this.lifecycle = new StudioMenuLifecycle(root, () => this.hide());
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
    this.itemButtons = [];
    for (const [index, item] of items.entries()) {
      const button = this.listEl.createEl("button", {
        cls: "ss-studio-simple-context-menu-item",
      });
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.tabIndex = index === 0 ? 0 : -1;
      this.itemButtons.push(button);
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
      button.addEventListener("pointermove", () => {
        this.setMenuTabStop(index);
      });
      button.addEventListener("keydown", (event) => {
        let nextIndex: number | null = null;
        if (event.key === "ArrowDown") {
          nextIndex = index + 1;
        } else if (event.key === "ArrowUp") {
          nextIndex = index - 1;
        } else if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = this.itemButtons.length - 1;
        }
        if (nextIndex === null) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.focusMenuItem(nextIndex);
      });
    }
  }

  private setMenuTabStop(index: number): void {
    for (const [buttonIndex, button] of this.itemButtons.entries()) {
      button.tabIndex = buttonIndex === index ? 0 : -1;
    }
  }

  private focusMenuItem(index: number): void {
    if (this.itemButtons.length === 0) {
      return;
    }
    const count = this.itemButtons.length;
    const wrappedIndex = ((index % count) + count) % count;
    const button = this.itemButtons[wrappedIndex];
    if (!button) {
      return;
    }
    this.setMenuTabStop(wrappedIndex);
    try {
      button.focus({ preventScroll: true });
    } catch {
      button.focus();
    }
  }

  private applyLayout(): void {
    if (!this.rootEl || !this.viewportEl) {
      return;
    }

    const scale = normalizeStudioMenuScale(this.graphZoom);
    this.rootEl.style.width = `${this.menuWidth}px`;
    this.rootEl.style.setProperty("--ss-studio-simple-context-menu-scale", String(scale));

    const height = Math.max(40, this.rootEl.offsetHeight || 80);
    const visualWidth = this.menuWidth * scale;
    const visualHeight = height * scale;
    const position = resolveStudioAnchoredMenuPosition({
      viewportEl: this.viewportEl,
      anchorX: this.anchorX,
      anchorY: this.anchorY,
      visualWidth,
      visualHeight,
    });
    this.rootEl.style.left = `${position.x}px`;
    this.rootEl.style.top = `${position.y}px`;
  }

}
