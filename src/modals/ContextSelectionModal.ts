import { App, Notice, TFile, setIcon } from "obsidian";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { createUiAction, getSurfaceOwnerWindow } from "../core/ui/surface";
import {
  AUDIO_FILE_EXTENSIONS,
  VAULT_IMAGE_CONTEXT_EXTENSIONS,
} from "../constants/fileTypes";

const FILE_TYPES = {
  text: { extensions: ["md", "txt", "systemsculpt"], icon: "file-text", label: "Text & Studio" },
  documents: { extensions: ["pdf"], icon: "file", label: "Documents" },
  images: { extensions: Array.from(VAULT_IMAGE_CONTEXT_EXTENSIONS), icon: "image", label: "Images" },
  audio: { extensions: Array.from(AUDIO_FILE_EXTENSIONS), icon: "headphones", label: "Audio" },
} as const;

type ContextFileType = keyof typeof FILE_TYPES;
type ContextFilter = ContextFileType | "all";

interface FileItem {
  file: TFile;
  type: ContextFileType;
  searchText: string;
}

export interface ContextSelectionModalOptions {
  isFileAlreadyPinned?: (file: TFile) => boolean;
  initialFilter?: ContextFilter;
  initialSearchQuery?: string;
  initialSelectedPaths?: string[];
  autoFocusSearch?: boolean;
}

/** Keyboard-native, multi-select vault context picker on the shared modal shell. */
export class ContextSelectionModal extends StandardModal {
  private readonly files: FileItem[];
  private filteredFiles: FileItem[] = [];
  private readonly selectedFiles = new Set<TFile>();
  private currentFilter: ContextFilter;
  private searchQuery: string;
  private readonly onSelect: (files: TFile[]) => void | Promise<void>;
  private readonly isFileAlreadyPinned?: (file: TFile) => boolean;
  private readonly initialSearchQuery: string;
  private readonly autoFocusSearch: boolean;
  private readonly maxRenderedFiles = 100;
  private renderedCount = 0;
  private listContainer: HTMLUListElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private addButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private loadMoreButton: HTMLButtonElement | null = null;
  private readonly filterButtons = new Map<ContextFilter, HTMLButtonElement>();
  private readonly fileItemControlsByPath = new Map<string, { el: HTMLLIElement; checkbox: HTMLInputElement }>();
  private processing = false;

  constructor(
    app: App,
    onSelect: (files: TFile[]) => void | Promise<void>,
    _plugin: unknown,
    options: ContextSelectionModalOptions = {},
  ) {
    super(app);
    this.onSelect = onSelect;
    this.isFileAlreadyPinned = options.isFileAlreadyPinned;
    this.initialSearchQuery = options.initialSearchQuery?.trim() ?? "";
    this.searchQuery = this.initialSearchQuery.toLowerCase();
    this.autoFocusSearch = options.autoFocusSearch ?? true;
    this.currentFilter = options.initialFilter ?? "all";
    this.files = this.readSupportedFiles();
    this.applyInitialSelection(options.initialSelectedPaths);
    this.updateFilteredFiles();
    this.setSize("large");
    this.modalEl.addClass("ss-context-selection-modal");
  }

  onOpen(): void {
    super.onOpen();
    this.addTitle("Pin files for every message");
    this.contentEl.createEl("p", {
      cls: "ss-context-description",
      text: "Pinned files are reread for every message. Files SystemSculpt reads while working remain part of this chat, but are not pinned automatically.",
    });
    this.searchInput = this.addSearchBar("modal.context.search", "Search files", (query) => {
      this.searchQuery = query.trim().toLowerCase();
      this.applyFilters();
    });
    this.searchInput.value = this.initialSearchQuery;
    this.searchInput.setAttribute("aria-label", "Search files");

    const filters = this.contentEl.createDiv({
      cls: "ss-context-filter-container",
      attr: { role: "toolbar", "aria-label": "File type" },
    });
    this.createFilterButton(filters, "all", "All");
    for (const [type, info] of Object.entries(FILE_TYPES)) {
      this.createFilterButton(filters, type as ContextFileType, info.label, info.icon);
    }

    this.listContainer = this.contentEl.createEl("ul", {
      cls: "ss-context-file-list",
      attr: { "aria-label": "Vault files" },
    });
    this.renderFileList();

    this.cancelButton = this.addActionButton("modal.context.cancel", "Cancel", () => this.close());
    this.addButton = this.addActionButton("modal.context.pin", "Pin files", () => void this.handleSelection(), true);
    this.updateAddButton();

    if (this.autoFocusSearch) {
      getSurfaceOwnerWindow(this.modalEl).setTimeout(() => this.searchInput?.focus(), 0);
    }
  }

  onClose(): void {
    this.selectedFiles.clear();
    this.fileItemControlsByPath.clear();
    this.filterButtons.clear();
    this.listContainer = null;
    this.searchInput = null;
    this.addButton = null;
    this.cancelButton = null;
    this.loadMoreButton = null;
    this.contentEl.empty();
    super.onClose();
  }

  private readSupportedFiles(): FileItem[] {
    const items: FileItem[] = [];
    for (const file of this.app.vault.getFiles()) {
      const extension = file.extension.toLowerCase();
      const match = Object.entries(FILE_TYPES).find(([, info]) =>
        (info.extensions as readonly string[]).includes(extension));
      if (!match) continue;
      items.push({
        file,
        type: match[0] as ContextFileType,
        searchText: `${file.basename} ${file.path} ${extension}`.toLowerCase(),
      });
    }
    return items.sort((left, right) => left.file.basename.localeCompare(right.file.basename));
  }

  private applyInitialSelection(paths?: readonly string[]): void {
    if (!paths?.length) return;
    const selectedPaths = new Set(paths);
    for (const item of this.files) {
      if (selectedPaths.has(item.file.path) && !this.isFileAlreadyPinned?.(item.file)) {
        this.selectedFiles.add(item.file);
      }
    }
  }

  private updateFilteredFiles(): void {
    this.filteredFiles = this.files.filter((item) =>
      (this.currentFilter === "all" || item.type === this.currentFilter)
      && (!this.searchQuery || item.searchText.includes(this.searchQuery)));
  }

  private applyFilters(): void {
    this.updateFilteredFiles();
    this.renderedCount = 0;
    this.renderFileList();
  }

  private createFilterButton(
    parent: HTMLElement,
    filter: ContextFilter,
    label: string,
    icon?: string,
  ): void {
    const selected = filter === this.currentFilter;
    const button = createUiAction(parent, {
      label,
      testId: `modal.context.filter.${filter}`,
      icon,
      size: "small",
      selected,
    });
    button.addClass("ss-context-filter-btn");
    this.registerDomEvent(button, "click", () => this.setFilter(filter));
    this.filterButtons.set(filter, button);
  }

  private setFilter(filter: ContextFilter): void {
    this.currentFilter = filter;
    for (const [value, button] of this.filterButtons) {
      const selected = value === filter;
      button.toggleClass("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    this.applyFilters();
  }

  private renderFileList(): void {
    if (!this.listContainer) return;
    this.listContainer.empty();
    this.fileItemControlsByPath.clear();
    this.loadMoreButton = null;

    if (this.filteredFiles.length === 0) {
      const empty = this.listContainer.createEl("li", { cls: "ss-context-empty" });
      const icon = empty.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-x");
      empty.createSpan({ text: "No files found" });
      return;
    }

    const end = Math.min(this.maxRenderedFiles, this.filteredFiles.length);
    this.appendFileItems(0, end);
    this.renderedCount = end;
    this.updateLoadMoreButton();
  }

  private appendFileItems(start: number, end: number): void {
    if (!this.listContainer) return;
    for (let index = start; index < end; index += 1) {
      const item = this.filteredFiles[index];
      if (!item) continue;
      const pinned = this.isFileAlreadyPinned?.(item.file) ?? false;
      const selected = this.selectedFiles.has(item.file);
      const row = this.listContainer.createEl("li", {
        cls: `ss-context-file-item${selected ? " is-selected" : ""}${pinned ? " is-pinned" : ""}`,
      });
      const label = row.createEl("label", { cls: "ss-context-file-label" });
      const checkbox = label.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = pinned || selected;
      checkbox.disabled = pinned || this.processing;
      checkbox.dataset.pinned = String(pinned);
      checkbox.setAttribute("aria-label", pinned
        ? `${item.file.path}, pinned for every message`
        : `Pin ${item.file.path}`);
      this.renderFileVisual(label, item);
      const info = label.createSpan({ cls: "ss-context-file-info" });
      info.createSpan({ text: item.file.basename, cls: "ss-context-file-name" });
      info.createSpan({ text: item.file.path, cls: "ss-context-file-path" });
      if (pinned) info.createSpan({ text: "Pinned", cls: "ss-context-file-badge" });

      this.registerDomEvent(checkbox, "change", () => {
        if (checkbox.checked) this.selectedFiles.add(item.file);
        else this.selectedFiles.delete(item.file);
        row.toggleClass("is-selected", checkbox.checked);
        this.updateAddButton();
      });
      this.fileItemControlsByPath.set(item.file.path, { el: row, checkbox });
    }
  }

  private renderFileVisual(parent: HTMLElement, item: FileItem): void {
    if (item.type !== "images") {
      const icon = parent.createSpan({
        cls: "ss-context-file-icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(icon, FILE_TYPES[item.type].icon);
      return;
    }

    const thumbnail = parent.createSpan({
      cls: "ss-context-file-thumbnail",
      attr: { "aria-hidden": "true" },
    });
    const showFallback = (): void => {
      thumbnail.empty();
      thumbnail.addClass("is-unavailable");
      setIcon(thumbnail, "image-off");
    };

    let resourcePath = "";
    try {
      resourcePath = this.app.vault.getResourcePath(item.file);
    } catch {
      showFallback();
      return;
    }
    if (!resourcePath) {
      showFallback();
      return;
    }

    const image = thumbnail.createEl("img", { attr: { alt: "" } });
    image.loading = "lazy";
    image.decoding = "async";
    image.draggable = false;
    image.onerror = () => {
      image.onerror = null;
      showFallback();
    };
    image.src = resourcePath;
  }

  private updateLoadMoreButton(): void {
    if (!this.listContainer) return;
    const remaining = this.filteredFiles.length - this.renderedCount;
    if (remaining <= 0) return;
    const item = this.listContainer.createEl("li", { cls: "ss-context-load-more-item" });
    this.loadMoreButton = createUiAction(item, {
      label: `Show ${remaining} more file${remaining === 1 ? "" : "s"}`,
      testId: "modal.context.load-more",
      size: "small",
    });
    this.loadMoreButton.addClass("ss-context-load-more");
    this.loadMoreButton.disabled = this.processing;
    this.registerDomEvent(this.loadMoreButton, "click", () => {
      item.remove();
      this.loadMoreButton = null;
      const start = this.renderedCount;
      const end = Math.min(start + this.maxRenderedFiles, this.filteredFiles.length);
      this.appendFileItems(start, end);
      this.renderedCount = end;
      this.updateLoadMoreButton();
    });
  }

  private updateAddButton(): void {
    if (!this.addButton) return;
    const count = this.selectedFiles.size;
    this.addButton.setText(count === 0 ? "Pin files" : `Pin ${count} file${count === 1 ? "" : "s"}`);
    this.addButton.disabled = this.processing || count === 0;
  }

  private setLoadingState(loading: boolean): void {
    this.processing = loading;
    if (this.searchInput) this.searchInput.disabled = loading;
    if (this.cancelButton) this.cancelButton.disabled = loading;
    for (const button of this.filterButtons.values()) button.disabled = loading;
    for (const { checkbox } of this.fileItemControlsByPath.values()) {
      checkbox.disabled = loading || checkbox.dataset.pinned === "true";
    }
    if (this.loadMoreButton) this.loadMoreButton.disabled = loading;
    if (this.addButton && loading) {
      this.addButton.setText("Pinning…");
      this.addButton.disabled = true;
    } else {
      this.updateAddButton();
    }
  }

  private async handleSelection(): Promise<void> {
    if (this.processing || this.selectedFiles.size === 0) return;
    this.setLoadingState(true);
    try {
      await this.onSelect([...this.selectedFiles]);
      this.close();
    } catch (error) {
      const detail = error instanceof Error && error.message.trim() ? ` ${error.message.trim()}` : "";
      new Notice(`Couldn't pin files for every message.${detail}`, 5000);
      this.setLoadingState(false);
    }
  }
}
