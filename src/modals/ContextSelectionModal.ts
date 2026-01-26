import { App, TFile, Modal, Setting, setIcon, ButtonComponent } from "obsidian";
import SystemSculptPlugin from "../main";

const FILE_TYPES = {
  text: { extensions: ["md", "txt"], icon: "file-text", label: "Text" },
  documents: { extensions: ["pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx"], icon: "file", label: "Documents" },
  images: { extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp"], icon: "image", label: "Images" },
  audio: { extensions: ["mp3", "wav", "m4a", "ogg", "webm"], icon: "headphones", label: "Audio" }
};

interface FileItem {
  file: TFile;
  type: keyof typeof FILE_TYPES;
  searchText: string;
}

export interface ContextSelectionModalOptions {
  isFileAlreadyInContext?: (file: TFile) => boolean;
}

export class ContextSelectionModal extends Modal {
  private files: FileItem[] = [];
  private filteredFiles: FileItem[] = [];
  private selectedFiles: Set<TFile> = new Set();
  private currentFilter: keyof typeof FILE_TYPES | "all" = "all";
  private searchQuery = "";
  private onSelect: (files: TFile[]) => void;
  private plugin: SystemSculptPlugin;
  private addButton: ButtonComponent | null = null;
  private readonly isFileAlreadyInContext?: (file: TFile) => boolean;
  private readonly MAX_RENDERED_FILES = 100;
  private renderedCount = 0;
  private listContainer: HTMLElement | null = null;
  private loadMoreButton: HTMLButtonElement | null = null;
  private fileItemControlsByPath = new Map<string, { el: HTMLElement; checkbox: HTMLInputElement }>();

  constructor(app: App, onSelect: (files: TFile[]) => void, plugin: SystemSculptPlugin, options?: ContextSelectionModalOptions) {
    super(app);
    this.onSelect = onSelect;
    this.plugin = plugin;
    this.isFileAlreadyInContext = options?.isFileAlreadyInContext;
    this.initializeFiles();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    this.renderedCount = 0;
    
    // Simple title using Obsidian's titleEl
    this.titleEl.setText("Add Context Files");
    
    // Search using native Setting component
    new Setting(contentEl)
      .setName("Search files")
      .addText(text => {
        text
          .setPlaceholder("Type to search...")
          .onChange(value => {
            this.searchQuery = value.toLowerCase();
            this.applyFilters();
          });
        // Auto-focus
        setTimeout(() => text.inputEl.focus(), 100);
      });

    // Filter buttons using simple div
    const filterContainer = contentEl.createDiv("ss-context-filter-container");
    
    // All filter
    const allBtn = filterContainer.createEl("button", { 
      text: "All",
      cls: "ss-context-filter-btn is-active"
    });
    allBtn.onclick = () => this.setFilter("all", allBtn);
    
    // Type filters
    Object.entries(FILE_TYPES).forEach(([type, info]) => {
      const btn = filterContainer.createEl("button", { cls: "ss-context-filter-btn" });
      const icon = btn.createSpan();
      setIcon(icon, info.icon);
      btn.createSpan({ text: info.label });
      btn.onclick = () => this.setFilter(type as keyof typeof FILE_TYPES, btn);
    });

    // File list container
    const listContainer = contentEl.createDiv("ss-context-file-list");
    this.listContainer = listContainer;
    this.renderFileList(listContainer);

    // Simple button container using Setting for consistency
    new Setting(contentEl)
      .addButton(btn => btn
        .setButtonText("Cancel")
        .onClick(() => this.close()))
      .addButton(btn => {
        this.addButton = btn;
        this.updateAddButton(btn);
        btn.onClick(async () => {
          await this.handleSelection();
        });
      });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.selectedFiles.clear();
    this.fileItemControlsByPath.clear();
    this.listContainer = null;
    this.loadMoreButton = null;
  }

  private initializeFiles() {
    const allFiles = this.app.vault.getFiles();
    this.files = [];
    
    for (const file of allFiles) {
      const ext = file.extension.toLowerCase();
      for (const [typeName, typeInfo] of Object.entries(FILE_TYPES)) {
        if (typeInfo.extensions.includes(ext)) {
          this.files.push({
            file,
            type: typeName as keyof typeof FILE_TYPES,
            searchText: `${file.basename} ${file.path} ${ext}`.toLowerCase()
          });
          break;
        }
      }
    }
    
    this.files.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
    this.filteredFiles = [...this.files];
  }

  private setFilter(filter: keyof typeof FILE_TYPES | "all", buttonEl: HTMLElement) {
    // Update active state
    buttonEl.parentElement?.querySelectorAll(".ss-context-filter-btn").forEach(btn => {
      btn.removeClass("is-active");
    });
    buttonEl.addClass("is-active");
    
    this.currentFilter = filter;
    this.applyFilters();
  }

  private applyFilters() {
    let filtered = this.files;
    
    if (this.currentFilter !== "all") {
      filtered = filtered.filter(item => item.type === this.currentFilter);
    }
    
    if (this.searchQuery) {
      filtered = filtered.filter(item => item.searchText.includes(this.searchQuery));
    }
    
    this.filteredFiles = filtered;
    this.renderedCount = 0;
    
    // Re-render file list
    const listContainer = this.contentEl.querySelector(".ss-context-file-list") as HTMLElement;
    if (listContainer) {
      this.renderFileList(listContainer);
    }
  }

  private renderFileList(container: HTMLElement) {
    container.empty();
    this.fileItemControlsByPath.clear();
    this.loadMoreButton = null;
    
    if (this.filteredFiles.length === 0) {
      const empty = container.createDiv("ss-context-empty");
      const emptyIcon = empty.createDiv();
      setIcon(emptyIcon, "file-x");
      empty.createEl("p", { text: "No files found" });
      return;
    }

    const end = Math.min(this.MAX_RENDERED_FILES, this.filteredFiles.length);
    this.appendFileItems(container, 0, end);
    this.renderedCount = end;

    this.updateLoadMoreButton(container);
  }

  private toggleFileSelection(file: TFile) {
    if (this.isFileAlreadyInContext?.(file)) {
      return;
    }

    if (this.selectedFiles.has(file)) {
      this.selectedFiles.delete(file);
    } else {
      this.selectedFiles.add(file);
    }

    const controls = this.fileItemControlsByPath.get(file.path);
    if (controls) {
      controls.el.toggleClass("is-selected", this.selectedFiles.has(file));
      controls.checkbox.checked = this.selectedFiles.has(file);
    }
    
    // Update button
    this.updateAddButtonState();
  }

  private appendFileItems(container: HTMLElement, start: number, end: number): void {
    for (let index = start; index < end; index++) {
      const item = this.filteredFiles[index];
      if (!item) continue;

      const fileEl = container.createDiv("ss-context-file-item");
      const isAlreadyInContext = this.isFileAlreadyInContext?.(item.file) ?? false;
      const isSelected = this.selectedFiles.has(item.file);
      const isChecked = isAlreadyInContext || isSelected;

      if (isSelected) {
        fileEl.addClass("is-selected");
      }
      if (isAlreadyInContext) {
        fileEl.addClass("is-attached");
      }

      // Icon
      const iconEl = fileEl.createDiv("ss-context-file-icon");
      setIcon(iconEl, FILE_TYPES[item.type].icon);

      // Info
      const infoEl = fileEl.createDiv("ss-context-file-info");
      infoEl.createDiv({ text: item.file.basename, cls: "ss-context-file-name" });
      infoEl.createDiv({ text: item.file.path, cls: "ss-context-file-path" });
      if (isAlreadyInContext) {
        infoEl.createDiv({ text: "Already in context", cls: "ss-context-file-badge" });
      }

      // Checkbox
      const checkbox = fileEl.createEl("input", { type: "checkbox" }) as HTMLInputElement;
      checkbox.checked = isChecked;
      checkbox.disabled = isAlreadyInContext;

      this.fileItemControlsByPath.set(item.file.path, { el: fileEl, checkbox });

      // Click handler
      if (!isAlreadyInContext) {
        fileEl.onclick = () => this.toggleFileSelection(item.file);
      }
    }
  }

  private updateLoadMoreButton(container: HTMLElement): void {
    if (this.loadMoreButton) {
      this.loadMoreButton.remove();
      this.loadMoreButton = null;
    }

    const remaining = this.filteredFiles.length - this.renderedCount;
    if (remaining <= 0) return;

    const button = container.createEl("button", {
      text: `Show ${remaining} more file${remaining === 1 ? "" : "s"}`,
      cls: "ss-context-load-more",
    }) as HTMLButtonElement;
    button.onclick = () => {
      if (!this.listContainer) return;
      const start = this.renderedCount;
      const end = Math.min(this.renderedCount + this.MAX_RENDERED_FILES, this.filteredFiles.length);
      // Remove button before appending so it stays at the bottom.
      if (this.loadMoreButton) {
        this.loadMoreButton.remove();
        this.loadMoreButton = null;
      }
      this.appendFileItems(this.listContainer, start, end);
      this.renderedCount = end;
      this.updateLoadMoreButton(this.listContainer);
    };

    this.loadMoreButton = button;
  }

  private updateAddButton(btn: ButtonComponent) {
    const count = this.selectedFiles.size;
    if (count === 0) {
      btn.setButtonText("Add Files").setDisabled(true);
    } else {
      btn.setButtonText(`Add ${count} File${count === 1 ? '' : 's'}`).setDisabled(false).setCta();
    }
  }

  private updateAddButtonState() {
    if (this.addButton) {
      this.updateAddButton(this.addButton);
    }
  }

  private setLoadingState(loading: boolean) {
    const buttons = this.contentEl.querySelectorAll("button");
    const cancelButton = Array.from(buttons).find(btn => btn.textContent?.includes("Cancel")) as HTMLButtonElement;
    
    if (loading) {
      if (this.addButton) {
        this.addButton.setButtonText("Processing...").setDisabled(true);
        this.addButton.buttonEl.removeClass("mod-cta");
      }
      if (cancelButton) {
        cancelButton.disabled = true;
      }
      
      // Disable file selection during processing
      const fileItems = this.contentEl.querySelectorAll(".ss-context-file-item");
      fileItems.forEach(item => {
        (item as HTMLElement).style.pointerEvents = "none";
        item.addClass("is-disabled");
      });
    } else {
      if (this.addButton) {
        this.updateAddButton(this.addButton);
      }
      if (cancelButton) {
        cancelButton.disabled = false;
      }
      
      // Re-enable file selection
      const fileItems = this.contentEl.querySelectorAll(".ss-context-file-item");
      fileItems.forEach(item => {
        (item as HTMLElement).style.pointerEvents = "auto";
        item.removeClass("is-disabled");
      });
    }
  }

  private async handleSelection() {
    if (this.selectedFiles.size === 0) return;
    
    const selectedArray = Array.from(this.selectedFiles);
    
    try {
      // Show loading state
      this.setLoadingState(true);
      
      // Await the file processing
      await this.onSelect(selectedArray);
      
      // Close modal after successful processing
      this.close();
    } catch (error) {
      // Keep modal open on error so user can see what happened
      this.setLoadingState(false);
    }
  }
}
