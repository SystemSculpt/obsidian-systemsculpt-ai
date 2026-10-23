import { Component, Menu, setIcon } from "obsidian";
import {
  createUiAction,
  createUiSearch,
  getSurfaceOwnerWindow,
  SurfaceCombobox,
  updateUiAction,
  type UiSearchHandle,
} from "../../core/ui/surface";
import { isLocalAgentId, type TextExecutionBackend } from "../../services/codex/LocalAgents";
import { chatHistoryFullTime, chatHistoryGroup, chatHistoryTime } from "./chatHistoryGroups";
import type { ChatHistoryRow } from "./chatHistoryRows";
import { returnFocusAfterMenu } from "../chatview/AgentRunLine";

/** Rows rendered at once; "Show more" adds another page. */
const ROW_PAGE = 50;
/** Full-text search starts at this query length, after typing pauses. */
const CONTENT_SEARCH_MIN_CHARACTERS = 2;
const CONTENT_SEARCH_DEBOUNCE_MS = 250;
const CONTENT_SEARCH_CONCURRENCY = 4;
const TEXT_MATCHES_GROUP = "Matches in chat text";

const BADGES: Readonly<Record<TextExecutionBackend, Readonly<{ icon: string; label: string }>>> = {
  claude: { icon: "laptop", label: "Claude" },
  codex: { icon: "laptop", label: "Codex" },
  systemsculpt: { icon: "cloud", label: "SystemSculpt" },
};

export type ChatHistoryPanelOptions = Readonly<{
  loadRows: () => Promise<readonly ChatHistoryRow[]>;
  loadSearchText: (row: ChatHistoryRow) => Promise<string>;
  isCurrent: (chatId: string) => boolean;
  isRunning: (chatId: string) => boolean;
  onOpen: (row: ChatHistoryRow, inNewTab: boolean) => void | Promise<void>;
  onNewChat: () => void;
  onClose: () => void;
  onToggleFavorite: (row: ChatHistoryRow) => Promise<void>;
  onRename: (row: ChatHistoryRow, title: string) => Promise<void>;
  /** Confirms with the person; resolves true when the chat was moved to the trash. */
  onDelete: (row: ChatHistoryRow) => Promise<boolean>;
  now?: () => number;
}>;

type PanelItem = Readonly<{ row: ChatHistoryRow; group: string }>;

type ContentSearch = {
  readonly query: string;
  readonly matches: Set<string>;
  complete: boolean;
};

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Chat history inside the chat view: it replaces the conversation and
 * composer while open, and closing it returns to the chat with its draft.
 * Titles filter as you type; message text is searched once typing pauses.
 * Focus stays in the search field and the arrow keys move through the rows,
 * so typing always refines the search.
 */
export class ChatHistoryPanel extends Component {
  public readonly element: HTMLElement;
  private readonly search: UiSearchHandle;
  private readonly listEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly showMoreEl: HTMLButtonElement;
  private readonly combobox: SurfaceCombobox<PanelItem>;
  private rows: readonly ChatHistoryRow[] = [];
  private loading = false;
  private loadGeneration = 0;
  private rowLimit = ROW_PAGE;
  private matchedCount = 0;
  private query = "";
  private contentSearch: ContentSearch | null = null;
  private pendingContentQuery: string | null = null;
  private contentSearchTimer: number | null = null;
  private renaming: string | null = null;
  private groupElements = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement, private readonly options: ChatHistoryPanelOptions) {
    super();
    this.element = parent.createDiv({
      cls: "systemsculpt-history-panel",
      attr: { "data-testid": "history.panel", role: "region", "aria-label": "Chat history" },
    });
    this.element.toggleAttribute("hidden", true);
    const header = this.element.createDiv({ cls: "systemsculpt-history-panel-header" });
    const back = createUiAction(header, {
      label: "Back to chat",
      testId: "history.close",
      icon: "arrow-left",
      size: "icon",
    });
    back.addClass("systemsculpt-history-panel-button");
    back.onclick = () => this.options.onClose();
    header.createEl("h2", { cls: "systemsculpt-history-panel-title", text: "Chats" });
    const create = createUiAction(header, {
      label: "New chat",
      testId: "history.new-chat",
      icon: "square-pen",
      size: "icon",
    });
    create.addClass("systemsculpt-history-panel-button");
    create.onclick = () => this.options.onNewChat();

    this.search = createUiSearch(this.element, {
      placeholder: "Search chats…",
      label: "Search chats",
      testId: "history.search",
      onQuery: (query) => this.handleQuery(query),
    });
    this.search.root.addClass("systemsculpt-history-panel-search");
    const input = this.search.input;
    // Registered before the combobox so its own keys see these first.
    this.registerDomEvent(input, "keydown", (event) => this.handleSearchKeydown(event));
    this.listEl = this.element.createDiv({
      cls: "systemsculpt-history-panel-list",
      attr: { "data-testid": "history.list" },
    });
    this.statusEl = this.element.createDiv({
      cls: "systemsculpt-history-panel-status",
      attr: { role: "status", "aria-live": "polite" },
    });
    this.showMoreEl = createUiAction(this.element, {
      label: "Show more",
      testId: "history.show-more",
      size: "small",
    });
    this.showMoreEl.addClass("systemsculpt-history-panel-more");
    this.showMoreEl.toggleAttribute("hidden", true);
    this.showMoreEl.onclick = () => {
      this.rowLimit += ROW_PAGE;
      this.combobox.refresh();
      this.search.input.focus();
    };
    this.combobox = new SurfaceCombobox<PanelItem>({
      input,
      listbox: this.listEl,
      listboxLabel: "Chats",
      initiallyOpen: true,
      bindInputEvents: false,
      activeMode: "selected",
      isSelected: (item) => this.options.isCurrent(item.row.chatId),
      navigation: "clamp",
      selectionFollowsActive: true,
      activeClass: "is-active",
      getItemKey: (item) => item.row.chatId,
      filterItems: (_items, query) => this.filter(query),
      renderOption: ({ item, index }) => this.renderRow(item, index),
      renderEmpty: () => this.syncStatus(true),
      onRender: () => this.syncFooter(),
      onCommit: ({ item, event }) => this.commit(item, event),
      onEscape: () => this.options.onClose(),
    });
    this.registerDomEvent(this.listEl, "contextmenu", (event) => {
      const row = this.rowFromTarget(event.target);
      if (!row) return;
      event.preventDefault();
      this.showRowMenu(row, { x: event.clientX, y: event.clientY });
    });
    // Typing anywhere in the panel goes to the search field.
    this.registerDomEvent(this.element, "keydown", (event) => {
      if (
        event.defaultPrevented
        || event.target === input
        || (event.target as HTMLElement | null)?.tagName === "INPUT"
        || event.key.length !== 1
        || event.metaKey
        || event.ctrlKey
        || event.altKey
      ) return;
      input.focus();
    });
  }

  public get isOpen(): boolean {
    return !this.element.hasAttribute("hidden");
  }

  public open(): void {
    this.element.toggleAttribute("hidden", false);
    this.rowLimit = ROW_PAGE;
    this.search.setValue("", { notify: false });
    this.query = "";
    this.contentSearch = null;
    this.pendingContentQuery = null;
    // Escape closes the combobox along with the panel; reopen it with the panel.
    this.combobox.setOpen(true);
    this.search.input.focus();
    void this.reload();
  }

  public close(): void {
    this.element.toggleAttribute("hidden", true);
    this.cancelContentSearchTimer();
    this.loadGeneration += 1;
    this.contentSearch = null;
    this.renaming = null;
  }

  public focusSearch(): void {
    this.search.input.focus();
    this.search.input.select();
  }

  public override onunload(): void {
    this.close();
    this.combobox.destroy();
  }

  /** Re-reads the rows, keeping the query and the active row. */
  public async reload(): Promise<void> {
    const generation = ++this.loadGeneration;
    this.loading = this.rows.length === 0;
    if (this.loading) this.combobox.setBusy(true);
    this.syncStatus(this.rows.length === 0);
    try {
      const rows = await this.options.loadRows();
      if (generation !== this.loadGeneration) return;
      this.rows = rows;
      this.contentSearch = null;
      this.scheduleContentSearch(this.query);
    } catch {
      if (generation !== this.loadGeneration) return;
      this.rows = [];
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
        this.combobox.setBusy(false);
      }
    }
    if (generation !== this.loadGeneration) return;
    this.combobox.setItems(this.rows.map((row) => ({ row, group: "" })), { preserveActive: true });
  }

  private handleQuery(query: string): void {
    const normalized = normalizeQuery(query);
    if (normalized !== this.query) {
      this.query = normalized;
      this.rowLimit = ROW_PAGE;
    }
    this.scheduleContentSearch(normalized);
    this.combobox.setQuery(query, { writeInput: false });
  }

  private filter(query: string): readonly PanelItem[] {
    const now = this.options.now?.() ?? Date.now();
    const normalized = normalizeQuery(query);
    const titleMatches = normalized
      ? this.rows.filter((row) => row.title.toLowerCase().includes(normalized))
      : this.rows;
    const ordered = [
      ...titleMatches.filter((row) => row.favorite),
      ...titleMatches.filter((row) => !row.favorite),
    ];
    const items: PanelItem[] = ordered.map((row) => ({
      row,
      group: chatHistoryGroup(row.timestampMs, row.favorite, now),
    }));
    const content = this.contentSearch?.query === normalized ? this.contentSearch : null;
    if (normalized && content) {
      const shown = new Set(titleMatches.map((row) => row.chatId));
      for (const row of this.rows) {
        if (!shown.has(row.chatId) && content.matches.has(row.chatId)) {
          items.push({ row, group: TEXT_MATCHES_GROUP });
        }
      }
    }
    this.matchedCount = items.length;
    return items.length > this.rowLimit ? items.slice(0, this.rowLimit) : items;
  }

  private renderRow(item: PanelItem, index: number): HTMLElement {
    if (index === 0) this.groupElements = new Map();
    let group = this.groupElements.get(item.group);
    if (!group) {
      const headingId = `systemsculpt-history-group-${this.groupElements.size}-${Math.random().toString(36).slice(2, 8)}`;
      group = this.listEl.createDiv({
        cls: "systemsculpt-history-group",
        attr: { role: "group", "aria-labelledby": headingId },
      });
      group.createDiv({ cls: "systemsculpt-history-group-title", text: item.group, attr: { id: headingId } });
      this.groupElements.set(item.group, group);
    }
    const { row } = item;
    const now = this.options.now?.() ?? Date.now();
    const option = group.createDiv({
      cls: "systemsculpt-history-item systemsculpt-history-row",
      attr: {
        "data-kind": "chat",
        "data-entry-id": `chat:${row.chatId}`,
        "data-chat-id": row.chatId,
        "data-testid": "history.row",
      },
    });
    const current = this.options.isCurrent(row.chatId);
    option.classList.toggle("is-current", current);
    if (current) option.setAttribute("aria-current", "true");
    if (row.favorite) {
      const star = option.createSpan({ cls: "systemsculpt-history-row-star", attr: { "aria-label": "Favorite" } });
      setIcon(star, "star");
    }
    const title = option.createSpan({ cls: "systemsculpt-history-row-title", text: row.title });
    title.title = row.title;
    const badge = BADGES[isLocalAgentId(row.backend) ? row.backend : "systemsculpt"];
    const badgeEl = option.createSpan({ cls: `systemsculpt-history-row-badge is-${row.backend}` });
    const badgeIcon = badgeEl.createSpan({ cls: "systemsculpt-history-row-icon", attr: { "aria-hidden": "true" } });
    setIcon(badgeIcon, badge.icon);
    badgeEl.createSpan({ text: badge.label });
    const meta = option.createSpan({ cls: "systemsculpt-history-row-time" });
    if (this.options.isRunning(row.chatId)) {
      meta.addClass("is-running");
      meta.setAttribute("aria-label", "Working");
      const spinner = meta.createSpan({ cls: "systemsculpt-history-row-icon is-spinning", attr: { "aria-hidden": "true" } });
      setIcon(spinner, "loader-circle");
    } else {
      meta.setText(chatHistoryTime(row.timestampMs, now));
      meta.title = chatHistoryFullTime(row.timestampMs);
    }
    const actions = option.createSpan({ cls: "systemsculpt-history-row-actions" });
    const favorite = createUiAction(actions, {
      label: row.favorite ? "Remove favorite" : "Add favorite",
      testId: "history.item.favorite",
      icon: row.favorite ? "star-off" : "star",
      size: "icon",
    });
    favorite.dataset.rowAction = "favorite";
    favorite.tabIndex = -1;
    const more = createUiAction(actions, {
      label: "More actions",
      testId: "history.row.more",
      icon: "more-horizontal",
      size: "icon",
    });
    more.dataset.rowAction = "more";
    more.tabIndex = -1;
    if (this.renaming === row.chatId) this.beginRename(option, row);
    return option;
  }

  private commit(item: PanelItem, event: Event): void | Promise<void> {
    const target = event.target as HTMLElement | null;
    const action = target?.closest?.<HTMLElement>("[data-row-action]")?.dataset.rowAction;
    if (action === "favorite") {
      event.preventDefault();
      event.stopPropagation();
      void this.toggleFavorite(item.row);
      return;
    }
    if (action === "more") {
      event.preventDefault();
      event.stopPropagation();
      const rect = target!.getBoundingClientRect();
      this.showRowMenu(item.row, { x: rect.left, y: rect.bottom });
      return;
    }
    if (this.renaming === item.row.chatId) return;
    const keyboard = event as KeyboardEvent | MouseEvent;
    return this.options.onOpen(item.row, keyboard.metaKey || keyboard.ctrlKey);
  }

  private handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft" && !this.search.input.value) {
      event.preventDefault();
      this.options.onClose();
      return;
    }
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const active = this.combobox.activeItem;
      const option = active ? this.optionFor(active.row.chatId) : null;
      if (!active || !option) return;
      event.preventDefault();
      const rect = option.getBoundingClientRect();
      this.showRowMenu(active.row, { x: rect.left + 16, y: rect.bottom });
    }
  }

  private showRowMenu(row: ChatHistoryRow, position: Readonly<{ x: number; y: number }>): void {
    const menu = new Menu().setUseNativeMenu(false);
    menu.addItem((item) => item
      .setTitle(row.favorite ? "Remove favorite" : "Add favorite")
      .setIcon(row.favorite ? "star-off" : "star")
      .onClick(() => void this.toggleFavorite(row)));
    menu.addItem((item) => item
      .setTitle("Rename")
      .setIcon("pencil")
      .onClick(() => this.startRename(row)));
    menu.addItem((item) => item
      .setTitle("Open in new tab")
      .setIcon("file-plus")
      .onClick(() => void this.options.onOpen(row, true)));
    menu.addSeparator();
    menu.addItem((item) => item
      .setTitle("Delete")
      .setIcon("trash-2")
      .setWarning(true)
      .onClick(() => void this.deleteRow(row)));
    menu.onHide(() => {
      returnFocusAfterMenu(this.element, () =>
        this.renaming !== row.chatId && this.isOpen ? this.search.input : null);
    });
    menu.showAtPosition(position, this.element.ownerDocument);
  }

  private async toggleFavorite(row: ChatHistoryRow): Promise<void> {
    await this.options.onToggleFavorite(row);
    await this.reload();
    this.search.input.focus();
  }

  private async deleteRow(row: ChatHistoryRow): Promise<void> {
    const deleted = await this.options.onDelete(row);
    if (deleted) await this.reload();
    if (this.isOpen) this.search.input.focus();
  }

  private startRename(row: ChatHistoryRow): void {
    this.renaming = row.chatId;
    const option = this.optionFor(row.chatId);
    if (option) this.beginRename(option, row);
  }

  private beginRename(option: HTMLElement, row: ChatHistoryRow): void {
    const title = option.querySelector<HTMLElement>(".systemsculpt-history-row-title");
    if (!title) return;
    const input = createUiInput(option, row.title);
    title.replaceWith(input);
    let settled = false;
    const finish = (save: boolean): void => {
      if (settled) return;
      settled = true;
      this.renaming = null;
      const next = input.value.trim();
      const done = save && next && next !== row.title
        ? this.options.onRename(row, next).then(() => this.reload())
        : Promise.resolve(this.combobox.refresh());
      void done.finally(() => {
        if (this.isOpen) this.search.input.focus();
      });
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    // Clicks in the field must not open the chat under it.
    for (const type of ["click", "pointerdown", "mousedown"]) {
      input.addEventListener(type, (event) => event.stopPropagation());
    }
    getSurfaceOwnerWindow(option).requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  private optionFor(chatId: string): HTMLElement | null {
    return Array.from(this.listEl.querySelectorAll<HTMLElement>(".systemsculpt-history-row"))
      .find((option) => option.dataset.chatId === chatId) ?? null;
  }

  private rowFromTarget(target: EventTarget | null): ChatHistoryRow | null {
    const option = (target as HTMLElement | null)?.closest?.<HTMLElement>(".systemsculpt-history-row");
    const chatId = option?.dataset.chatId;
    return chatId ? this.rows.find((row) => row.chatId === chatId) ?? null : null;
  }

  private scheduleContentSearch(query: string): void {
    this.cancelContentSearchTimer();
    if (query.length < CONTENT_SEARCH_MIN_CHARACTERS || this.rows.length === 0) {
      this.pendingContentQuery = null;
      return;
    }
    if (this.contentSearch?.query === query) {
      this.pendingContentQuery = this.contentSearch.complete ? null : query;
      return;
    }
    this.pendingContentQuery = query;
    const ownerWindow = getSurfaceOwnerWindow(this.element);
    this.contentSearchTimer = ownerWindow.setTimeout(() => {
      this.contentSearchTimer = null;
      void this.searchContent(query);
    }, CONTENT_SEARCH_DEBOUNCE_MS);
  }

  private cancelContentSearchTimer(): void {
    if (this.contentSearchTimer === null) return;
    getSurfaceOwnerWindow(this.element).clearTimeout(this.contentSearchTimer);
    this.contentSearchTimer = null;
  }

  /** Matches are appended under "Matches in chat text" as they are found. */
  private async searchContent(query: string): Promise<void> {
    const generation = this.loadGeneration;
    const search: ContentSearch = { query, matches: new Set(), complete: false };
    this.contentSearch = search;
    this.syncStatus(false);
    const rows = [...this.rows];
    let next = 0;
    const current = () => this.contentSearch === search && generation === this.loadGeneration;
    await Promise.all(Array.from({ length: Math.min(CONTENT_SEARCH_CONCURRENCY, rows.length) }, async () => {
      while (next < rows.length && current()) {
        const row = rows[next++];
        try {
          if ((await this.options.loadSearchText(row)).includes(query) && current()) {
            search.matches.add(row.chatId);
          }
        } catch {
          // An unreadable chat simply does not match.
        }
      }
    }));
    if (!current()) return;
    search.complete = true;
    if (this.pendingContentQuery === query) this.pendingContentQuery = null;
    this.combobox.refresh();
  }

  private syncFooter(): void {
    const remaining = this.matchedCount - this.rowLimit;
    this.showMoreEl.toggleAttribute("hidden", remaining <= 0);
    if (remaining > 0) {
      updateUiAction(this.showMoreEl, { label: `Show ${Math.min(remaining, ROW_PAGE)} more` });
    }
    this.syncStatus(this.matchedCount === 0);
  }

  private syncStatus(empty: boolean): void {
    const searching = Boolean(this.query) && this.pendingContentQuery === this.query;
    const text = this.loading
      ? "Loading chats…"
      : searching
        ? "Searching chat text…"
        : !empty
          ? ""
          : this.query
            ? `No chats match "${this.search.input.value.trim()}"`
            : "No chats yet";
    this.statusEl.setText(text);
    this.statusEl.toggleAttribute("hidden", !text);
    this.statusEl.classList.toggle("is-empty", empty && !this.loading && !searching);
  }
}

function createUiInput(parent: HTMLElement, value: string): HTMLInputElement {
  return parent.createEl("input", {
    cls: "systemsculpt-history-row-rename",
    attr: {
      type: "text",
      value,
      "aria-label": "Chat title",
      "data-testid": "history.row.rename",
    },
  });
}
