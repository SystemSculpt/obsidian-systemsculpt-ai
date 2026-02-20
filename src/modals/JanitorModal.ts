import { App, TFile, TFolder, setIcon } from "obsidian";
import SystemSculptPlugin from "../main";
import { showPopup } from "../core/ui";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";

interface JanitorData {
  emptyFiles: TFile[];
  emptyFolders: TFolder[];
  chatFiles: TFile[];
  extractionFiles: TFile[];
  recordingFiles: TFile[];
  sizes: {
    empty: string;
    chat: string;
    extraction: string;
    recording: string;
  };
  stats: {
    emptyFileCount: number;
    emptyFolderCount: number;
    totalEmptyCount: number;
  };
}

export class JanitorModal extends StandardModal {
  private plugin: SystemSculptPlugin;
  private cachedData: JanitorData | null = null;
  private isScanning = false;
  private mainContainer: HTMLElement;
  private loadingOverlay: HTMLElement;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
    this.setSize("large");
  }

  onOpen() {
    super.onOpen();
    
    // Add modal classes for styling
    this.modalEl.addClass("ss-janitor-modal");
    
    // Set up the header
    this.addTitle(
      "🧹 SystemSculpt Janitor",
      "Clean up and optimize your SystemSculpt workspace. Review items before deletion."
    );

    // Create the main container and loading overlay
    this.createMainContainer();
    
    // Add footer buttons
    this.addActionButton("Refresh", () => this.refreshData(), false, "refresh-cw");
    this.addActionButton("Close", () => this.close(), false);
    
    // Load data efficiently
    this.loadJanitorData();
  }

  private createMainContainer() {
    // Create main container
    this.mainContainer = this.contentEl.createDiv({ cls: "ss-janitor-main" });
    
    // Create loading overlay
    this.loadingOverlay = this.contentEl.createDiv({ cls: "ss-janitor-loading-overlay" });
    const loadingContent = this.loadingOverlay.createDiv({ cls: "ss-janitor-loading-content" });
    
    const loadingIcon = loadingContent.createDiv({ cls: "ss-janitor-loading-icon" });
    setIcon(loadingIcon, "loader-2");
    
    const loadingText = loadingContent.createDiv({ cls: "ss-janitor-loading-text" });
    loadingText.createDiv({ text: "Scanning Vault", cls: "ss-janitor-loading-title" });
    loadingText.createDiv({ text: "Analyzing files and folders...", cls: "ss-janitor-loading-subtitle" });
    
    // Show loading initially
    this.showLoading(true);
  }

  /**
   * Efficiently scan the entire vault once and categorize all files
   */
  private async scanVault(): Promise<JanitorData> {
    const emptyFiles: TFile[] = [];
    const emptyFolders: TFolder[] = [];
    const chatFiles: TFile[] = [];
    const extractionFiles: TFile[] = [];
    const recordingFiles: TFile[] = [];
    
    // Get all files and folders in one operation
    const allFiles = this.app.vault.getFiles();
    const allFolders = this.app.vault.getAllLoadedFiles().filter(f => f instanceof TFolder) as TFolder[];
    
    // Efficiently categorize files
    for (const file of allFiles) {
      // Check if file is in specific directories
      if (file.path.startsWith(this.plugin.settings.chatsDirectory)) {
        chatFiles.push(file);
      } else if (file.path.startsWith(this.plugin.settings.extractionsDirectory)) {
        extractionFiles.push(file);
      } else if (file.path.startsWith(this.plugin.settings.recordingsDirectory)) {
        recordingFiles.push(file);
      }
      
      // Check if file is empty (optimized check)
      if (await this.isEmptyFile(file)) {
        emptyFiles.push(file);
      }
    }
    
    // Efficiently find empty folders
    for (const folder of allFolders) {
      if (this.isEmptyFolder(folder)) {
        emptyFolders.push(folder);
      }
    }
    
    // Calculate sizes efficiently
    const sizes = {
      empty: this.calculateSize(emptyFiles),
      chat: this.calculateSize(chatFiles),
      extraction: this.calculateSize(extractionFiles),
      recording: this.calculateSize(recordingFiles)
    };
    
    return {
      emptyFiles,
      emptyFolders,
      chatFiles,
      extractionFiles,
      recordingFiles,
      sizes,
      stats: {
        emptyFileCount: emptyFiles.length,
        emptyFolderCount: emptyFolders.length,
        totalEmptyCount: emptyFiles.length + emptyFolders.length
      }
    };
  }

  /**
   * Load all janitor data efficiently
   */
  private async loadJanitorData() {
    if (this.isScanning) return;
    
    try {
      this.isScanning = true;
      this.showLoading(true);
      
      // Scan vault once and get all data
      const data = await this.scanVault();
      this.cachedData = data;
      
      // Hide loading and show content
      this.showLoading(false);
      this.populateAllSections(data);
      
    } catch (error) {
      this.showError("Failed to scan vault. Please try refreshing.");
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Populate all sections with scanned data
   */
  private populateAllSections(data: JanitorData) {
    // Clear main container
    this.mainContainer.empty();
    
    // Create sections container
    const sectionsContainer = this.mainContainer.createDiv({ cls: "ss-janitor-sections" });
    
    // Create all sections with data
    this.createEmptyContentSection(sectionsContainer, data);
    this.createChatHistorySection(sectionsContainer, data);
    this.createExtractionsSection(sectionsContainer, data);
    this.createRecordingsSection(sectionsContainer, data);
  }

  /**
   * Create empty content section with pre-loaded data
   */
  private createEmptyContentSection(container: HTMLElement, data: JanitorData) {
    const section = this.createModernSection(
      container,
      "📄 Empty Content",
      "Remove empty files and folders that are taking up space"
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { emptyFiles, emptyFolders, stats } = data;

    // Show stats
    this.createStatCard(statsContainer, "Files", stats.emptyFileCount, "file-text");
    this.createStatCard(statsContainer, "Folders", stats.emptyFolderCount, "folder");
    this.createStatCard(statsContainer, "Total", stats.totalEmptyCount, "trash-2", stats.totalEmptyCount > 0 ? "warning" : "muted");

    // Create action button
    const clearButton = actionContainer.createEl("button", {
      cls: stats.totalEmptyCount > 0 ? "ss-button ss-button--danger" : "ss-button",
      text: stats.totalEmptyCount > 0 ? `Clear ${stats.totalEmptyCount} Empty Items` : "No Empty Content"
    }) as HTMLButtonElement;
    
    if (stats.totalEmptyCount === 0) {
      clearButton.disabled = true;
      clearButton.addClass("ss-disabled");
    } else {
      this.registerDomEvent(clearButton, "click", async () => {
        await this.showEmptyContentConfirmation(emptyFiles, emptyFolders, () => {
          this.refreshData();
        });
      });
    }
  }

  private createChatHistorySection(container: HTMLElement, data: JanitorData) {
    const section = this.createModernSection(
      container,
      "💬 Chat History",
      "Delete all saved chat conversations and message history"
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { chatFiles, sizes } = data;
    const hasChatFiles = chatFiles.length > 0;

    this.createStatCard(statsContainer, "Chats", chatFiles.length, "message-circle");
    this.createStatCard(statsContainer, "Size", sizes.chat, "hard-drive");
    this.createStatCard(statsContainer, "Status", hasChatFiles ? "Active" : "Empty", "activity", hasChatFiles ? "success" : "muted");

    const clearButton = actionContainer.createEl("button", {
      cls: hasChatFiles ? "ss-button ss-button--danger" : "ss-button",
      text: hasChatFiles ? `Clear All Chat History (${sizes.chat})` : "No Chat History"
    }) as HTMLButtonElement;
    
    if (!hasChatFiles) {
      clearButton.disabled = true;
      clearButton.addClass("ss-disabled");
    } else {
      this.registerDomEvent(clearButton, "click", async () => {
        await this.showConfirmationDialog(
          chatFiles,
          "Chat History",
          this.plugin.settings.chatsDirectory,
          () => this.refreshData()
        );
      });
    }
  }

  private createExtractionsSection(container: HTMLElement, data: JanitorData) {
    const section = this.createModernSection(
      container,
      "📄 Document Extractions",
      "Delete extracted content from PDFs, documents, and other processed files"
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { extractionFiles, sizes } = data;
    const hasExtractionFiles = extractionFiles.length > 0;

    this.createStatCard(statsContainer, "Files", extractionFiles.length, "file-text");
    this.createStatCard(statsContainer, "Size", sizes.extraction, "hard-drive");
    this.createStatCard(statsContainer, "Status", hasExtractionFiles ? "Active" : "Empty", "activity", hasExtractionFiles ? "success" : "muted");

    const clearButton = actionContainer.createEl("button", {
      cls: hasExtractionFiles ? "ss-button ss-button--danger" : "ss-button",
      text: hasExtractionFiles ? `Clear All Extractions (${sizes.extraction})` : "No Extractions"
    }) as HTMLButtonElement;
    
    if (!hasExtractionFiles) {
      clearButton.disabled = true;
      clearButton.addClass("ss-disabled");
    } else {
      this.registerDomEvent(clearButton, "click", async () => {
        await this.showConfirmationDialog(
          extractionFiles,
          "Extractions",
          this.plugin.settings.extractionsDirectory,
          () => this.refreshData()
        );
      });
    }
  }

  private createRecordingsSection(container: HTMLElement, data: JanitorData) {
    const section = this.createModernSection(
      container,
      "🎙️ Audio Recordings",
      "Delete audio recording files (transcribed text files will remain intact)"
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { recordingFiles, sizes } = data;
    const hasRecordingFiles = recordingFiles.length > 0;

    this.createStatCard(statsContainer, "Files", recordingFiles.length, "audio-lines");
    this.createStatCard(statsContainer, "Size", sizes.recording, "hard-drive");
    this.createStatCard(statsContainer, "Status", hasRecordingFiles ? "Active" : "Empty", "activity", hasRecordingFiles ? "success" : "muted");

    const clearButton = actionContainer.createEl("button", {
      cls: hasRecordingFiles ? "ss-button ss-button--danger" : "ss-button",
      text: hasRecordingFiles ? `Clear All Recordings (${sizes.recording})` : "No Recordings"
    }) as HTMLButtonElement;
    
    if (!hasRecordingFiles) {
      clearButton.disabled = true;
      clearButton.addClass("ss-disabled");
    } else {
      this.registerDomEvent(clearButton, "click", async () => {
        await this.showConfirmationDialog(
          recordingFiles,
          "Recordings",
          this.plugin.settings.recordingsDirectory,
          () => this.refreshData()
        );
      });
    }
  }

  private createModernSection(
    container: HTMLElement,
    title: string,
    description: string
  ) {
    const section = container.createDiv({ cls: "ss-janitor-section" });
    
    const header = section.createDiv({ cls: "ss-janitor-section-header" });
    const titleEl = header.createDiv({ cls: "ss-janitor-section-title", text: title });
    const descEl = header.createDiv({ cls: "ss-janitor-section-description", text: description });
    
    const content = section.createDiv({ cls: "ss-janitor-section-content" });

    return {
      section,
      header,
      content
    };
  }

  private createStatCard(
    container: HTMLElement,
    label: string,
    value: string | number,
    icon: string,
    variant: "normal" | "warning" | "success" | "muted" = "normal"
  ) {
    const card = container.createDiv({ cls: `ss-janitor-stat-card ss-janitor-stat-card--${variant}` });
    
    const iconEl = card.createDiv({ cls: "ss-janitor-stat-icon" });
    setIcon(iconEl, icon);
    
    const content = card.createDiv({ cls: "ss-janitor-stat-content" });
    content.createDiv({ cls: "ss-janitor-stat-value", text: value.toString() });
    content.createDiv({ cls: "ss-janitor-stat-label", text: label });
    
    return card;
  }

  /**
   * Efficient refresh that clears cache and reloads
   */
  private refreshData() {
    this.cachedData = null;
    this.loadJanitorData();
  }

  /**
   * Show/hide loading overlay
   */
  private showLoading(show: boolean) {
    this.loadingOverlay.style.display = show ? "flex" : "none";
    this.mainContainer.style.display = show ? "none" : "block";
  }

  /**
   * Show error state
   */
  private showError(message: string) {
    this.showLoading(false);
    this.mainContainer.empty();
    
    const errorContainer = this.mainContainer.createDiv({ cls: "ss-janitor-error" });
    const errorIcon = errorContainer.createDiv({ cls: "ss-janitor-error-icon" });
    setIcon(errorIcon, "alert-circle");
    
    const errorText = errorContainer.createDiv({ cls: "ss-janitor-error-text" });
    errorText.createDiv({ text: "Error", cls: "ss-janitor-error-title" });
    errorText.createDiv({ text: message, cls: "ss-janitor-error-message" });
    
    const retryButton = errorContainer.createEl("button", {
      cls: "ss-button ss-button--primary",
      text: "Retry"
    });
    
    this.registerDomEvent(retryButton, "click", () => {
      this.refreshData();
    });
  }

  private calculateSize(files: TFile[]): string {
    const totalBytes = files.reduce((acc, file) => acc + file.stat.size, 0);
    if (totalBytes === 0) return "empty";
    if (totalBytes < 1024) return `${totalBytes} bytes`;
    if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
    if (totalBytes < 1024 * 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private async cleanDirectory(directory: string): Promise<void> {
    // Safety check: prevent deletion of root or system directories
    if (!directory || directory === "/" || directory === "." || directory === "..") {
      throw new Error("Cannot delete root or system directories");
    }

    // Get all files in the directory efficiently
    const files = this.app.vault.getFiles().filter(file => file.path.startsWith(directory));

    // Move files to trash
    for (const file of files) {
      await this.app.vault.trash(file, true);
    }

    // Clean up empty directories
    const folder = this.app.vault.getAbstractFileByPath(directory);
    if (folder instanceof TFolder) {
      const subdirs = folder.children
        .filter((child): child is TFolder => child instanceof TFolder)
        .sort((a, b) => b.path.length - a.path.length);

      for (const subdir of subdirs) {
        if (subdir.children.length === 0) {
          await this.app.vault.trash(subdir, true);
        }
      }

      if (folder.children.length === 0) {
        await this.app.vault.trash(folder, true);
      }
    }
  }

  private async showConfirmationDialog(
    files: TFile[],
    type: string,
    directory: string,
    onSuccess: () => void
  ) {
    const confirmModal = new ConfirmationModal(
      this.app,
      `Clear ${type}`,
      `⚠️ The following ${files.length} ${type.toLowerCase()} files will be moved to the Obsidian trash. You can restore them from the trash if needed.`,
      files,
      type
    );

    const result = await confirmModal.open();
    if (result) {
      try {
        await this.cleanDirectory(directory);
        showPopup(
          this.app,
          `Successfully moved ${files.length} ${type.toLowerCase()} files (${this.calculateSize(files)}) to trash`,
          { title: "Success" }
        );
        onSuccess();
      } catch (error) {
        showPopup(this.app, `Failed to clear ${type.toLowerCase()}`, {
          title: "Error",
        });
      }
    }
  }

  private async showEmptyContentConfirmation(
    emptyFiles: TFile[],
    emptyFolders: TFolder[],
    onSuccess: () => void
  ) {
    const confirmModal = new EmptyContentConfirmationModal(
      this.app,
      emptyFiles,
      emptyFolders
    );

    const result = await confirmModal.open();
    if (result) {
      try {
        // Delete empty files first
        for (const file of emptyFiles) {
          await this.app.vault.trash(file, true);
        }

        // Then delete empty folders (deepest first)
        const sortedFolders = emptyFolders.sort(
          (a, b) => b.path.length - a.path.length
        );
        for (const folder of sortedFolders) {
          await this.app.vault.trash(folder, true);
        }

        const totalEmpty = emptyFiles.length + emptyFolders.length;
        showPopup(
          this.app,
          `Successfully moved ${totalEmpty} empty items to trash`,
          { title: "Success" }
        );
        onSuccess();
      } catch (error) {
        showPopup(this.app, "Failed to clear empty content", {
          title: "Error",
        });
      }
    }
  }

  private async isEmptyFile(file: TFile): Promise<boolean> {
    // Quick size check first
    if (file.stat.size === 0) return true;
    
    // For small files that might have just whitespace, check content
    if (file.stat.size < 1024) { // Only check files under 1KB for performance
      const extension = file.extension.toLowerCase();
      
      if (["md", "txt", "markdown"].includes(extension)) {
        try {
          const content = await this.app.vault.read(file);
          const contentWithoutFrontmatter = content
            .replace(/^---[\s\S]*?---/, "")
            .trim();
          return !contentWithoutFrontmatter;
        } catch {
          return false; // If we can't read it, assume it's not empty
        }
      }
    }
    
    return false;
  }

  /**
   * Optimized empty folder check
   */
  private isEmptyFolder(folder: TFolder): boolean {
    return folder.children.length === 0;
  }

  onClose() {
    this.cachedData = null;
    this.isScanning = false;
    super.onClose();
  }
}

/**
 * Modern confirmation modal for directory clearing operations
 */
class ConfirmationModal extends StandardModal {
  private resolvePromise: ((value: boolean) => void) | null = null;
  private files: TFile[];
  private type: string;
  private title: string;
  private description: string;

  constructor(app: App, title: string, description: string, files: TFile[], type: string) {
    super(app);
    this.files = files;
    this.type = type;
    this.title = title;
    this.description = description;
    this.setSize("medium");
  }

  onOpen() {
    super.onOpen();
    
    this.addTitle(this.title, this.description);
    this.createFilePreview();
    this.createFooterButtons();
  }

  private createFilePreview() {
    if (this.files.length === 0) return;

    const previewContainer = this.contentEl.createDiv({ cls: "ss-janitor-preview" });
    const headerEl = previewContainer.createDiv({ cls: "ss-janitor-preview-header" });
    headerEl.createSpan({ text: `${this.files.length} files (${this.calculateSize(this.files)})`, cls: "ss-janitor-preview-count" });
    
    const listContainer = previewContainer.createDiv({ cls: "ss-janitor-preview-list" });
    
    // Show first 10 files
    const filesToShow = this.files.slice(0, 10);
    
    for (const file of filesToShow) {
      const fileItem = listContainer.createDiv({ cls: "ss-janitor-preview-item" });
      
      const iconEl = fileItem.createDiv({ cls: "ss-janitor-preview-icon" });
      setIcon(iconEl, this.getFileIcon(file));
      
      const pathEl = fileItem.createDiv({ cls: "ss-janitor-preview-path", text: file.path });
      const sizeEl = fileItem.createDiv({ cls: "ss-janitor-preview-size", text: this.calculateSize([file]) });
    }
    
    if (this.files.length > 10) {
      const moreEl = listContainer.createDiv({ cls: "ss-janitor-preview-more" });
      moreEl.createSpan({ text: `... and ${this.files.length - 10} more files` });
    }
  }

  private getFileIcon(file: TFile): string {
    const extension = file.extension.toLowerCase();
    if (["md", "txt", "markdown"].includes(extension)) return "file-text";
    if (["jpg", "jpeg", "png", "webp", "svg"].includes(extension)) return "image";
    if (["mp3", "wav", "ogg", "m4a"].includes(extension)) return "audio-lines";
    if (["pdf"].includes(extension)) return "file-text";
    return "file";
  }

  private calculateSize(files: TFile[]): string {
    const totalBytes = files.reduce((acc, file) => acc + file.stat.size, 0);
    if (totalBytes === 0) return "empty";
    if (totalBytes < 1024) return `${totalBytes} bytes`;
    if (totalBytes < 1024 * 1024) return `${(totalBytes / 1024).toFixed(1)} KB`;
    if (totalBytes < 1024 * 1024 * 1024) return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private createFooterButtons() {
    this.addActionButton("Cancel", () => this.resolve(false), false);
    this.addActionButton("Move to Trash", () => this.resolve(true), true, "trash-2");
  }

  private resolve(value: boolean) {
    if (this.resolvePromise) {
      this.resolvePromise(value);
      this.resolvePromise = null;
    }
    this.close();
  }

  async open(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      super.open();
    });
  }

  onClose() {
    // Clean up the promise if modal is closed without resolving
    if (this.resolvePromise) {
      this.resolvePromise(false);
      this.resolvePromise = null;
    }
    super.onClose();
  }
}

/**
 * Specialized confirmation modal for empty content with files and folders
 */
class EmptyContentConfirmationModal extends StandardModal {
  private resolvePromise: ((value: boolean) => void) | null = null;
  private emptyFiles: TFile[];
  private emptyFolders: TFolder[];
  private totalEmpty: number;

  constructor(app: App, emptyFiles: TFile[], emptyFolders: TFolder[]) {
    super(app);
    this.emptyFiles = emptyFiles;
    this.emptyFolders = emptyFolders;
    this.totalEmpty = emptyFiles.length + emptyFolders.length;
    this.setSize("medium");
  }

  onOpen() {
    super.onOpen();
    
    this.addTitle(
      "Clear Empty Content", 
      `⚠️ The following ${this.totalEmpty} empty items will be moved to the Obsidian trash. You can restore them from the trash if needed.`
    );
    
    this.createEmptyContentPreview();
    this.createFooterButtons();
  }

  private createEmptyContentPreview() {
    const previewContainer = this.contentEl.createDiv({ cls: "ss-janitor-preview" });

    // Show empty files
    if (this.emptyFiles.length > 0) {
      const filesSection = previewContainer.createDiv({ cls: "ss-janitor-preview-section" });
      const filesHeader = filesSection.createDiv({ cls: "ss-janitor-preview-section-header" });
      
      const filesHeaderIcon = filesHeader.createDiv({ cls: "ss-janitor-preview-section-icon" });
      setIcon(filesHeaderIcon, "file-text");
      filesHeader.createSpan({ text: `Empty Files (${this.emptyFiles.length})`, cls: "ss-janitor-preview-section-title" });
      
      const filesList = filesSection.createDiv({ cls: "ss-janitor-preview-list" });
      const filesToShow = this.emptyFiles.slice(0, 5);
      
      for (const file of filesToShow) {
        const item = filesList.createDiv({ cls: "ss-janitor-preview-item" });
        const icon = item.createDiv({ cls: "ss-janitor-preview-icon" });
        setIcon(icon, "file-text");
        item.createSpan({ text: file.path, cls: "ss-janitor-preview-path" });
      }
      
      if (this.emptyFiles.length > 5) {
        filesList.createDiv({ cls: "ss-janitor-preview-more", text: `... and ${this.emptyFiles.length - 5} more files` });
      }
    }

    // Show empty folders
    if (this.emptyFolders.length > 0) {
      const foldersSection = previewContainer.createDiv({ cls: "ss-janitor-preview-section" });
      const foldersHeader = foldersSection.createDiv({ cls: "ss-janitor-preview-section-header" });
      
      const foldersHeaderIcon = foldersHeader.createDiv({ cls: "ss-janitor-preview-section-icon" });
      setIcon(foldersHeaderIcon, "folder");
      foldersHeader.createSpan({ text: `Empty Folders (${this.emptyFolders.length})`, cls: "ss-janitor-preview-section-title" });
      
      const foldersList = foldersSection.createDiv({ cls: "ss-janitor-preview-list" });
      const foldersToShow = this.emptyFolders.slice(0, 5);
      
      for (const folder of foldersToShow) {
        const item = foldersList.createDiv({ cls: "ss-janitor-preview-item" });
        const icon = item.createDiv({ cls: "ss-janitor-preview-icon" });
        setIcon(icon, "folder");
        item.createSpan({ text: folder.path, cls: "ss-janitor-preview-path" });
      }
      
      if (this.emptyFolders.length > 5) {
        foldersList.createDiv({ cls: "ss-janitor-preview-more", text: `... and ${this.emptyFolders.length - 5} more folders` });
      }
    }
  }

  private createFooterButtons() {
    this.addActionButton("Cancel", () => this.resolve(false), false);
    this.addActionButton("Move to Trash", () => this.resolve(true), true, "trash-2");
  }

  private resolve(value: boolean) {
    if (this.resolvePromise) {
      this.resolvePromise(value);
      this.resolvePromise = null;
    }
    this.close();
  }

  async open(): Promise<boolean> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      super.open();
    });
  }

  onClose() {
    // Clean up the promise if modal is closed without resolving
    if (this.resolvePromise) {
      this.resolvePromise(false);
      this.resolvePromise = null;
    }
    super.onClose();
  }
}
