/**
 * @jest-environment jsdom
 */
import { App, TFile } from "obsidian";
import { ContextSelectionModal } from "../ContextSelectionModal";

const createMockFiles = (): TFile[] => [
  new TFile({ path: "notes/meeting.md" }),
  new TFile({ path: "notes/project.md" }),
  new TFile({ path: "docs/readme.txt" }),
  new TFile({ path: "images/diagram.png" }),
  new TFile({ path: "images/photo.jpg" }),
  new TFile({ path: "documents/report.pdf" }),
  new TFile({ path: "audio/recording.mp3" }),
  new TFile({ path: "folder/subfolder/nested.md" }),
];

const createMockApp = () => {
  const app = new App();
  (app.vault as any).getFiles = jest.fn().mockReturnValue(createMockFiles());
  return app;
};

const createMockPlugin = () => ({
  settings: {},
} as any);

describe("ContextSelectionModal", () => {
  let app: App;
  let plugin: any;
  let onSelect: jest.Mock;
  let modal: ContextSelectionModal;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMockApp();
    plugin = createMockPlugin();
    onSelect = jest.fn().mockResolvedValue(undefined);
    modal = new ContextSelectionModal(app, onSelect, plugin);
  });

  describe("initialization", () => {
    it("stores onSelect callback", () => {
      expect((modal as any).onSelect).toBe(onSelect);
    });

    it("stores plugin reference", () => {
      expect((modal as any).plugin).toBe(plugin);
    });

    it("initializes files from vault", () => {
      expect((modal as any).files.length).toBeGreaterThan(0);
    });

    it("initializes with 'all' filter", () => {
      expect((modal as any).currentFilter).toBe("all");
    });

    it("initializes with empty search query", () => {
      expect((modal as any).searchQuery).toBe("");
    });

    it("initializes with empty selection", () => {
      expect((modal as any).selectedFiles.size).toBe(0);
    });
  });

  describe("file listing", () => {
    it("loads all supported files from vault", () => {
      const files = (modal as any).files;
      expect(files.length).toBe(8);
    });

    it("categorizes files by type", () => {
      const files = (modal as any).files as Array<{ type: string }>;
      const types = files.map((f) => f.type);
      expect(types).toContain("text");
      expect(types).toContain("images");
      expect(types).toContain("documents");
      expect(types).toContain("audio");
    });

    it("sorts files by basename", () => {
      const files = (modal as any).files as Array<{ file: TFile }>;
      for (let i = 1; i < files.length; i++) {
        expect(files[i - 1].file.basename.localeCompare(files[i].file.basename)).toBeLessThanOrEqual(0);
      }
    });

    it("creates searchText for each file", () => {
      const files = (modal as any).files as Array<{ searchText: string }>;
      expect(files.every((f) => f.searchText.length > 0)).toBe(true);
    });

    it("searchText includes basename", () => {
      const files = (modal as any).files as Array<{ file: TFile; searchText: string }>;
      files.forEach((f) => {
        expect(f.searchText).toContain(f.file.basename.toLowerCase());
      });
    });
  });

  describe("filtering", () => {
    it("filters by text type", () => {
      (modal as any).setFilter("text", document.createElement("button"));

      const filtered = (modal as any).filteredFiles;
      expect(filtered.every((f: any) => f.type === "text")).toBe(true);
    });

    it("filters by images type", () => {
      (modal as any).setFilter("images", document.createElement("button"));

      const filtered = (modal as any).filteredFiles;
      expect(filtered.every((f: any) => f.type === "images")).toBe(true);
    });

    it("filters by documents type", () => {
      (modal as any).setFilter("documents", document.createElement("button"));

      const filtered = (modal as any).filteredFiles;
      expect(filtered.every((f: any) => f.type === "documents")).toBe(true);
    });

    it("filters by audio type", () => {
      (modal as any).setFilter("audio", document.createElement("button"));

      const filtered = (modal as any).filteredFiles;
      expect(filtered.every((f: any) => f.type === "audio")).toBe(true);
    });

    it("shows all files with 'all' filter", () => {
      (modal as any).setFilter("text", document.createElement("button"));
      (modal as any).setFilter("all", document.createElement("button"));

      const filtered = (modal as any).filteredFiles;
      expect(filtered.length).toBe(8);
    });
  });

  describe("search filtering", () => {
    it("filters by search query", () => {
      (modal as any).searchQuery = "meeting";
      (modal as any).applyFilters();

      const filtered = (modal as any).filteredFiles;
      expect(filtered.length).toBe(1);
      expect(filtered[0].file.basename).toBe("meeting");
    });

    it("search is case-insensitive", () => {
      (modal as any).searchQuery = "meeting";
      (modal as any).applyFilters();

      const filtered = (modal as any).filteredFiles;
      expect(filtered.length).toBe(1);
    });

    it("searches in path", () => {
      (modal as any).searchQuery = "subfolder";
      (modal as any).applyFilters();

      const filtered = (modal as any).filteredFiles;
      expect(filtered.length).toBe(1);
      expect(filtered[0].file.path).toContain("subfolder");
    });

    it("combines type and search filters", () => {
      (modal as any).currentFilter = "text";
      (modal as any).searchQuery = "nested";
      (modal as any).applyFilters();

      const filtered = (modal as any).filteredFiles;
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe("text");
    });

    it("returns empty when no match", () => {
      (modal as any).searchQuery = "nonexistent-xyz";
      (modal as any).applyFilters();

      const filtered = (modal as any).filteredFiles;
      expect(filtered.length).toBe(0);
    });
  });

  describe("selection", () => {
    it("toggles selection on file", () => {
      const file = (modal as any).files[0].file;
      (modal as any).toggleFileSelection(file);

      expect((modal as any).selectedFiles.has(file)).toBe(true);
    });

    it("toggles selection off file", () => {
      const file = (modal as any).files[0].file;
      (modal as any).toggleFileSelection(file);
      (modal as any).toggleFileSelection(file);

      expect((modal as any).selectedFiles.has(file)).toBe(false);
    });

    it("tracks multiple selections", () => {
      const file1 = (modal as any).files[0].file;
      const file2 = (modal as any).files[1].file;

      (modal as any).toggleFileSelection(file1);
      (modal as any).toggleFileSelection(file2);

      expect((modal as any).selectedFiles.size).toBe(2);
    });
  });

  describe("add button state", () => {
    it("button is disabled when no selection", () => {
      const btn = {
        setButtonText: jest.fn().mockReturnThis(),
        setDisabled: jest.fn().mockReturnThis(),
        setCta: jest.fn().mockReturnThis(),
      };

      (modal as any).updateAddButton(btn);

      expect(btn.setButtonText).toHaveBeenCalledWith("Add Files");
      expect(btn.setDisabled).toHaveBeenCalledWith(true);
    });

    it("button shows count when files selected", () => {
      const file = (modal as any).files[0].file;
      (modal as any).selectedFiles.add(file);

      const btn = {
        setButtonText: jest.fn().mockReturnThis(),
        setDisabled: jest.fn().mockReturnThis(),
        setCta: jest.fn().mockReturnThis(),
      };

      (modal as any).updateAddButton(btn);

      expect(btn.setButtonText).toHaveBeenCalledWith("Add 1 File");
      expect(btn.setDisabled).toHaveBeenCalledWith(false);
    });

    it("button pluralizes correctly for multiple files", () => {
      (modal as any).selectedFiles.add((modal as any).files[0].file);
      (modal as any).selectedFiles.add((modal as any).files[1].file);

      const btn = {
        setButtonText: jest.fn().mockReturnThis(),
        setDisabled: jest.fn().mockReturnThis(),
        setCta: jest.fn().mockReturnThis(),
      };

      (modal as any).updateAddButton(btn);

      expect(btn.setButtonText).toHaveBeenCalledWith("Add 2 Files");
    });
  });

  describe("submission", () => {
    it("calls onSelect with selected files", async () => {
      const file1 = (modal as any).files[0].file;
      const file2 = (modal as any).files[1].file;
      (modal as any).selectedFiles.add(file1);
      (modal as any).selectedFiles.add(file2);

      await (modal as any).handleSelection();

      expect(onSelect).toHaveBeenCalled();
      const selectedArray = onSelect.mock.calls[0][0];
      expect(selectedArray).toContain(file1);
      expect(selectedArray).toContain(file2);
    });

    it("does not call onSelect when nothing selected", async () => {
      await (modal as any).handleSelection();

      expect(onSelect).not.toHaveBeenCalled();
    });

    it("keeps modal open on error", async () => {
      const file = (modal as any).files[0].file;
      (modal as any).selectedFiles.add(file);
      onSelect.mockRejectedValue(new Error("Processing failed"));

      const closeSpy = jest.spyOn(modal, "close");
      await (modal as any).handleSelection();

      expect(closeSpy).not.toHaveBeenCalled();
    });
  });

  describe("loading state", () => {
    it("shows loading text on button during processing", () => {
      (modal as any).addButton = {
        setButtonText: jest.fn().mockReturnThis(),
        setDisabled: jest.fn().mockReturnThis(),
        buttonEl: {
          removeClass: jest.fn(),
        },
      };

      (modal as any).setLoadingState(true);

      expect((modal as any).addButton.setButtonText).toHaveBeenCalledWith("Processing...");
      expect((modal as any).addButton.setDisabled).toHaveBeenCalledWith(true);
    });

    it("restores button state after processing", () => {
      (modal as any).addButton = {
        setButtonText: jest.fn().mockReturnThis(),
        setDisabled: jest.fn().mockReturnThis(),
        setCta: jest.fn().mockReturnThis(),
        buttonEl: {
          removeClass: jest.fn(),
        },
      };

      (modal as any).setLoadingState(false);

      expect((modal as any).addButton.setButtonText).toHaveBeenCalled();
    });
  });

  describe("onOpen", () => {
    it("sets modal title", () => {
      modal.onOpen();

      expect(modal.titleEl.textContent).toBe("Add Context Files");
    });

    it("creates filter container", () => {
      modal.onOpen();

      const filterContainer = modal.contentEl.querySelector(".ss-context-filter-container");
      expect(filterContainer).not.toBeNull();
    });

    it("creates file list container", () => {
      modal.onOpen();

      const listContainer = modal.contentEl.querySelector(".ss-context-file-list");
      expect(listContainer).not.toBeNull();
    });

    it("creates filter buttons", () => {
      modal.onOpen();

      const buttons = modal.contentEl.querySelectorAll(".ss-context-filter-btn");
      expect(buttons.length).toBe(5);
    });

    it("sets 'All' button as active by default", () => {
      modal.onOpen();

      const allBtn = modal.contentEl.querySelector(".ss-context-filter-btn.is-active");
      expect(allBtn?.textContent).toBe("All");
    });
  });

  describe("onClose", () => {
    it("clears content", () => {
      modal.onOpen();
      modal.onClose();

      expect(modal.contentEl.children.length).toBe(0);
    });

    it("clears selection", () => {
      const file = (modal as any).files[0].file;
      (modal as any).selectedFiles.add(file);

      modal.onClose();

      expect((modal as any).selectedFiles.size).toBe(0);
    });
  });

  describe("empty state", () => {
    it("shows empty message when no files match", () => {
      modal.onOpen();
      (modal as any).searchQuery = "nonexistent-xyz-abc";
      (modal as any).applyFilters();

      const emptyEl = modal.contentEl.querySelector(".ss-context-empty");
      expect(emptyEl).not.toBeNull();
      expect(emptyEl?.textContent).toContain("No files found");
    });
  });

  describe("file list display limit", () => {
    it("limits display to 100 files", () => {
      const manyFiles = Array.from({ length: 150 }, (_, i) => new TFile({ path: `file${i}.md` }));
      (app.vault as any).getFiles = jest.fn().mockReturnValue(manyFiles);
      modal = new ContextSelectionModal(app, onSelect, plugin);
      modal.onOpen();

      const items = modal.contentEl.querySelectorAll(".ss-context-file-item");
      expect(items.length).toBeLessThanOrEqual(100);
    });

    it("shows 'show more' link when files exceed 100", () => {
      const manyFiles = Array.from({ length: 150 }, (_, i) => new TFile({ path: `file${i}.md` }));
      (app.vault as any).getFiles = jest.fn().mockReturnValue(manyFiles);
      modal = new ContextSelectionModal(app, onSelect, plugin);
      modal.onOpen();

      const loadMore = modal.contentEl.querySelector(".ss-context-load-more");
      expect(loadMore).not.toBeNull();
    });
  });

  describe("file rendering", () => {
    it("renders file items", () => {
      modal.onOpen();

      const items = modal.contentEl.querySelectorAll(".ss-context-file-item");
      expect(items.length).toBeGreaterThan(0);
    });

    it("renders file name", () => {
      modal.onOpen();

      const nameEl = modal.contentEl.querySelector(".ss-context-file-name");
      expect(nameEl).not.toBeNull();
    });

    it("renders file path", () => {
      modal.onOpen();

      const pathEl = modal.contentEl.querySelector(".ss-context-file-path");
      expect(pathEl).not.toBeNull();
    });

    it("renders checkbox for each file", () => {
      modal.onOpen();

      const checkboxes = modal.contentEl.querySelectorAll("input");
      expect(checkboxes.length).toBeGreaterThan(0);
    });

    it("applies selected class to selected files", () => {
      modal.onOpen();

      const file = (modal as any).files[0].file;
      (modal as any).toggleFileSelection(file);

      const selectedItems = modal.contentEl.querySelectorAll(".ss-context-file-item.is-selected");
      expect(selectedItems.length).toBe(1);
    });
  });

  describe("filter button click", () => {
    it("updates current filter on button click", () => {
      modal.onOpen();

      const btn = document.createElement("button");
      const container = document.createElement("div");
      container.appendChild(btn);
      btn.addClass("ss-context-filter-btn");

      (modal as any).setFilter("images", btn);

      expect((modal as any).currentFilter).toBe("images");
    });

    it("updates button active state", () => {
      modal.onOpen();

      const btn = document.createElement("button");
      const container = document.createElement("div");
      const otherBtn = document.createElement("button");
      otherBtn.addClass("ss-context-filter-btn");
      otherBtn.addClass("is-active");
      container.appendChild(otherBtn);
      container.appendChild(btn);
      btn.addClass("ss-context-filter-btn");

      (modal as any).setFilter("images", btn);

      expect(btn.classList.contains("is-active")).toBe(true);
      expect(otherBtn.classList.contains("is-active")).toBe(false);
    });
  });
});
