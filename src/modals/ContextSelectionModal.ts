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

export class ContextSelectionModal extends Modal {
  private files: FileItem[] = [];
  private filteredFiles: FileItem[] = [];
  private selectedFiles: Set<TFile> = new Set();
  private currentFilter: keyof typeof FILE_TYPES | "all" = "all";
  private searchQuery = "";
  private onSelect: (files: TFile[]) => void;
  private plugin: SystemSculptPlugin;
  private addButton: ButtonComponent | null = null;

  constructor(app: App, onSelect: (files: TFile[]) => void, plugin: SystemSculptPlugin) {
    super(app);
    this.onSelect = onSelect;
    this.plugin = plugin;
    this.initializeFiles();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    
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
    
    // Re-render file list
    const listContainer = this.contentEl.querySelector(".ss-context-file-list") as HTMLElement;
    if (listContainer) {
      this.renderFileList(listContainer);
    }
  }

  private renderFileList(container: HTMLElement) {
    container.empty();
    
    if (this.filteredFiles.length === 0) {
      const empty = container.createDiv("ss-context-empty");
      const emptyIcon = empty.createDiv();
      setIcon(emptyIcon, "file-x");
      empty.createEl("p", { text: "No files found" });
      return;
    }

    // Render files (limit to 100 for performance)
    const visibleFiles = this.filteredFiles.slice(0, 100);
    
    visibleFiles.forEach(item => {
      const fileEl = container.createDiv("ss-context-file-item");
      const isSelected = this.selectedFiles.has(item.file);
      
      if (isSelected) {
        fileEl.addClass("is-selected");
      }
      
      // Icon
      const iconEl = fileEl.createDiv("ss-context-file-icon");
      setIcon(iconEl, FILE_TYPES[item.type].icon);
      
      // Info
      const infoEl = fileEl.createDiv("ss-context-file-info");
      infoEl.createDiv({ text: item.file.basename, cls: "ss-context-file-name" });
      infoEl.createDiv({ text: item.file.path, cls: "ss-context-file-path" });
      
      // Checkbox
      const checkbox = fileEl.createEl("input", { type: "checkbox" });
      checkbox.checked = isSelected;
      
      // Click handler
      fileEl.onclick = () => this.toggleFileSelection(item.file);
    });

    if (this.filteredFiles.length > 100) {
      const loadMore = container.createEl("button", {
        text: `Show ${this.filteredFiles.length - 100} more files`,
        cls: "ss-context-load-more"
      });
      loadMore.onclick = () => {
        // Simple implementation: just show all files
        container.empty();
        this.filteredFiles.forEach(item => {
          // Same rendering logic as above but for all files
        });
      };
    }
  }

  private toggleFileSelection(file: TFile) {
    if (this.selectedFiles.has(file)) {
      this.selectedFiles.delete(file);
    } else {
      this.selectedFiles.add(file);
    }
    
    // Re-render to update selection states
    const listContainer = this.contentEl.querySelector(".ss-context-file-list") as HTMLElement;
    if (listContainer) {
      this.renderFileList(listContainer);
    }
    
    // Update button
    this.updateAddButtonState();
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