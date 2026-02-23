import type { StudioNodeDefinition } from "../../studio/types";
import {
  STUDIO_GRAPH_MAX_ZOOM,
  STUDIO_GRAPH_MIN_ZOOM,
} from "./StudioGraphInteractionTypes";

const CONTEXT_MENU_WIDTH = 360;
const CONTEXT_MENU_EDGE_PADDING = 8;
const MIN_CONTEXT_MENU_SCALE = STUDIO_GRAPH_MIN_ZOOM;
const MAX_CONTEXT_MENU_SCALE = STUDIO_GRAPH_MAX_ZOOM;

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

function normalizeContextMenuScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_CONTEXT_MENU_SCALE, Math.max(MIN_CONTEXT_MENU_SCALE, value));
}

function normalizeSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isBoundaryChar(char: string): boolean {
  return char === " " || char === "." || char === "_" || char === "-" || char === "/" || char === ":";
}

function fuzzyScore(haystackRaw: string, queryRaw: string): number | null {
  const haystack = normalizeSearchText(haystackRaw);
  const query = normalizeSearchText(queryRaw);
  if (!query) {
    return 0;
  }

  let scanIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  let boundaryBonus = 0;

  for (const queryChar of query) {
    const matchIndex = haystack.indexOf(queryChar, scanIndex);
    if (matchIndex < 0) {
      return null;
    }
    if (firstMatchIndex < 0) {
      firstMatchIndex = matchIndex;
    }
    if (previousMatchIndex >= 0) {
      gapPenalty += Math.max(0, matchIndex - previousMatchIndex - 1);
    }
    if (matchIndex === 0 || isBoundaryChar(haystack.charAt(matchIndex - 1))) {
      boundaryBonus += 0.45;
    }
    previousMatchIndex = matchIndex;
    scanIndex = matchIndex + 1;
  }

  const span = previousMatchIndex - firstMatchIndex + 1;
  let score =
    firstMatchIndex * 1.6 +
    gapPenalty * 1.3 +
    Math.max(0, span - query.length) * 0.8 +
    haystack.length * 0.01;

  if (haystack.startsWith(query)) {
    score -= 5;
  } else {
    const containsIndex = haystack.indexOf(query);
    if (containsIndex >= 0) {
      score -= 3.2 - Math.min(2, containsIndex * 0.1);
    }
  }

  score -= boundaryBonus;
  return score;
}

export class StudioNodeContextMenuOverlay {
  private viewportEl: HTMLElement | null = null;
  private rootEl: HTMLElement | null = null;
  private searchInputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private graphZoom = 1;
  private anchorX = 0;
  private anchorY = 0;
  private onSelectDefinition: ((definition: StudioNodeDefinition) => void) | null = null;
  private isVisible = false;
  private allItems: StudioNodeContextMenuItem[] = [];
  private filteredItems: StudioNodeContextMenuItem[] = [];
  private actions: StudioNodeContextMenuAction[] = [];
  private itemEls: HTMLElement[] = [];
  private activeIndex = -1;
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
    this.allItems = options.items.slice();
    this.actions = Array.isArray(options.actions) ? options.actions.slice() : [];
    this.searchInputEl.value = "";
    this.renderActions();
    this.applyFilter("");

    this.cancelPendingFocus();
    this.rootEl.style.display = "flex";
    this.rootEl.removeAttribute("inert");
    this.rootEl.setAttribute("aria-hidden", "false");
    this.isVisible = true;
    this.bindGlobalListeners();
    this.applyLayout();

    // Height can change after DOM paints; clamp once more.
    this.focusRafId = window.requestAnimationFrame(() => {
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
    this.allItems = [];
    this.filteredItems = [];
    this.actions = [];
    this.itemEls = [];
    this.activeIndex = -1;
    if (this.rootEl) {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && this.rootEl.contains(activeElement) && typeof activeElement.blur === "function") {
        activeElement.blur();
      }
      this.rootEl.style.display = "none";
      this.rootEl.setAttribute("inert", "");
      this.rootEl.setAttribute("aria-hidden", "true");
    }
    if (this.searchInputEl) {
      this.searchInputEl.value = "";
    }
    if (this.listEl) {
      this.listEl.empty();
    }
    if (this.actionsEl) {
      this.actionsEl.empty();
      this.actionsEl.style.display = "none";
    }
  }

  private createDom(): void {
    if (!this.viewportEl) {
      return;
    }

    const root = this.viewportEl.createDiv({ cls: "ss-studio-node-context-menu" });
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

    const header = root.createDiv({ cls: "ss-studio-node-context-menu-header" });
    header.createDiv({
      cls: "ss-studio-node-context-menu-title",
      text: "Add Node",
    });
    header.createDiv({
      cls: "ss-studio-node-context-menu-subtitle",
      text: "Insert at cursor",
    });

    const actions = root.createDiv({ cls: "ss-studio-node-context-menu-actions" });
    actions.style.display = "none";

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
    searchInput.addEventListener("input", () => {
      this.applyFilter(searchInput.value);
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.moveActiveItem(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.moveActiveItem(-1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        this.selectActiveItem();
      }
    });

    const list = root.createDiv({ cls: "ss-studio-node-context-menu-list" });

    this.rootEl = root;
    this.searchInputEl = searchInput;
    this.listEl = list;
    this.actionsEl = actions;
    this.applyLayout();
  }

  private cancelPendingFocus(): void {
    if (this.focusRafId === null) {
      return;
    }
    window.cancelAnimationFrame(this.focusRafId);
    this.focusRafId = null;
  }

  private renderActions(): void {
    if (!this.actionsEl) {
      return;
    }
    this.actionsEl.empty();
    if (this.actions.length === 0) {
      this.actionsEl.style.display = "none";
      return;
    }

    this.actionsEl.style.display = "grid";
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

  private applyFilter(query: string): void {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      this.filteredItems = this.allItems.slice();
    } else {
      const ranked = this.allItems
        .map((item, index) => {
          const score = fuzzyScore(
            `${item.title} ${item.summary} ${item.definition.kind}`,
            normalizedQuery
          );
          return {
            item,
            score,
            index,
          };
        })
        .filter((entry) => entry.score !== null)
        .sort((a, b) => {
          if (a.score !== b.score) {
            return Number(a.score) - Number(b.score);
          }
          if (a.item.title !== b.item.title) {
            return a.item.title.localeCompare(b.item.title);
          }
          return a.index - b.index;
        });
      this.filteredItems = ranked.map((entry) => entry.item);
    }

    this.activeIndex = this.filteredItems.length > 0 ? 0 : -1;
    this.renderItems();
    this.applyLayout();
  }

  private renderItems(): void {
    if (!this.listEl) {
      return;
    }

    this.listEl.empty();
    this.itemEls = [];
    if (this.filteredItems.length === 0) {
      this.listEl.createDiv({
        cls: "ss-studio-node-context-menu-empty",
        text: "No matching nodes.",
      });
      return;
    }

    for (const [index, item] of this.filteredItems.entries()) {
      const itemEl = this.listEl.createDiv({
        cls: "ss-studio-node-context-menu-item",
      });
      itemEl.setAttribute("role", "menuitem");
      itemEl.tabIndex = 0;
      this.itemEls.push(itemEl);

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

      const commitSelection = (): void => {
        const onSelect = this.onSelectDefinition;
        this.hide();
        onSelect?.(item.definition);
      };

      itemEl.addEventListener("pointermove", () => {
        this.setActiveIndex(index, { scrollIntoView: false });
      });
      itemEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        commitSelection();
      });
      itemEl.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          this.moveActiveItem(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          event.stopPropagation();
          this.moveActiveItem(-1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          commitSelection();
        }
      });
    }

    this.refreshActiveStyles({ scrollIntoView: false });
  }

  private setActiveIndex(nextIndex: number, options?: { scrollIntoView?: boolean }): void {
    if (this.filteredItems.length === 0) {
      this.activeIndex = -1;
      this.refreshActiveStyles({ scrollIntoView: false });
      return;
    }

    const bounded = Math.max(0, Math.min(this.filteredItems.length - 1, nextIndex));
    if (bounded === this.activeIndex) {
      return;
    }

    this.activeIndex = bounded;
    this.refreshActiveStyles({ scrollIntoView: options?.scrollIntoView });
  }

  private moveActiveItem(delta: number): void {
    if (this.filteredItems.length === 0) {
      return;
    }

    const count = this.filteredItems.length;
    const current = this.activeIndex >= 0 ? this.activeIndex : 0;
    const next = ((current + delta) % count + count) % count;
    this.activeIndex = next;
    this.refreshActiveStyles({ scrollIntoView: true });
  }

  private refreshActiveStyles(options?: { scrollIntoView?: boolean }): void {
    for (const [index, itemEl] of this.itemEls.entries()) {
      const isActive = index === this.activeIndex;
      itemEl.classList.toggle("is-active", isActive);
      itemEl.setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive && options?.scrollIntoView) {
        itemEl.scrollIntoView({
          block: "nearest",
        });
      }
    }
  }

  private selectActiveItem(): void {
    if (this.filteredItems.length === 0) {
      return;
    }
    const index = this.activeIndex >= 0 ? this.activeIndex : 0;
    const item = this.filteredItems[index];
    if (!item) {
      return;
    }
    const onSelect = this.onSelectDefinition;
    this.hide();
    onSelect?.(item.definition);
  }

  private applyLayout(): void {
    if (!this.rootEl || !this.viewportEl) {
      return;
    }

    const scale = normalizeContextMenuScale(this.graphZoom);
    const width = CONTEXT_MENU_WIDTH;
    this.rootEl.style.width = `${width}px`;
    this.rootEl.style.setProperty("--ss-studio-node-context-menu-scale", String(scale));
    this.rootEl.style.transformOrigin = "top left";

    const height = Math.max(120, this.rootEl.offsetHeight || 280);
    const visualWidth = width * scale;
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
