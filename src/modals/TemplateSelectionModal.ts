import { App, Modal, TFile, setIcon, FuzzySuggestModal, Notice, FuzzyMatch } from "obsidian";
import type SystemSculptPlugin from "../main";

/**
 * Modal for selecting templates
 */
export class TemplateSelectionModal extends Modal {
  private plugin: SystemSculptPlugin;
  private templateFiles: TFile[] = [];
  private onTemplateSelected: (file: TFile) => Promise<void>;
  private isLoading = true;
  private templatePreviews: Map<string, string> = new Map();
  private searchInput: HTMLInputElement;
  private templateGrid: HTMLElement;
  private searchService: any; // Using any since we don't have the SearchService type here
  private selectedCardIndex: number = -1;
  private templateCards: HTMLElement[] = [];
  private currentSearchResults: TFile[] = [];
  private listeners: { element: HTMLElement; type: string; listener: EventListener }[] = [];

  constructor(
    app: App,
    plugin: SystemSculptPlugin,
    onTemplateSelected: (file: TFile) => Promise<void>
  ) {
    super(app);
    this.plugin = plugin;
    this.onTemplateSelected = onTemplateSelected;
    // Templates will be loaded when open() is called
  }

  // Add method to register event listeners
  private registerListener(element: HTMLElement, type: string, listener: EventListener) {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  // Add method to remove all registered event listeners
  private removeAllListeners() {
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
  }

  /**
   * Override the open method to ensure templates are loaded first
   */
  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("systemsculpt-template-modal");

    // Create loading indicator
    const loadingContainer = contentEl.createDiv({
      cls: "systemsculpt-progress-overlay"
    });

    const statusContainer = loadingContainer.createDiv({
      cls: "systemsculpt-progress-status"
    });

    const statusIcon = statusContainer.createDiv({
      cls: "systemsculpt-progress-status-icon"
    });
    setIcon(statusIcon, 'loader-2');

    const progressText = statusContainer.createSpan({
      text: 'Loading templates...'
    });

    this.isLoading = true;

    // Create search UI
    const searchContainer = contentEl.createDiv({
      cls: "systemsculpt-search-container",
    });

    this.searchInput = searchContainer.createEl("input", {
      type: "text",
      placeholder: "Search templates...",
      cls: "systemsculpt-search-input",
    });

    // Create template grid
    this.templateGrid = contentEl.createDiv({
      cls: "systemsculpt-template-grid"
    });

    // Load templates
    try {
      await this.loadTemplateFiles();

      // Only show the grid if we have templates
      if (this.templateFiles.length > 0) {
        this.isLoading = false;
        this.renderTemplates(this.templateFiles);
      }

      // Setup event listeners
      this.setupEventListeners();
    } catch (error) {
      new Notice("Error loading templates", 3000);
    } finally {
      // Remove loading indicator
      loadingContainer.remove();
      // Focus search
      this.searchInput.focus();
    }
  }

  // Load template files from the system prompts directory
  private async loadTemplateFiles(): Promise<void> {
    const systemPromptsDir = this.plugin.settings.systemPromptsDirectory;

    try {
      // Create the directory if it doesn't exist using DirectoryManager
      if (this.plugin.directoryManager) {
        await this.plugin.directoryManager.ensureDirectoryByPath(systemPromptsDir);
      } else {
        // Fallback to direct creation
        await this.app.vault.createFolder(systemPromptsDir).catch(() => {
          /* Directory might already exist */
        });
      }

      // Get all markdown files in the system prompts directory
      const files = this.app.vault.getMarkdownFiles().filter(file =>
        file.path.startsWith(systemPromptsDir)
      );

      // Only update if we found actual templates
      if (files.length > 0) {
        // Sort the files alphabetically by basename
        this.templateFiles = files.sort((a, b) =>
          a.basename.toLowerCase().localeCompare(b.basename.toLowerCase())
        );

        // Preload template previews
        await this.loadTemplatePreviews();
        this.currentSearchResults = [...this.templateFiles];

      } else {
        // Show placeholder message
        new Notice("No templates found in your system prompts directory", 3000);
        throw new Error("No templates found");
      }
    } catch (error) {
      throw error;
    }
  }

  // Load previews for all templates
  private async loadTemplatePreviews(): Promise<void> {
    // Clear existing previews
    this.templatePreviews.clear();

    // Load previews for each template
    for (const file of this.templateFiles) {
      try {
        const content = await this.app.vault.read(file);
        // Store the first 100 characters as preview, removing newlines
        const preview = content.replace(/\n/g, ' ').trim().slice(0, 100);

        // Add ellipsis if the content was truncated
        const previewText = preview.length < content.length ? preview + '...' : preview;

        this.templatePreviews.set(file.path, previewText);
      } catch (error) {
        this.templatePreviews.set(file.path, 'Error loading preview');
      }
    }
  }

  private setupEventListeners() {
    // Search input
    this.registerListener(this.searchInput, "input", () => {
      const query = this.searchInput.value.toLowerCase();

      if (!query) {
        // Show all templates sorted alphabetically
        this.currentSearchResults = [...this.templateFiles];
        this.selectedCardIndex = -1;
        this.renderTemplates(this.currentSearchResults);
        return;
      }

      // Simple search implementation
      const results = this.templateFiles.filter(file =>
        file.basename.toLowerCase().includes(query) ||
        (this.templatePreviews.get(file.path) || '').toLowerCase().includes(query)
      );

      this.currentSearchResults = results;
      this.selectedCardIndex = -1;
      this.renderTemplates(results);
    });

    // Keyboard navigation
    this.registerListener(this.contentEl, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        if (this.templateCards.length === 0) return;

        if (e.shiftKey) {
          this.selectedCardIndex =
            this.selectedCardIndex <= 0
              ? this.templateCards.length - 1
              : this.selectedCardIndex - 1;
        } else {
          this.selectedCardIndex =
            this.selectedCardIndex >= this.templateCards.length - 1
              ? 0
              : this.selectedCardIndex + 1;
        }

        this.templateCards.forEach((card, i) => {
          const isSelected = i === this.selectedCardIndex;
          card.classList.toggle("systemsculpt-keyboard-selected", isSelected);
          if (isSelected) {
            card.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }
        });
      } else if (e.key === "Enter" && this.selectedCardIndex >= 0 && this.templateCards.length > 0) {
        e.preventDefault();
        const selectedCard = this.templateCards[this.selectedCardIndex];
        if (selectedCard?.dataset.filePath) {
          const file = this.templateFiles.find(f => f.path === selectedCard.dataset.filePath);
          if (file) {
            this.handleTemplateSelection(file);
          }
        }
      }
    });
  }

  private renderTemplates(templates: TFile[]) {
    if (!this.templateGrid) return;

    this.templateGrid.empty();
    this.templateCards = [];

    if (templates.length === 0) {
      const emptyState = this.templateGrid.createDiv({
        cls: "systemsculpt-template-empty",
      });

      const searchIcon = emptyState.createDiv();
      setIcon(searchIcon, "search");

      emptyState.createDiv({
        text: this.searchInput.value
          ? "No templates found matching your search"
          : "No templates found in the system prompts directory",
        cls: "systemsculpt-empty-message"
      });

      return;
    }

    // Create a header
    const header = this.templateGrid.createDiv({
      cls: "systemsculpt-provider-header",
    });
    header.createSpan({ text: "Available Templates" });

    // Create template cards
    templates.forEach(file => {
      const card = this.renderTemplateCard(file);
      this.templateGrid.appendChild(card);
      this.templateCards.push(card);
    });
  }

  private renderTemplateCard(file: TFile): HTMLElement {
    const card = document.createElement("div");
    card.className = "systemsculpt-template-card";
    card.dataset.filePath = file.path;

    const cardContent = card.createDiv({ cls: "systemsculpt-card-content" });

    // Left side with icon
    const iconContainer = cardContent.createDiv({ cls: "systemsculpt-template-icon" });
    setIcon(iconContainer, "file-text");

    // Text container
    const textContainer = cardContent.createDiv({ cls: "systemsculpt-card-text" });

    // Title
    textContainer.createDiv({
      cls: "systemsculpt-template-title",
      text: file.basename
    });

    // Preview
    const preview = this.templatePreviews.get(file.path) || 'Preview not available';
    textContainer.createDiv({
      cls: "systemsculpt-template-preview",
      text: preview
    });

    // Meta info
    const meta = textContainer.createDiv({ cls: "systemsculpt-template-meta" });

    const pathInfo = meta.createDiv({ cls: "systemsculpt-template-info" });
    setIcon(pathInfo, "folder");
    pathInfo.createSpan({ text: file.parent?.path || 'Unknown location' });

    const dateInfo = meta.createDiv({ cls: "systemsculpt-template-info" });
    setIcon(dateInfo, "calendar");
    dateInfo.createSpan({
      text: file.stat ? new Date(file.stat.mtime).toLocaleString() : 'Unknown date'
    });

    // Click handler
    this.registerListener(card, "click", () => {
      this.handleTemplateSelection(file);
    });

    return card;
  }

  private async handleTemplateSelection(file: TFile) {
    await this.onTemplateSelected(file);
    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    this.removeAllListeners();
  }
}