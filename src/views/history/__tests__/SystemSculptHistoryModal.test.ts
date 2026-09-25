/** @jest-environment jsdom */

import { App } from "obsidian";
import { SystemSculptHistoryModal } from "../SystemSculptHistoryModal";
import type { SystemSculptHistoryEntry } from "../types";

const entry = (id: string, title: string): SystemSculptHistoryEntry => ({
  id,
  kind: "chat",
  title,
  subtitle: `${title} subtitle`,
  timestampMs: Date.now(),
  searchText: title.toLowerCase(),
  openPrimary: jest.fn().mockResolvedValue(undefined),
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("SystemSculptHistoryModal lifecycle", () => {
  afterEach(() => document.body.empty());

  it("ignores a closed generation and renders only the reopened history request", async () => {
    let resolveStale!: (entries: SystemSculptHistoryEntry[]) => void;
    let staleSignal: AbortSignal | undefined;
    const loadEntries = jest
      .fn()
      .mockImplementationOnce((signal?: AbortSignal) => {
        staleSignal = signal;
        return new Promise<SystemSculptHistoryEntry[]>((resolve) => {
          resolveStale = resolve;
        });
      })
      .mockResolvedValueOnce([entry("fresh", "Fresh history")]);
    const plugin = { app: new App() } as any;
    const modal = new SystemSculptHistoryModal(plugin, { loadEntries });

    modal.open();
    modal.close();
    modal.open();
    await flush();

    expect(staleSignal?.aborted).toBe(true);
    expect(modal.modalEl.textContent).toContain("Fresh history");

    resolveStale([entry("stale", "Stale history")]);
    await flush();

    expect(loadEntries).toHaveBeenCalledTimes(2);
    expect(modal.modalEl.textContent).toContain("Fresh history");
    expect(modal.modalEl.textContent).not.toContain("Stale history");
  });

  it("delegates filtering, stable option semantics, wrapping navigation, and commit", async () => {
    const first = entry("first", "First chat");
    const second = entry("second", "Second chat");
    const plugin = { app: new App() } as any;
    const modal = new SystemSculptHistoryModal(plugin, {
      loadEntries: jest.fn().mockResolvedValue([first, second]),
    });

    modal.open();
    await flush();

    const input = modal.modalEl.querySelector<HTMLInputElement>("input[type=search]");
    const listbox = modal.modalEl.querySelector<HTMLElement>(".systemsculpt-history-list");
    expect(input?.getAttribute("role")).toBe("combobox");
    expect(input?.getAttribute("aria-controls")).toBe(listbox?.id);
    expect(listbox?.getAttribute("role")).toBe("listbox");

    input!.value = "second";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    const filteredOption = listbox?.querySelector<HTMLElement>("[role=option]");
    expect(listbox?.querySelectorAll("[role=option]")).toHaveLength(1);
    expect(filteredOption?.textContent).toContain("Second chat");
    const stableSecondId = filteredOption?.id;

    const clearButton = modal.modalEl.querySelector<HTMLElement>(
      ".ss-modal__search .search-input-clear-button",
    );
    expect(clearButton).not.toBeNull();
    clearButton!.click();
    expect(input!.value).toBe("");
    expect(listbox?.querySelectorAll("[role=option]")).toHaveLength(2);
    input!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    }));
    const options = listbox?.querySelectorAll<HTMLElement>("[role=option]");
    expect(options?.[1].id).toBe(stableSecondId);
    expect(options?.[1].classList.contains("is-selected")).toBe(true);
    expect(options?.[1].getAttribute("aria-selected")).toBe("true");
    expect(input?.getAttribute("aria-activedescendant")).toBe(options?.[1].id);

    input!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Home",
      bubbles: true,
      cancelable: true,
    }));
    expect(input?.getAttribute("aria-activedescendant")).toBe(options?.[0].id);
    input!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    }));
    input!.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }));
    await flush();

    expect(second.openPrimary).toHaveBeenCalledTimes(1);
    expect(first.openPrimary).not.toHaveBeenCalled();
  });
  it("searches message text only after two characters and a pause in typing", async () => {
    jest.useFakeTimers();
    try {
      const plan = { ...entry("plan", "Plan chat"), loadSearchText: jest.fn(async () => "the quarterly plan") };
      const other = { ...entry("other", "Other chat"), loadSearchText: jest.fn(async () => "unrelated") };
      const studio = entry("studio", "Studio board");
      const plugin = { app: new App() } as any;
      const modal = new SystemSculptHistoryModal(plugin, {
        loadEntries: jest.fn().mockResolvedValue([plan, other, studio]),
      });
      modal.open();
      await flush();
      const input = modal.modalEl.querySelector<HTMLInputElement>("input[type=search]")!;
      const listbox = modal.modalEl.querySelector<HTMLElement>(".systemsculpt-history-list")!;
      const type = (value: string) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };

      type("q");
      await jest.advanceTimersByTimeAsync(1_000);
      expect(plan.loadSearchText).not.toHaveBeenCalled();

      type("qu");
      type("quarter");
      await jest.advanceTimersByTimeAsync(200);
      expect(plan.loadSearchText).not.toHaveBeenCalled();
      expect(modal.modalEl.textContent).toContain("Searching chat text");

      await jest.advanceTimersByTimeAsync(100);
      await flush();
      expect(plan.loadSearchText).toHaveBeenCalledTimes(1);
      expect(other.loadSearchText).toHaveBeenCalledTimes(1);
      expect(listbox.querySelectorAll("[role=option]")).toHaveLength(1);
      expect(listbox.textContent).toContain("Plan chat");

      // Title matches still filter on every keystroke.
      type("studio");
      expect(listbox.querySelectorAll("[role=option]")).toHaveLength(1);
      expect(listbox.textContent).toContain("Studio board");
      modal.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it("renders a page of rows at a time and handles row controls without per-row listeners", async () => {
    const entries = Array.from({ length: 230 }, (_, index) => ({
      ...entry(`chat-${index}`, `Chat ${index}`),
      isFavorite: false,
      toggleFavorite: jest.fn(async () => true),
    }));
    const plugin = { app: new App() } as any;
    const modal = new SystemSculptHistoryModal(plugin, {
      loadEntries: jest.fn().mockResolvedValue(entries),
    });
    modal.open();
    await flush();
    const listbox = modal.modalEl.querySelector<HTMLElement>(".systemsculpt-history-list")!;
    const showMore = modal.modalEl.querySelector<HTMLButtonElement>("[data-testid='history.show-more']")!;
    const listeners = () => (modal as unknown as { listeners: unknown[] }).listeners.length;
    const baseline = listeners();

    expect(listbox.querySelectorAll("[role=option]")).toHaveLength(100);
    expect(showMore.hidden).toBe(false);
    expect(showMore.textContent).toBe("Show 100 more");
    showMore.click();
    expect(listbox.querySelectorAll("[role=option]")).toHaveLength(200);
    expect(showMore.textContent).toBe("Show 30 more");
    showMore.click();
    expect(listbox.querySelectorAll("[role=option]")).toHaveLength(230);
    expect(showMore.hidden).toBe(true);
    expect(listeners()).toBe(baseline);

    listbox.querySelector<HTMLButtonElement>(
      "[role=option] .systemsculpt-history-item-favorite",
    )!.click();
    await flush();
    expect(entries[0].toggleFavorite).toHaveBeenCalledTimes(1);
    expect(entries[0].openPrimary).not.toHaveBeenCalled();
    expect(entries[0].isFavorite).toBe(true);
    expect(listeners()).toBe(baseline);

    listbox.querySelector<HTMLElement>("[role=option] .systemsculpt-history-item-title")!.click();
    await flush();
    expect(entries[0].openPrimary).toHaveBeenCalledTimes(1);
  });
});
