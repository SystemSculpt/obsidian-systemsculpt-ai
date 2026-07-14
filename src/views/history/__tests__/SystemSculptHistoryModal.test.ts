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

    modal.modalEl.querySelector<HTMLElement>(
      ".ss-modal__search .search-input-clear-button",
    )?.click();
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
});
