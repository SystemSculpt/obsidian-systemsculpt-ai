/**
 * @jest-environment jsdom
 */
import { App, Notice, requestUrl, TFile } from "obsidian";
import { EmbeddingsPendingFilesModal } from "../EmbeddingsPendingFilesModal";
import { PendingEmbeddingFile } from "../../services/embeddings/EmbeddingsManager";

jest.mock("obsidian", () => {
  const actual = jest.requireActual("obsidian");
  return { ...actual, Notice: jest.fn() };
});

const NOW = Date.now();

const mockedNotice = Notice as unknown as jest.Mock;

const createMockPendingFiles = (): PendingEmbeddingFile[] => [
  {
    path: "notes/machine-learning.md",
    reason: "missing",
    lastModified: NOW - 1000 * 60 * 30,
    lastEmbedded: null,
    size: 1024,
  },
  {
    path: "notes/deep-learning.md",
    reason: "modified",
    lastModified: NOW - 1000 * 60 * 60 * 2,
    lastEmbedded: NOW - 1000 * 60 * 60 * 24,
    size: 1024,
  },
  {
    path: "folder/nested/file.md",
    reason: "schema-mismatch",
    lastModified: NOW - 1000 * 60 * 60 * 48,
    lastEmbedded: NOW - 1000 * 60 * 60 * 72,
    size: 1024,
  },
  {
    path: "failed-file.md",
    reason: "failed",
    lastModified: NOW - 1000 * 60 * 10,
    lastEmbedded: null,
    size: 1024,
    failureInfo: {
      code: "rate_limited",
      message: "API rate limit exceeded",
      failedAt: NOW - 1000 * 60 * 5,
    },
  },
];

const createMockManager = (overrides: Record<string, any> = {}) => ({
  awaitReady: jest.fn().mockResolvedValue(undefined),
  listPendingFiles: jest.fn().mockResolvedValue(createMockPendingFiles()),
  ...overrides,
});

const createMockPlugin = (manager = createMockManager()) => {
  const app = new App();
  (app.vault as any).getAbstractFileByPath = jest.fn().mockImplementation((path: string) => {
    return new TFile({ path });
  });
  (app.workspace as any).getLeaf = jest.fn().mockReturnValue({
    openFile: jest.fn().mockResolvedValue(undefined),
  });
  return {
    app,
    getOrCreateEmbeddingsManager: jest.fn().mockReturnValue(manager),
    _testManager: manager,
  } as any;
};

describe("EmbeddingsPendingFilesModal", () => {
  let plugin: any;
  let modal: EmbeddingsPendingFilesModal;
  let mockManager: any;
  let originalClipboard: PropertyDescriptor | undefined;
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  beforeEach(() => {
    jest.clearAllMocks();
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: jest.fn().mockResolvedValue(undefined) }, configurable: true, writable: true,
    });
    mockManager = createMockManager();
    plugin = createMockPlugin(mockManager);
    modal = new EmbeddingsPendingFilesModal(plugin.app, plugin);
    const hostOnOpen = modal.onOpen.bind(modal);
    (modal as any).onOpen = () => {
      hostOnOpen();
      return (modal as any).pendingLoad;
    };
  });

  afterEach(() => {
    modal.onClose();
    modal.modalEl.remove();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
    jest.restoreAllMocks();
  });

  describe("initialization", () => {
    it("stores plugin reference", () => {
      expect((modal as any).plugin).toBe(plugin);
    });

    it("initializes empty file arrays", () => {
      expect((modal as any).allFiles).toEqual([]);
      expect((modal as any).filteredFiles).toEqual([]);
    });
  });

  describe("onOpen", () => {
    it("creates list element", async () => {
      await modal.onOpen();
      expect((modal as any).listEl).not.toBeNull();
    });

    it("creates summary container", async () => {
      await modal.onOpen();
      expect((modal as any).summaryContainerEl).not.toBeNull();
    });

    it("creates search input", async () => {
      await modal.onOpen();
      expect((modal as any).searchInput).not.toBeNull();
    });

    it("loads pending files on open", async () => {
      await modal.onOpen();
      expect(mockManager.listPendingFiles).toHaveBeenCalled();
    });

    it("awaits manager ready before loading", async () => {
      await modal.onOpen();
      expect(mockManager.awaitReady).toHaveBeenCalled();
    });
  });

  describe("loading state", () => {
    it("shows loading message initially", async () => {
      mockManager.listPendingFiles.mockImplementation(() => new Promise(() => {}));
      modal.onOpen();

      const loadingEl = (modal as any).listEl?.querySelector(".ss-ui-state");
      expect(loadingEl?.textContent).toContain("Collecting pending files");
    });

    it("disables search input while loading", async () => {
      mockManager.listPendingFiles.mockImplementation(() => new Promise(() => {}));
      modal.onOpen();

      expect((modal as any).searchInput?.disabled).toBe(true);
    });

    it("ignores a pending load after close and renders only the reopened request", async () => {
      let resolveStale!: (files: PendingEmbeddingFile[]) => void;
      mockManager.listPendingFiles
        .mockImplementationOnce(() => new Promise((resolve) => {
          resolveStale = resolve;
        }))
        .mockResolvedValueOnce([
          {
            path: "notes/fresh.md",
            reason: "missing",
            lastModified: NOW,
          },
        ]);

      const firstOpen = modal.onOpen();
      await Promise.resolve();
      modal.onClose();
      const reopened = modal.onOpen();
      await reopened;

      expect((modal as any).listEl?.textContent).toContain("fresh.md");

      resolveStale([
        {
          path: "notes/stale.md",
          reason: "missing",
          lastModified: NOW,
          lastEmbedded: null,
          size: 1024,
        },
      ]);
      await firstOpen;

      expect(mockManager.listPendingFiles).toHaveBeenCalledTimes(2);
      expect((modal as any).listEl?.textContent).toContain("fresh.md");
      expect((modal as any).listEl?.textContent).not.toContain("stale.md");
    });
  });

  describe("file list rendering", () => {
    it("renders pending files list on success", async () => {
      await modal.onOpen();

      const listEl = (modal as any).listEl;
      const items = listEl?.querySelectorAll(".ss-modal__item");
      expect(items?.length).toBe(4);
    });

    it("renders file names as titles", async () => {
      await modal.onOpen();

      const listEl = (modal as any).listEl;
      const titles = listEl?.querySelectorAll(".ss-modal__item-title");
      expect(titles?.[0]?.textContent).toBe("machine-learning.md");
      expect(titles?.[1]?.textContent).toBe("deep-learning.md");
    });

    it("adds failed class to failed items", async () => {
      await modal.onOpen();

      const listEl = (modal as any).listEl;
      const failedItems = listEl?.querySelectorAll(".ss-modal__item--failed");
      expect(failedItems?.length).toBe(1);
    });

    it("renders descriptions with folder and reason", async () => {
      await modal.onOpen();

      const listEl = (modal as any).listEl;
      const desc = listEl?.querySelector(".ss-modal__item-description");
      expect(desc?.textContent).toContain("notes");
      expect(desc?.textContent).toContain("Never embedded");
    });
  });

  it("virtualizes every filter pass without network calls, vault scans or new row listeners", async () => {
    const pending = Array.from({ length: 10_000 }, (_, index) => ({
      path: `notes/file-${index}.md`, reason: "missing" as const, lastModified: NOW,
    }));
    mockManager.listPendingFiles.mockResolvedValue(pending);
    const addListener = jest.spyOn(EventTarget.prototype, "addEventListener");
    const fetch = jest.spyOn(globalThis, "fetch");
    await modal.onOpen();
    const list = modal.modalEl.querySelector<HTMLElement>(".ss-modal__list")!;
    const search = modal.modalEl.querySelector<HTMLInputElement>('input[type="search"]')!;
    const detachedButton = list.querySelector<HTMLButtonElement>(".ss-modal__item")!;

    for (let pass = 0; pass < 30; pass++) {
      search.value = pass % 2 === 0 ? "notes" : "file";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      expect(list.querySelectorAll(".ss-modal__item").length).toBeLessThan(30);
      expect(modal.modalEl.textContent).toContain("10000 files still need embeddings");
    }
    const registrations = addListener.mock.calls.filter((_, index) => {
      const target = addListener.mock.contexts[index] as HTMLElement;
      return target === list || target.matches?.(".ss-modal__item");
    });
    addListener.mockRestore();
    expect(registrations.map(([type]) => type).sort()).toEqual(["click", "keydown", "scroll"]);
    expect(mockManager.listPendingFiles).toHaveBeenCalledTimes(1);
    for (const method of ["getMarkdownFiles", "getFiles", "getAllLoadedFiles", "read", "cachedRead"]) {
      expect(plugin.app.vault[method]).not.toHaveBeenCalled();
    }
    expect(requestUrl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();

    detachedButton.click();
    expect(plugin.app.workspace.getLeaf().openFile).not.toHaveBeenCalled();
    list.querySelector<HTMLElement>(".ss-modal__item-description")!.click();
    expect(plugin.app.workspace.getLeaf().openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "notes/file-0.md" }),
    );
    await Promise.resolve();
    modal.onClose();
  });

  describe("virtual list navigation", () => {
    beforeEach(() => {
      mockManager.listPendingFiles.mockResolvedValue(Array.from({ length: 10_000 }, (_, index) => ({
        path: `notes/file-${index}.md`, reason: "missing" as const, lastModified: NOW,
      })));
    });

    it("reaches the last result by scrolling and resets the range when filtering", async () => {
      await modal.onOpen();
      const list = modal.modalEl.querySelector<HTMLElement>(".ss-modal__list")!;
      Object.defineProperty(list, "clientHeight", { value: 216 });
      list.scrollTop = 9_999 * 72;
      list.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const last = list.querySelector<HTMLButtonElement>('[data-file-path="notes/file-9999.md"]')!;
      expect(last).not.toBeNull();
      expect(last.parentElement?.getAttribute("aria-posinset")).toBe("10000");
      expect(last.parentElement?.getAttribute("aria-setsize")).toBe("10000");
      list.scrollTop = 10 * 72;
      list.dispatchEvent(new Event("scroll"));
      await nextFrame();
      list.scrollTop = 8 * 72;
      list.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const indices = Array.from(list.querySelectorAll<HTMLElement>('[role="listitem"]'), (row) => Number(row.dataset.fileIndex));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
      expect(list.querySelectorAll("button").length).toBeLessThan(10);

      const search = modal.modalEl.querySelector<HTMLInputElement>('input[type="search"]')!;
      search.value = "file-9999.md";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      expect(list.scrollTop).toBe(0);
      expect(list.querySelectorAll("button")).toHaveLength(1);
      expect(list.querySelector('[role="listitem"]')?.getAttribute("aria-setsize")).toBe("1");
      list.querySelector<HTMLButtonElement>("button")!.click();
      expect(plugin.app.workspace.getLeaf().openFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: "notes/file-9999.md" }),
      );
    });

    it("preserves focus on scroll and navigates beyond mounted rows with Tab and arrow keys", async () => {
      document.body.append(modal.modalEl);
      await modal.onOpen();
      const list = modal.modalEl.querySelector<HTMLElement>(".ss-modal__list")!;
      Object.defineProperty(list, "clientHeight", { value: 216 });
      const first = list.querySelector<HTMLButtonElement>("button")!;
      first.focus();
      list.scrollTop = 9_999 * 72;
      list.dispatchEvent(new Event("scroll"));
      await nextFrame();
      expect(document.activeElement).toBe(first);
      expect(first.isConnected).toBe(true);
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect((document.activeElement as HTMLElement).dataset.filePath).toBe("notes/file-1.md");
      for (let index = 2; index <= 20; index++) {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        expect((document.activeElement as HTMLElement).dataset.filePath).toBe(`notes/file-${index}.md`);
      }
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      expect((document.activeElement as HTMLElement).dataset.filePath).toBe("notes/file-9999.md");
      const leaveList = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(leaveList);
      expect(leaveList.defaultPrevented).toBe(false);
      expect(list.querySelectorAll('button[tabindex="0"]')).toHaveLength(1);
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      expect((document.activeElement as HTMLElement).dataset.filePath).toBe("notes/file-0.md");
      const leaveBackwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(leaveBackwards);
      expect(leaveBackwards.defaultPrevented).toBe(false);
      modal.onClose();
      modal.modalEl.remove();
    });

    it("enters the full list in either direction from the surrounding controls", async () => {
      document.body.append(modal.modalEl);
      await modal.onOpen();
      const footerCopy = modal.modalEl.querySelectorAll<HTMLButtonElement>('[data-testid="embeddings.pending.copy-paths"]')[1]!;
      footerCopy.focus();
      footerCopy.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
      expect((document.activeElement as HTMLElement).dataset.filePath).toBe("notes/file-9999.md");
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      expect((document.activeElement as HTMLElement).dataset.filePath).toBe("notes/file-9998.md");
      const search = modal.modalEl.querySelector<HTMLInputElement>('input[type="search"]')!;
      search.focus();
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      expect((document.activeElement as HTMLElement).dataset.filePath).toBe("notes/file-0.md");
    });

    it("coalesces scroll paints and cancels a queued paint on close", async () => {
      await modal.onOpen();
      const frame = jest.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
      const cancel = jest.spyOn(window, "cancelAnimationFrame");
      const list = modal.modalEl.querySelector<HTMLElement>(".ss-modal__list")!;
      list.dispatchEvent(new Event("scroll"));
      list.dispatchEvent(new Event("scroll"));
      expect(frame).toHaveBeenCalledTimes(1);
      modal.onClose();
      expect(cancel).toHaveBeenCalledWith(42);
    });

    it("copies the entire filtered snapshot, not just mounted rows", async () => {
      await modal.onOpen();
      const copy = modal.modalEl.querySelector<HTMLButtonElement>('[data-testid="embeddings.pending.copy-paths"]')!;
      copy.click();
      await Promise.resolve();
      const paths = jest.mocked(navigator.clipboard.writeText).mock.calls[0]![0].split("\n");
      expect(paths).toHaveLength(10_000);
      expect(paths[9_999]).toBe("notes/file-9999.md");
    });

    it("tracks typography-probe resizing in layout pixels and preserves the logical scroll anchor", async () => {
      const original = Object.getOwnPropertyDescriptor(window, "ResizeObserver");
      let resize!: ResizeObserverCallback;
      const disconnect = jest.fn();
      const observe = jest.fn();
      Object.defineProperty(window, "ResizeObserver", {
        configurable: true,
        value: jest.fn((callback: ResizeObserverCallback) => {
          resize = callback;
          return { observe, disconnect };
        }),
      });
      let height = 96;
      const layoutHeight = jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
        return this.matches(".ss-pending-files__measure") ? height : 0;
      });
      // Transforms affect these bounds, but must never affect scroll geometry.
      const bounds = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 69.84 } as DOMRect);
      try {
        document.body.append(modal.modalEl);
        await modal.onOpen();
        const list = modal.modalEl.querySelector<HTMLElement>(".ss-modal__list")!;
        const content = list.querySelector<HTMLElement>(".ss-pending-files__content")!;
        let viewport = 360;
        Object.defineProperty(list, "clientHeight", { get: () => viewport });
        resize([], {} as ResizeObserver);
        expect(observe).toHaveBeenCalledWith(list);
        expect(observe).toHaveBeenCalledWith(modal.modalEl.querySelector(".ss-pending-files__measure"));
        expect(content.style.getPropertyValue("--ss-pending-list-height")).toBe("960000px");
        list.scrollTop = 5_000 * height + height / 2;
        height = 120;
        resize([], {} as ResizeObserver);
        expect(list.scrollTop).toBe(5_000 * height + height / 2);
        expect(list.querySelector('[data-file-path="notes/file-5000.md"]')).not.toBeNull();
        list.scrollTop = 10_000 * height - list.clientHeight;
        height = 144;
        viewport = 216; // Shrinks in the same delivery as the typography change.
        resize([], {} as ResizeObserver);
        expect(list.scrollTop).toBe(10_000 * height - list.clientHeight);
        expect(list.querySelector('[data-file-path="notes/file-9999.md"]')).not.toBeNull();
        viewport = 360;
        list.scrollTop = 10_000 * height - viewport; // Browser clamps after viewport growth.
        height = 156;
        resize([], {} as ResizeObserver);
        expect(list.scrollTop).toBe(10_000 * height - viewport);

        const search = modal.modalEl.querySelector<HTMLInputElement>('input[type="search"]')!;
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        height = 168; // No observer delivery yet: keyboard navigation must refresh first.
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        expect((document.activeElement as HTMLElement).dataset.filePath).toBe("notes/file-9999.md");
        expect(content.style.getPropertyValue("--ss-pending-list-height")).toBe("1680000px");
        modal.onClose();
        expect(disconnect).toHaveBeenCalledTimes(1);
        resize([], {} as ResizeObserver);
        expect(list.querySelectorAll("button").length).toBeLessThan(10);
      } finally {
        layoutHeight.mockRestore();
        bounds.mockRestore();
        if (original) Object.defineProperty(window, "ResizeObserver", original);
        else Reflect.deleteProperty(window, "ResizeObserver");
      }
    });
  });

  describe("empty states", () => {
    it("shows 'all done' when no pending files", async () => {
      mockManager.listPendingFiles.mockResolvedValue([]);
      await modal.onOpen();

      const emptyState = (modal as any).listEl?.querySelector(".ss-ui-state.is-success");
      expect(emptyState?.textContent).toContain("All eligible Markdown files have embeddings");
    });

    it("shows 'no matches' when filter returns empty", async () => {
      await modal.onOpen();

      (modal as any).applyFilter("nonexistent-xyz");

      const emptyState = (modal as any).listEl?.querySelector(".ss-ui-state.is-empty");
      expect(emptyState?.textContent).toContain("No files match this filter");
    });

    it("disables copy buttons when no files", async () => {
      mockManager.listPendingFiles.mockResolvedValue([]);
      await modal.onOpen();

      expect((modal as any).copyButtons.every((btn: HTMLButtonElement) => btn.disabled)).toBe(true);
    });
  });

  describe("filtering", () => {
    it("filters by path substring (case-insensitive)", async () => {
      await modal.onOpen();

      (modal as any).applyFilter("MACHINE");

      expect((modal as any).filteredFiles.length).toBe(1);
      expect((modal as any).filteredFiles[0].path).toBe("notes/machine-learning.md");
    });

    it("filters by folder name", async () => {
      await modal.onOpen();

      (modal as any).applyFilter("nested");

      expect((modal as any).filteredFiles.length).toBe(1);
      expect((modal as any).filteredFiles[0].path).toContain("nested");
    });

    it("clears filter to show all files", async () => {
      await modal.onOpen();

      (modal as any).applyFilter("machine");
      (modal as any).applyFilter("");

      expect((modal as any).filteredFiles.length).toBe(4);
    });

    it("updates summary after filtering", async () => {
      await modal.onOpen();

      (modal as any).applyFilter("deep");

      expect((modal as any).summaryTextEl?.textContent).toContain("1 of 4");
    });

    it("enables search input after load", async () => {
      await modal.onOpen();

      expect((modal as any).searchInput?.disabled).toBe(false);
    });
  });

  describe("file item interactions", () => {
    it("opens file on click", async () => {
      await modal.onOpen();

      const item = (modal as any).listEl?.querySelector(".ss-modal__item");
      item?.click();

      expect(plugin.app.workspace.getLeaf().openFile).toHaveBeenCalled();
    });

    it("uses a native button for keyboard activation", async () => {
      await modal.onOpen();

      const item = (modal as any).listEl?.querySelector(".ss-modal__item");
      expect(item?.tagName).toBe("BUTTON");
      expect(item?.getAttribute("type")).toBe("button");
    });

    it("gives each native file action a descriptive accessible name", async () => {
      await modal.onOpen();

      const item = (modal as any).listEl?.querySelector(".ss-modal__item");
      expect(item?.getAttribute("aria-label")).toBe("Open notes/machine-learning.md");
    });
  });

  describe("copy functionality", () => {
    it("copies all paths when no filter active and says so on the button", async () => {
      await modal.onOpen();
      const button = (modal as any).copyButtons[0] as HTMLButtonElement;
      await (modal as any).copyPaths(button);

      const written = (navigator.clipboard.writeText as jest.Mock).mock.calls[0][0];
      expect(written).toContain("notes/machine-learning.md");
      expect(written).toContain("notes/deep-learning.md");
      expect(written).toContain("folder/nested/file.md");
      expect(written).toContain("failed-file.md");
      expect(button.textContent).toContain("Copied");
      expect(mockedNotice).not.toHaveBeenCalled();
    });

    it("copies filtered paths when filter active", async () => {
      await modal.onOpen();
      (modal as any).applyFilter("machine");
      await (modal as any).copyPaths((modal as any).copyButtons[1]);

      const written = (navigator.clipboard.writeText as jest.Mock).mock.calls[0][0];
      expect(written).toBe("notes/machine-learning.md");
      expect(mockedNotice).not.toHaveBeenCalled();
    });

    it("disables Copy and never copies hidden paths when a filter has no matches", async () => {
      await modal.onOpen();
      (modal as any).applyFilter("nonexistent-xyz");

      expect((modal as any).copyButtons.every((button: HTMLButtonElement) => button.disabled)).toBe(true);
      await (modal as any).copyPaths((modal as any).copyButtons[0]);
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
      expect(mockedNotice).toHaveBeenCalledWith("No pending files to copy.");
    });

    it("enables copy buttons when files exist", async () => {
      await modal.onOpen();

      expect((modal as any).copyButtons.some((btn: HTMLButtonElement) => !btn.disabled)).toBe(true);
    });
  });

  describe("error handling", () => {
    it("shows error state on load failure", async () => {
      mockManager.listPendingFiles.mockRejectedValue(new Error("Network error"));
      await modal.onOpen();

      const errorEl = (modal as any).listEl?.querySelector(".ss-ui-state.is-error");
      expect(errorEl?.textContent).toContain("Network error");
    });

    it("disables copy buttons on error", async () => {
      mockManager.listPendingFiles.mockRejectedValue(new Error("Failed"));
      await modal.onOpen();

      expect((modal as any).copyButtons.every((btn: HTMLButtonElement) => btn.disabled)).toBe(true);
    });

    it("disables search input on error", async () => {
      mockManager.listPendingFiles.mockRejectedValue(new Error("Failed"));
      await modal.onOpen();

      expect((modal as any).searchInput?.disabled).toBe(true);
    });

    it("updates summary on error", async () => {
      mockManager.listPendingFiles.mockRejectedValue(new Error("Failed"));
      await modal.onOpen();

      expect((modal as any).summaryTextEl?.textContent).toContain("Unable to load");
    });
  });

  describe("reason formatting", () => {
    it("formats 'missing' as 'Never embedded'", () => {
      expect((modal as any).formatReason("missing")).toBe("Never embedded");
    });

    it("formats 'modified' as 'Needs refresh after edits'", () => {
      expect((modal as any).formatReason("modified")).toBe("Needs refresh after edits");
    });

    it("formats 'schema-mismatch' as a managed configuration change", () => {
      expect((modal as any).formatReason("schema-mismatch")).toBe("AI configuration changed");
    });

    it("formats 'metadata-missing' correctly", () => {
      expect((modal as any).formatReason("metadata-missing")).toBe("File metadata missing");
    });

    it("formats 'incomplete' correctly", () => {
      expect((modal as any).formatReason("incomplete")).toBe("Embedding incomplete (needs finish)");
    });

    it("formats 'empty' correctly", () => {
      expect((modal as any).formatReason("empty")).toBe("Empty note (no content)");
    });

    it("formats 'failed' correctly", () => {
      expect((modal as any).formatReason("failed")).toBe("Failed (retryable)");
    });

    it("returns 'Pending' for unknown reasons", () => {
      expect((modal as any).formatReason("unknown")).toBe("Pending");
    });
  });

  describe("relative time formatting", () => {
    it("formats recent times as 'just now'", () => {
      expect((modal as any).formatRelativeTime(NOW - 30000)).toBe("just now");
    });

    it("formats minutes correctly", () => {
      expect((modal as any).formatRelativeTime(NOW - 5 * 60 * 1000)).toBe("5 min ago");
    });

    it("formats hours correctly", () => {
      expect((modal as any).formatRelativeTime(NOW - 3 * 60 * 60 * 1000)).toBe("3 hrs ago");
    });

    it("formats single hour correctly", () => {
      expect((modal as any).formatRelativeTime(NOW - 1 * 60 * 60 * 1000)).toBe("1 hr ago");
    });

    it("formats days correctly", () => {
      expect((modal as any).formatRelativeTime(NOW - 2 * 24 * 60 * 60 * 1000)).toBe("2 days ago");
    });

    it("formats single day correctly", () => {
      expect((modal as any).formatRelativeTime(NOW - 1 * 24 * 60 * 60 * 1000)).toBe("1 day ago");
    });

    it("formats old dates as locale date string", () => {
      const oldDate = NOW - 30 * 24 * 60 * 60 * 1000;
      const result = (modal as any).formatRelativeTime(oldDate);
      expect(result).toMatch(/\d/);
    });

    it("handles future timestamps", () => {
      expect((modal as any).formatRelativeTime(NOW + 10000)).toBe("just now");
    });
  });

  describe("path extraction", () => {
    it("extracts file name from path", () => {
      expect((modal as any).extractFileName("folder/subfolder/file.md")).toBe("file.md");
    });

    it("handles root-level files", () => {
      expect((modal as any).extractFileName("file.md")).toBe("file.md");
    });

    it("extracts folder from path", () => {
      expect((modal as any).extractFolder("folder/subfolder/file.md")).toBe("folder/subfolder");
    });

    it("returns 'Vault root' for root-level files", () => {
      expect((modal as any).extractFolder("file.md")).toBe("Vault root");
    });
  });

  describe("description building", () => {
    it("includes folder in description", async () => {
      const entry: PendingEmbeddingFile = {
        path: "folder/test.md",
        reason: "missing",
        lastModified: NOW - 1000,
        lastEmbedded: null,
        size: 1024,
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("folder");
    });

    it("includes modified time in description", async () => {
      const entry: PendingEmbeddingFile = {
        path: "test.md",
        reason: "missing",
        lastModified: NOW - 1000,
        lastEmbedded: null,
        size: 1024,
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("Modified");
    });

    it("includes reason in description", async () => {
      const entry: PendingEmbeddingFile = {
        path: "test.md",
        reason: "modified",
        lastModified: NOW - 1000,
        lastEmbedded: null,
        size: 1024,
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("Needs refresh after edits");
    });

    it("includes failure info when present", async () => {
      const entry: PendingEmbeddingFile = {
        path: "test.md",
        reason: "failed",
        lastModified: NOW - 1000,
        lastEmbedded: null,
        size: 1024,
        failureInfo: {
          code: "rate_limited",
          message: "Rate limit",
          failedAt: NOW - 5000,
        },
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("Rate limit");
      expect(desc).toContain("Error:");
    });

    it("includes last embedded time when available", async () => {
      const entry: PendingEmbeddingFile = {
        path: "test.md",
        reason: "modified",
        lastModified: NOW - 1000,
        lastEmbedded: NOW - 60000,
        size: 1024,
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("Last embedded");
    });
  });

  describe("summary updates", () => {
    it("shows total count when no filter", async () => {
      await modal.onOpen();

      expect((modal as any).summaryTextEl?.textContent).toContain("4 files still need embeddings");
    });

    it("shows filtered vs total when filter active", async () => {
      await modal.onOpen();
      (modal as any).applyFilter("learning");

      expect((modal as any).summaryTextEl?.textContent).toContain("2 of 4");
    });

    it("shows all done message when no pending files", async () => {
      mockManager.listPendingFiles.mockResolvedValue([]);
      await modal.onOpen();

      expect((modal as any).summaryTextEl?.textContent).toContain("All eligible Markdown files");
    });
  });
});
