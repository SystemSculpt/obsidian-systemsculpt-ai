/** @jest-environment jsdom */

import { Menu } from "obsidian";
import { ChatHistoryPanel, type ChatHistoryPanelOptions } from "../ChatHistoryPanel";
import { chatHistoryGroup, chatHistoryTime } from "../chatHistoryGroups";
import type { ChatHistoryRow } from "../chatHistoryRows";

type MockMenu = Menu & { items: Array<{ title?: string }>; select: (title: string) => unknown };
const menus = (): MockMenu[] => (Menu as unknown as { instances: MockMenu[] }).instances;

const NOW = new Date(2026, 9, 23, 16, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const row = (chatId: string, title: string, ageMs: number, extra: Partial<ChatHistoryRow> = {}): ChatHistoryRow => ({
  chatId,
  title,
  chatPath: `SystemSculpt/Chats/${chatId}.md`,
  timestampMs: NOW - ageMs,
  backend: "systemsculpt",
  favorite: false,
  ...extra,
});

const ROWS: ChatHistoryRow[] = [
  row("q4", "Plan the Q4 launch", 2 * 60 * 1000, { backend: "claude" }),
  row("links", "Fix broken links", HOUR, { backend: "codex" }),
  row("meeting", "Summarize meeting notes", DAY + HOUR),
  row("weekly", "Weekly review", 3 * DAY, { favorite: true }),
  row("reading", "Reading list", 12 * DAY),
  row("goals", "Quarterly goals", 40 * DAY),
];

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

function mount(overrides: Partial<ChatHistoryPanelOptions> = {}) {
  const parent = document.body.createDiv();
  const options: ChatHistoryPanelOptions = {
    loadRows: jest.fn(async () => ROWS),
    loadSearchText: jest.fn(async (entry: ChatHistoryRow) => entry.chatId === "goals" ? "we set okrs for the quarter" : ""),
    isCurrent: (chatId) => chatId === "links",
    isRunning: (chatId) => chatId === "meeting",
    onOpen: jest.fn(),
    onNewChat: jest.fn(),
    onClose: jest.fn(),
    onToggleFavorite: jest.fn(async () => undefined),
    onRename: jest.fn(async () => undefined),
    onDelete: jest.fn(async () => true),
    now: () => NOW,
    ...overrides,
  };
  const panel = new ChatHistoryPanel(parent, options);
  panel.load();
  return { parent, panel, options, search: parent.querySelector<HTMLInputElement>('[data-testid="history.search"]')! };
}

const keydown = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

const typeQuery = (search: HTMLInputElement, value: string) => {
  search.value = value;
  search.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("ChatHistoryPanel", () => {
  beforeEach(() => {
    document.body.empty();
    menus().length = 0;
  });

  it("groups chats with backend badges, compact times and the running chat", async () => {
    const { parent, panel, search } = mount();
    panel.open();
    await flush();
    expect(document.activeElement).toBe(search);
    expect(Array.from(parent.querySelectorAll(".systemsculpt-history-group-title"), (title) => title.textContent))
      .toEqual(["Favorites", "Today", "Yesterday", "Previous 30 days", "September"]);
    const rows = Array.from(parent.querySelectorAll<HTMLElement>('[data-testid="history.row"]'));
    expect(rows.map((option) => option.dataset.chatId)).toEqual(["weekly", "q4", "links", "meeting", "reading", "goals"]);
    expect(rows.every((option) => option.getAttribute("role") === "option")).toBe(true);
    expect(parent.querySelector('[data-testid="history.list"]')?.getAttribute("role")).toBe("listbox");
    expect(rows[1].querySelector(".systemsculpt-history-row-badge")?.textContent).toBe("Claude");
    expect(rows[2].querySelector(".systemsculpt-history-row-badge")?.textContent).toBe("Codex");
    expect(rows[0].querySelector(".systemsculpt-history-row-badge")?.textContent).toBe("SystemSculpt");
    expect(rows[1].querySelector(".systemsculpt-history-row-time")?.textContent).toBe("2m");
    expect(rows[3].querySelector(".systemsculpt-history-row-time")?.getAttribute("aria-label")).toBe("Working");
    // The open chat carries an accent bar and starts active, so Enter returns to it.
    expect(rows[2].classList.contains("is-current")).toBe(true);
    expect(rows[2].getAttribute("aria-current")).toBe("true");
    expect(rows[2].classList.contains("is-active")).toBe(true);
    panel.unload();
  });

  it("opens with Enter, in a new tab with Mod+Enter, and closes with Escape or ArrowLeft", async () => {
    const { panel, search, options } = mount();
    panel.open();
    await flush();
    keydown(search, "ArrowDown");
    keydown(search, "Enter");
    expect(options.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: "meeting" }), false);
    keydown(search, "Enter", { metaKey: true });
    expect(options.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: "meeting" }), true);
    keydown(search, "ArrowLeft");
    expect(options.onClose).toHaveBeenCalledTimes(1);
    keydown(search, "Escape");
    expect(options.onClose).toHaveBeenCalledTimes(2);
    panel.unload();
  });

  it("filters titles as you type, then appends full-text matches", async () => {
    jest.useFakeTimers();
    try {
      const { parent, panel, search, options } = mount();
      panel.open();
      await flush();
      typeQuery(search, "plan");
      expect(Array.from(parent.querySelectorAll<HTMLElement>('[data-testid="history.row"]'), (option) => option.dataset.chatId))
        .toEqual(["q4"]);
      // Enter opens the best match while searching.
      keydown(search, "Enter");
      expect(options.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: "q4" }), false);
      typeQuery(search, "okrs");
      expect(parent.querySelector(".systemsculpt-history-panel-status")?.textContent).toBe("Searching chat text…");
      jest.advanceTimersByTime(250);
      await flush();
      expect(Array.from(parent.querySelectorAll(".systemsculpt-history-group-title"), (title) => title.textContent))
        .toEqual(["Matches in chat text"]);
      expect(parent.querySelector<HTMLElement>('[data-testid="history.row"]')?.dataset.chatId).toBe("goals");
      typeQuery(search, "nothing like this");
      jest.advanceTimersByTime(250);
      await flush();
      expect(parent.querySelector(".systemsculpt-history-panel-status")?.textContent).toBe('No chats match "nothing like this"');
      panel.unload();
    } finally {
      jest.useRealTimers();
    }
  });

  it("says when there are no chats yet", async () => {
    const { parent, panel } = mount({ loadRows: jest.fn(async () => []) });
    panel.open();
    await flush();
    expect(parent.querySelector(".systemsculpt-history-panel-status")?.textContent).toBe("No chats yet");
    panel.unload();
  });

  it("offers favorite, rename, new tab and delete from the row menu and the keyboard", async () => {
    const { parent, panel, search, options } = mount();
    panel.open();
    await flush();
    keydown(search, "F10", { shiftKey: true });
    const menu = menus().at(-1)!;
    expect(menu.items.map((item) => item.title)).toEqual(["Add favorite", "Rename", "Open in new tab", undefined, "Delete"]);
    menu.select("Open in new tab");
    expect(options.onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ chatId: "links" }), true);

    keydown(search, "F10", { shiftKey: true });
    menus().at(-1)!.select("Add favorite");
    await flush();
    expect(options.onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ chatId: "links" }));

    keydown(search, "F10", { shiftKey: true });
    menus().at(-1)!.select("Delete");
    await flush();
    expect(options.onDelete).toHaveBeenCalledWith(expect.objectContaining({ chatId: "links" }));
    expect(options.loadRows).toHaveBeenCalledTimes(3);

    keydown(search, "F10", { shiftKey: true });
    menus().at(-1)!.select("Rename");
    const input = parent.querySelector<HTMLInputElement>('[data-testid="history.row.rename"]')!;
    expect(input.value).toBe("Fix broken links");
    input.value = "Fix every broken link";
    keydown(input, "Enter");
    await flush();
    expect(options.onRename).toHaveBeenCalledWith(expect.objectContaining({ chatId: "links" }), "Fix every broken link");
    panel.unload();
  });

  it("toggles a favorite from the row's own button without opening the chat", async () => {
    const { parent, panel, options } = mount();
    panel.open();
    await flush();
    parent.querySelector<HTMLButtonElement>('[data-chat-id="q4"] [data-testid="history.item.favorite"]')!.click();
    await flush();
    expect(options.onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ chatId: "q4" }));
    expect(options.onOpen).not.toHaveBeenCalled();
    panel.unload();
  });
});

describe("chat history groups and times", () => {
  it("groups by recency, then by month", () => {
    expect(chatHistoryGroup(NOW - HOUR, false, NOW, "en-US")).toBe("Today");
    expect(chatHistoryGroup(NOW - DAY, false, NOW, "en-US")).toBe("Yesterday");
    expect(chatHistoryGroup(NOW - 3 * DAY, false, NOW, "en-US")).toBe("Previous 7 days");
    expect(chatHistoryGroup(NOW - 20 * DAY, false, NOW, "en-US")).toBe("Previous 30 days");
    expect(chatHistoryGroup(NOW - 40 * DAY, false, NOW, "en-US")).toBe("September");
    expect(chatHistoryGroup(NOW - 400 * DAY, false, NOW, "en-US")).toBe("September 2025");
    expect(chatHistoryGroup(NOW - 400 * DAY, true, NOW, "en-US")).toBe("Favorites");
  });

  it("uses compact times", () => {
    expect(chatHistoryTime(NOW - 20 * 1000, NOW, "en-US")).toBe("now");
    expect(chatHistoryTime(NOW - 2 * 60 * 1000, NOW, "en-US")).toBe("2m");
    expect(chatHistoryTime(NOW - 3 * HOUR, NOW, "en-US")).toBe("3h");
    expect(chatHistoryTime(new Date(2026, 9, 22, 9, 14).getTime(), NOW, "en-US")).toBe("9:14 AM");
    expect(chatHistoryTime(new Date(2026, 9, 19, 9, 14).getTime(), NOW, "en-US")).toBe("Mon");
    expect(chatHistoryTime(new Date(2026, 9, 12, 9, 14).getTime(), NOW, "en-US")).toBe("Oct 12");
    expect(chatHistoryTime(0, NOW)).toBe("");
  });
});
