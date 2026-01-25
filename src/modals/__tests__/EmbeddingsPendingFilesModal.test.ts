/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { EmbeddingsPendingFilesModal } from "../EmbeddingsPendingFilesModal";
import { PendingEmbeddingFile } from "../../services/embeddings/EmbeddingsManager";

const NOW = Date.now();

const createMockPendingFiles = (): PendingEmbeddingFile[] => [
  {
    path: "notes/machine-learning.md",
    reason: "missing",
    lastModified: NOW - 1000 * 60 * 30,
  },
  {
    path: "notes/deep-learning.md",
    reason: "modified",
    lastModified: NOW - 1000 * 60 * 60 * 2,
    lastEmbedded: NOW - 1000 * 60 * 60 * 24,
  },
  {
    path: "folder/nested/file.md",
    reason: "schema-mismatch",
    lastModified: NOW - 1000 * 60 * 60 * 48,
    lastEmbedded: NOW - 1000 * 60 * 60 * 72,
  },
  {
    path: "failed-file.md",
    reason: "failed",
    lastModified: NOW - 1000 * 60 * 10,
    failureInfo: {
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockManager = createMockManager();
    plugin = createMockPlugin(mockManager);
    modal = new EmbeddingsPendingFilesModal(plugin.app, plugin);
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

      const loadingEl = (modal as any).loadingEl;
      expect(loadingEl?.textContent).toContain("Collecting pending files");
    });

    it("disables search input while loading", async () => {
      mockManager.listPendingFiles.mockImplementation(() => new Promise(() => {}));
      modal.onOpen();

      expect((modal as any).searchInput?.disabled).toBe(true);
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

  describe("empty states", () => {
    it("shows 'all done' when no pending files", async () => {
      mockManager.listPendingFiles.mockResolvedValue([]);
      await modal.onOpen();

      const emptyState = (modal as any).listEl?.querySelector(".ss-modal__empty-state");
      expect(emptyState?.textContent).toContain("All eligible markdown files already have embeddings");
    });

    it("shows 'no matches' when filter returns empty", async () => {
      await modal.onOpen();

      (modal as any).applyFilter("nonexistent-xyz");

      const emptyState = (modal as any).listEl?.querySelector(".ss-modal__empty-state");
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

    it("opens file on Enter key", async () => {
      await modal.onOpen();

      const item = (modal as any).listEl?.querySelector(".ss-modal__item");
      const event = new KeyboardEvent("keypress", { key: "Enter" });
      item?.dispatchEvent(event);

      expect(plugin.app.workspace.getLeaf().openFile).toHaveBeenCalled();
    });

    it("opens file on Space key", async () => {
      await modal.onOpen();

      const item = (modal as any).listEl?.querySelector(".ss-modal__item");
      const event = new KeyboardEvent("keypress", { key: " " });
      item?.dispatchEvent(event);

      expect(plugin.app.workspace.getLeaf().openFile).toHaveBeenCalled();
    });
  });

  describe("copy functionality", () => {
    beforeEach(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: jest.fn().mockResolvedValue(undefined),
        },
        writable: true,
      });
    });

    it("copies all paths when no filter active", async () => {
      await modal.onOpen();
      await (modal as any).copyPaths();

      const written = (navigator.clipboard.writeText as jest.Mock).mock.calls[0][0];
      expect(written).toContain("notes/machine-learning.md");
      expect(written).toContain("notes/deep-learning.md");
      expect(written).toContain("folder/nested/file.md");
      expect(written).toContain("failed-file.md");
    });

    it("copies filtered paths when filter active", async () => {
      await modal.onOpen();
      (modal as any).applyFilter("machine");
      await (modal as any).copyPaths();

      const written = (navigator.clipboard.writeText as jest.Mock).mock.calls[0][0];
      expect(written).toBe("notes/machine-learning.md");
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

      const errorEl = (modal as any).listEl?.querySelector(".ss-modal__error");
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

    it("formats 'schema-mismatch' as 'Provider/config changed'", () => {
      expect((modal as any).formatReason("schema-mismatch")).toBe("Provider/config changed");
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
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("folder");
    });

    it("includes modified time in description", async () => {
      const entry: PendingEmbeddingFile = {
        path: "test.md",
        reason: "missing",
        lastModified: NOW - 1000,
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("Modified");
    });

    it("includes reason in description", async () => {
      const entry: PendingEmbeddingFile = {
        path: "test.md",
        reason: "modified",
        lastModified: NOW - 1000,
      };
      const desc = (modal as any).buildDescription(entry);
      expect(desc).toContain("Needs refresh after edits");
    });

    it("includes failure info when present", async () => {
      const entry: PendingEmbeddingFile = {
        path: "test.md",
        reason: "failed",
        lastModified: NOW - 1000,
        failureInfo: {
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

      expect((modal as any).summaryTextEl?.textContent).toContain("All eligible markdown files");
    });
  });
});
