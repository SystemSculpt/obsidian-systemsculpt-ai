import type { StudioNodeDefinition } from "../../studio/types";
import { applyPluginSurface, SurfaceCombobox } from "../../core/ui/surface";
import { rankStudioFuzzyItems } from "./StudioFuzzySearch";
import {
  normalizeStudioMenuScale,
  resolveStudioAnchoredMenuPosition,
} from "./StudioFloatingMenuUtils";
import {
  cancelStudioAnimationFrame,
  getStudioOwnerDocument,
  getStudioOwnerWindow,
  requestStudioAnimationFrame,
} from "./StudioDomContext";

const CONTEXT_MENU_WIDTH = 360;
// Menu chrome estimates for anchoring before first layout. These are overlay
// dimensions, not node geometry — deliberately independent of
// src/studio/StudioNodeGeometry.ts node constants.
const CONTEXT_MENU_MIN_HEIGHT = 120;
const CONTEXT_MENU_FALLBACK_HEIGHT = 280;
let nodeContextMenuInstanceId = 0;

export type StudioNodeContextMenuItem = {
  definition: StudioNodeDefinition;
  title: string;
  summary: string;
};

export type StudioNodeContextMenuAction = {
  id: string;
  title: string;
  summary?: string;
  onSelect: () => void;
};

export class StudioNodeContextMenuOverlay {
  private readonly instanceId = `ss-studio-node-context-menu-${++nodeContextMenuInstanceId}`;
  private viewportEl: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private combobox: SurfaceCombobox<StudioNodeContextMenuItem> | null = null;
  private actionsEl: HTMLElement | null = null;
  private graphZoom = 1;
  private anchorX = 0;
  private anchorY = 0;
  private onSelectDefinition: ((definition: StudioNodeDefinition) => void) | null = null;
  private isVisible = false;
  private actions: StudioNodeContextMenuAction[] = [];
  private focusRafId: number | null = null;
  private listenerWindow: Window | null = null;

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
    if (!this.isVisible) {
      return;
    }
    if (event.key !== "Escape") {
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
    this.combobox?.destroy();
    this.combobox = null;
    if (this.rootEl?.parentElement) {
      this.rootEl.parentElement.removeChild(this.rootEl);
    }
    this.viewportEl = null;
    this.rootEl = null;
    this.searchInputEl = null;
    this.listEl = null;
    this.actionsEl = null;
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
    items: StudioNodeContextMenuItem[];
    actions?: StudioNodeContextMenuAction[];
    onSelectDefinition: (definition: StudioNodeDefinition) => void;
  }): void {
    if (!this.rootEl || !this.searchInputEl || !this.listEl || !this.viewportEl) {
      return;
    }

    this.anchorX = Number.isFinite(options.anchorX) ? options.anchorX : 0;
    this.anchorY = Number.isFinite(options.anchorY) ? options.anchorY : 0;
    this.onSelectDefinition = options.onSelectDefinition;
    this.actions = Array.isArray(options.actions) ? options.actions.slice() : [];
    this.searchInputEl.value = "";
    this.renderActions();
    this.combobox?.setQuery("", { writeInput: false, render: false });
    this.combobox?.setOpen(true);
    this.combobox?.setItems(options.items);

    this.cancelPendingFocus();
    this.rootEl.setCssStyles({ display: "flex" });
    this.rootEl.removeAttribute("inert");
    this.rootEl.setAttribute("aria-hidden", "false");
    this.isVisible = true;
    this.bindGlobalListeners();
    this.applyLayout();

    // Height can change after DOM paints; clamp once more.
    this.focusRafId = requestStudioAnimationFrame(this.rootEl, () => {
      this.focusRafId = null;
      if (!this.isVisible || !this.searchInputEl) {
        return;
      }
      if (this.rootEl?.getAttribute("aria-hidden") === "true") {
        return;
      }
      try {
        this.searchInputEl.focus({ preventScroll: true });
      } catch {
        try {
          this.searchInputEl.focus();
        } catch {
          // Ignore focus failures.
        }
      }
      this.applyLayout();
    });
  }

  hide(): void {
    this.cancelPendingFocus();
    this.onSelectDefinition = null;
    this.unbindGlobalListeners();
    this.isVisible = false;
    this.actions = [];
    if (this.rootEl) {
      const activeElement = getStudioOwnerDocument(this.rootEl).activeElement as HTMLElement | null;
      if (activeElement && this.rootEl.contains(activeElement) && typeof activeElement.blur === "function") {
        activeElement.blur();
      }
      this.rootEl.setCssStyles({ display: "none" });
      this.rootEl.setAttribute("inert", "");
      this.rootEl.setAttribute("aria-hidden", "true");
    }
    if (this.searchInputEl) {
      this.searchInputEl.value = "";
    }
    this.combobox?.setOpen(false);
    this.combobox?.setQuery("", { writeInput: false, render: false });
    this.combobox?.showState(() => {});
    if (this.actionsEl) {
      this.actionsEl.empty();
      this.actionsEl.setCssStyles({ display: "none" });
    }
  }

  private createDom(): void {
    if (!this.viewportEl) {
      return;
    }

    const root = this.viewportEl.createDiv({ cls: "ss-studio-node-context-menu" });
    applyPluginSurface(root, "transient");
    root.setCssStyles({ display: "none" });
    root.setAttribute("inert", "");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-labelledby", `${this.instanceId}-title`);
    root.setAttribute("aria-hidden", "true");
    root.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    root.addEventListener("click", (event) => {
      event.stopPropagation();
    });

    const header = root.createDiv({ cls: "ss-studio-node-context-menu-header" });
    header.createDiv({
      cls: "ss-studio-node-context-menu-title",
      text: "Add Node",
      attr: { id: `${this.instanceId}-title` },
    });
    header.createDiv({
      cls: "ss-studio-node-context-menu-subtitle",
      text: "Insert at cursor",
    });

    const actions = root.createDiv({ cls: "ss-studio-node-context-menu-actions" });
    actions.setCssStyles({ display: "none" });

    const searchWrap = root.createDiv({ cls: "ss-studio-node-context-menu-search-wrap" });
    const searchInput = searchWrap.createEl("input", {
      cls: "ss-studio-node-context-menu-search-input",
      type: "text",
      attr: {
        placeholder: "Search nodes...",
        "aria-label": "Search nodes",
      },
    });
    searchInput.spellcheck = false;
    searchInput.autocomplete = "off";

    const list = root.createDiv({
      cls: "ss-studio-node-context-menu-list",
      attr: {
        id: `${this.instanceId}-listbox`,
      },
    });

    this.rootEl = root;
    this.searchInputEl = searchInput;
    this.listEl = list;
    this.actionsEl = actions;
    this.initializeCombobox();
    this.applyLayout();
  }

  private initializeCombobox(): void {
    if (!this.searchInputEl || !this.listEl) return;
    this.combobox?.destroy();
    this.combobox = new SurfaceCombobox<StudioNodeContextMenuItem>({
      input: this.searchInputEl,
      listbox: this.listEl,
      listboxId: `${this.instanceId}-listbox`,
      listboxLabel: "Available nodes",
      initiallyOpen: false,
      activeMode: "first",
      navigation: "wrap",
      selectionFollowsActive: true,
      activeClass: "is-active",
      getItemKey: (item) => `${item.definition.kind}@${item.definition.version}`,
      filterItems: (items, query) => rankStudioFuzzyItems({
        items,
        query,
        getSearchText: (item) => `${item.title} ${item.summary} ${item.definition.kind}`,
        compareWhenEqual: (left, right) => left.title.localeCompare(right.title),
      }),
      renderOption: ({ item }) => this.renderNodeItem(item),
      renderEmpty: ({ listbox }) => {
        listbox.createDiv({
          cls: "ss-studio-node-context-menu-empty",
          text: "No matching nodes.",
        });
      },
      onCommit: ({ item }) => {
        const onSelect = this.onSelectDefinition;
        this.hide();
        onSelect?.(item.definition);
      },
      onEscape: () => this.hide(),
      onRender: () => this.applyLayout(),
    });
  }

  private cancelPendingFocus(): void {
    if (this.focusRafId === null) {
      return;
    }
    if (this.rootEl) {
      cancelStudioAnimationFrame(this.rootEl, this.focusRafId);
    }
    this.focusRafId = null;
  }

  private renderActions(): void {
    if (!this.actionsEl) {
      return;
    }
    this.actionsEl.empty();
    if (this.actions.length === 0) {
      this.actionsEl.setCssStyles({ display: "none" });
      return;
    }

    this.actionsEl.setCssStyles({ display: "grid" });
    for (const action of this.actions) {
      const button = this.actionsEl.createEl("button", {
        cls: "ss-studio-node-context-menu-action",
      });
      button.type = "button";
      button.dataset.actionId = action.id;
      const content = button.createDiv({
        cls: "ss-studio-node-context-menu-action-content",
      });
      content.createDiv({
        cls: "ss-studio-node-context-menu-action-title",
        text: action.title,
      });
      if (action.summary) {
        content.createDiv({
          cls: "ss-studio-node-context-menu-action-summary",
          text: action.summary,
        });
      }
      button.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const onSelect = action.onSelect;
        this.hide();
        onSelect();
      });
    }
  }

  private renderNodeItem(item: StudioNodeContextMenuItem): HTMLElement {
    const itemEl = this.listEl!.createDiv({
      cls: "ss-studio-node-context-menu-item",
    });
    itemEl.tabIndex = -1;
    const content = itemEl.createDiv({
      cls: "ss-studio-node-context-menu-item-content",
    });
    content.createDiv({
      cls: "ss-studio-node-context-menu-item-title",
      text: item.title,
    });
    content.createDiv({
      cls: "ss-studio-node-context-menu-item-summary",
      text: item.summary,
    });
    return itemEl;
  }

  private applyLayout(): void {
    if (!this.rootEl || !this.viewportEl) {
      return;
    }

    const scale = normalizeStudioMenuScale(this.graphZoom);
    const width = CONTEXT_MENU_WIDTH;
    this.rootEl.style.width = `${width}px`;
    this.rootEl.style.setProperty("--ss-studio-node-context-menu-scale", String(scale));

    const height = Math.max(
      CONTEXT_MENU_MIN_HEIGHT,
      this.rootEl.offsetHeight || CONTEXT_MENU_FALLBACK_HEIGHT
    );
    const visualWidth = width * scale;
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

  private bindGlobalListeners(): void {
    if (!this.rootEl) {
      return;
    }
    this.unbindGlobalListeners();
    const ownerWindow = getStudioOwnerWindow(this.rootEl);
    ownerWindow.addEventListener("pointerdown", this.onWindowPointerDown, true);
    ownerWindow.addEventListener("keydown", this.onWindowKeyDown, true);
    ownerWindow.addEventListener("contextmenu", this.onWindowContextMenu, true);
    this.listenerWindow = ownerWindow;
  }

  private unbindGlobalListeners(): void {
    this.listenerWindow?.removeEventListener("pointerdown", this.onWindowPointerDown, true);
    this.listenerWindow?.removeEventListener("keydown", this.onWindowKeyDown, true);
    this.listenerWindow?.removeEventListener("contextmenu", this.onWindowContextMenu, true);
    this.listenerWindow = null;
  }
}
