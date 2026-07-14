import { App, Notice, TFile, TFolder, setIcon } from "obsidian";
import SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { createUiAction, createUiState } from "../core/ui/surface";
import {
  JanitorConfirmationListModal,
  formatJanitorFileSize,
  janitorFileIcon,
} from "./JanitorConfirmationListModal";

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
  private isScanning = false;
  private mainContainer!: HTMLElement;
  private loadingState!: HTMLElement;

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;
    this.setSize("large");
  }

  onOpen() {
    super.onOpen();
    this.modalEl.addClass("ss-janitor-modal");

    this.addTitle(
      "Janitor",
      "Review vault cleanup before moving anything to Trash.",
    );

    this.createMainContainer();
    this.addActionButton("Refresh", () => this.refreshData(), false, "refresh-cw");
    this.addActionButton("Close", () => this.close(), false);
    this.loadJanitorData();
  }

  private createMainContainer() {
    this.mainContainer = this.contentEl.createDiv({ cls: "ss-janitor-main" });
    this.loadingState = createUiState(this.contentEl, {
      kind: "loading",
      title: "Scanning vault",
      detail: "Checking files and folders.",
    });
    this.loadingState.addClass("ss-janitor-loading");
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
      empty: formatJanitorFileSize(emptyFiles),
      chat: formatJanitorFileSize(chatFiles),
      extraction: formatJanitorFileSize(extractionFiles),
      recording: formatJanitorFileSize(recordingFiles)
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
    const task = this.beginAsyncTask("janitor-scan");
    
    try {
      this.isScanning = true;
      this.showLoading(true);
      
      // Scan vault once and get all data
      const data = await this.scanVault();
      if (!task.isCurrent()) return;
      
      // Hide loading and show content
      this.showLoading(false);
      this.populateAllSections(data);
      
    } catch (error) {
      if (task.isCurrent()) {
        this.showError("Failed to scan vault. Please try refreshing.");
      }
    } finally {
      if (task.isCurrent()) {
        this.isScanning = false;
      }
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
      "Empty content",
      "Empty files and folders.",
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { emptyFiles, emptyFolders, stats } = data;

    this.createStatCard(statsContainer, "Files", stats.emptyFileCount, "file-text");
    this.createStatCard(statsContainer, "Folders", stats.emptyFolderCount, "folder");

    this.createCleanupAction(
      actionContainer,
      stats.totalEmptyCount > 0
        ? `Move ${stats.totalEmptyCount} items to Trash`
        : "Nothing to remove",
      stats.totalEmptyCount > 0,
      async () => {
        await this.showEmptyContentConfirmation(emptyFiles, emptyFolders, () => {
          this.refreshData();
        });
      },
    );
  }

  private createChatHistorySection(container: HTMLElement, data: JanitorData) {
    const section = this.createModernSection(
      container,
      "Chat history",
      "Saved conversations.",
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { chatFiles, sizes } = data;
    const hasChatFiles = chatFiles.length > 0;

    this.createStatCard(statsContainer, "Chats", chatFiles.length, "message-circle");
    this.createStatCard(statsContainer, "Size", sizes.chat, "hard-drive");

    this.createCleanupAction(
      actionContainer,
      hasChatFiles
        ? `Move ${chatFiles.length} chats to Trash`
        : "No chat history",
      hasChatFiles,
      async () => {
        await this.showConfirmationDialog(
          chatFiles,
          "Chat History",
          this.plugin.settings.chatsDirectory,
          () => this.refreshData(),
        );
      },
    );
  }

  private createExtractionsSection(container: HTMLElement, data: JanitorData) {
    const section = this.createModernSection(
      container,
      "Document extractions",
      "Cached document content.",
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { extractionFiles, sizes } = data;
    const hasExtractionFiles = extractionFiles.length > 0;

    this.createStatCard(statsContainer, "Files", extractionFiles.length, "file-text");
    this.createStatCard(statsContainer, "Size", sizes.extraction, "hard-drive");

    this.createCleanupAction(
      actionContainer,
      hasExtractionFiles
        ? `Move ${extractionFiles.length} files to Trash`
        : "No extractions",
      hasExtractionFiles,
      async () => {
        await this.showConfirmationDialog(
          extractionFiles,
          "Extractions",
          this.plugin.settings.extractionsDirectory,
          () => this.refreshData(),
        );
      },
    );
  }

  private createRecordingsSection(container: HTMLElement, data: JanitorData) {
    const section = this.createModernSection(
      container,
      "Audio recordings",
      "Audio files; transcripts stay in your vault.",
    );

    const statsContainer = section.content.createDiv({ cls: "ss-janitor-stats" });
    const actionContainer = section.content.createDiv({ cls: "ss-janitor-actions" });

    const { recordingFiles, sizes } = data;
    const hasRecordingFiles = recordingFiles.length > 0;

    this.createStatCard(statsContainer, "Files", recordingFiles.length, "audio-lines");
    this.createStatCard(statsContainer, "Size", sizes.recording, "hard-drive");

    this.createCleanupAction(
      actionContainer,
      hasRecordingFiles
        ? `Move ${recordingFiles.length} files to Trash`
        : "No recordings",
      hasRecordingFiles,
      async () => {
        await this.showConfirmationDialog(
          recordingFiles,
          "Recordings",
          this.plugin.settings.recordingsDirectory,
          () => this.refreshData(),
        );
      },
    );
  }

  private createCleanupAction(
    container: HTMLElement,
    label: string,
    enabled: boolean,
    onSelect: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = createUiAction(container, {
      label,
      tone: enabled ? "danger" : "default",
      disabled: !enabled,
    });
    button.addClass("ss-janitor-action");
    if (enabled) {
      this.registerDomEvent(button, "click", () => void onSelect());
    }
    return button;
  }

  private createModernSection(
    container: HTMLElement,
    title: string,
    description: string,
  ) {
    const section = container.createDiv({ cls: "ss-janitor-section" });

    const header = section.createDiv({ cls: "ss-janitor-section-header" });
    header.createDiv({ cls: "ss-janitor-section-title", text: title });
    header.createDiv({
      cls: "ss-janitor-section-description",
      text: description,
    });

    const content = section.createDiv({ cls: "ss-janitor-section-content" });

    return { content };
  }

  private createStatCard(
    container: HTMLElement,
    label: string,
    value: string | number,
    icon: string,
  ) {
    const card = container.createDiv({ cls: "ss-janitor-stat-card" });

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
    this.loadJanitorData();
  }

  /**
   * Show/hide loading overlay
   */
  private showLoading(show: boolean) {
    this.loadingState.toggleAttribute("hidden", !show);
    this.mainContainer.toggleAttribute("hidden", show);
  }

  /**
   * Show error state
   */
  private showError(message: string) {
    this.showLoading(false);
    this.mainContainer.empty();

    const errorState = createUiState(this.mainContainer, {
      kind: "error",
      title: "Couldn’t scan vault",
      detail: message,
      action: {
        label: "Retry",
        tone: "primary",
        onSelect: () => this.refreshData(),
      },
    });
    errorState.addClass("ss-janitor-error");
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
      await this.app.fileManager.trashFile(file);
    }

    // Clean up empty directories
    const folder = this.app.vault.getAbstractFileByPath(directory);
    if (folder instanceof TFolder) {
      const subdirs = folder.children
        .filter((child): child is TFolder => child instanceof TFolder)
        .sort((a, b) => b.path.length - a.path.length);

      for (const subdir of subdirs) {
        if (subdir.children.length === 0) {
          await this.app.fileManager.trashFile(subdir);
        }
      }

      if (folder.children.length === 0) {
        await this.app.fileManager.trashFile(folder);
      }
    }
  }

  private async showConfirmationDialog(
    files: TFile[],
    type: string,
    directory: string,
    onSuccess: () => void
  ) {
    const confirmModal = new JanitorConfirmationListModal(this.app, {
      title: `Move ${type} to Trash`,
      description: `${files.length} files from ${directory} will move to Obsidian Trash. You can restore them later.`,
      summary: `${files.length} files (${formatJanitorFileSize(files)})`,
      groups: [{
        items: files.map((file) => ({
          path: file.path,
          icon: janitorFileIcon(file.extension),
          detail: formatJanitorFileSize([file]),
        })),
        previewLimit: 10,
        moreLabel: "files",
      }],
    });

    const result = await confirmModal.open();
    if (result) {
      try {
        await this.cleanDirectory(directory);
        new Notice(
          `Moved ${files.length} ${type.toLowerCase()} files (${formatJanitorFileSize(files)}) to trash.`,
        );
        onSuccess();
      } catch {
        new Notice(`Couldn’t clear ${type.toLowerCase()}.`);
      }
    }
  }

  private async showEmptyContentConfirmation(
    emptyFiles: TFile[],
    emptyFolders: TFolder[],
    onSuccess: () => void
  ) {
    const totalEmpty = emptyFiles.length + emptyFolders.length;
    const confirmModal = new JanitorConfirmationListModal(this.app, {
      title: "Move Empty Content to Trash",
      description: `${totalEmpty} empty items will move to Obsidian Trash. You can restore them later.`,
      groups: [
        {
          title: "Empty Files",
          icon: "file-text",
          items: emptyFiles.map((file) => ({
            path: file.path,
            icon: "file-text",
          })),
          previewLimit: 5,
          moreLabel: "files",
        },
        {
          title: "Empty Folders",
          icon: "folder",
          items: emptyFolders.map((folder) => ({
            path: folder.path,
            icon: "folder",
          })),
          previewLimit: 5,
          moreLabel: "folders",
        },
      ],
    });

    const result = await confirmModal.open();
    if (result) {
      try {
        // Delete empty files first
        for (const file of emptyFiles) {
          await this.app.fileManager.trashFile(file);
        }

        // Then delete empty folders (deepest first)
        const sortedFolders = [...emptyFolders].sort(
          (a, b) => b.path.length - a.path.length
        );
        for (const folder of sortedFolders) {
          await this.app.fileManager.trashFile(folder);
        }

        new Notice(`Moved ${totalEmpty} empty items to trash.`);
        onSuccess();
      } catch {
        new Notice("Couldn’t clear empty content.");
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
    this.isScanning = false;
    super.onClose();
  }
}
