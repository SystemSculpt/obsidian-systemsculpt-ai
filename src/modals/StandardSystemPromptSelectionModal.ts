import { App, setIcon, Setting, Notice, Modal, ButtonComponent } from "obsidian";
import { ListItem, ListSelectionModal } from "../core/ui/modals/standard";
import SystemSculptPlugin from "../main";
import { SystemPromptService } from "../services/SystemPromptService";
import { GENERAL_USE_PRESET, CONCISE_PRESET } from "../constants/prompts";
import { SearchService, SearchableField } from "../services/SearchService";
import { SystemPromptCreatorModal } from "./SystemPromptCreatorModal";
import * as path from 'path';

// Define the result type for the onSelect callback
export interface SystemPromptSelectionResult {
  type: "general-use" | "concise" | "agent" | "custom";
  prompt: string;
  path?: string;
}

// Define options for the modal constructor
export interface SystemPromptSelectionOptions {
  app: App;
  plugin: SystemSculptPlugin;
  currentType: "general-use" | "concise" | "agent" | "custom";
  currentPath?: string;
  onSelect: (result: SystemPromptSelectionResult) => void;
  title?: string; // Optional custom title
  description?: string; // Optional custom description
}

interface SystemPromptItem {
  id: string;
  name: string;
  description: string;
  type: "general-use" | "concise" | "agent" | "custom";
  path?: string;
  prompt?: string;
}

/**
 * StandardSystemPromptSelectionModal provides a standardized system prompt selection experience
 * using the new modal system.
 */
export class StandardSystemPromptSelectionModal {
  private app: App;
  private plugin: SystemSculptPlugin;
  private systemPromptService: SystemPromptService;
  private searchService: SearchService;
  private currentType: "general-use" | "concise" | "agent" | "custom";
  private currentPath?: string;
  private onSelect: (result: SystemPromptSelectionResult) => void;
  private modalInstance: ListSelectionModal | null = null;
  private allItems: SystemPromptItem[] = [];
  private filteredItems: SystemPromptItem[] = [];
  private modalTitle: string; // Custom title for the modal
  private modalDescription: string; // Custom description for the modal

  constructor(options: SystemPromptSelectionOptions) {
    this.app = options.app;
    this.plugin = options.plugin;
    this.currentType = options.currentType;
    this.currentPath = options.currentPath;
    this.onSelect = options.onSelect;
    this.modalTitle = options.title || "Select System Prompt";
    this.modalDescription = options.description || "Choose a system prompt for this conversation";

    // Initialize services
    this.systemPromptService = SystemPromptService.getInstance(this.app, () => this.plugin.settings);
    this.searchService = SearchService.getInstance();

  }

  /**
   * Load all available system prompt items
   */
  private async loadSystemPromptItems(): Promise<SystemPromptItem[]> {
    const items: SystemPromptItem[] = [];

    // Add preset options
    items.push({
      id: "general-use",
      name: "General Use",
      description: "A comprehensive prompt for general conversations",
      type: "general-use",
      prompt: GENERAL_USE_PRESET.systemPrompt
    });

    items.push({
      id: "concise",
      name: "Concise",
      description: "A focused prompt for brief, direct responses",
      type: "concise",
      prompt: CONCISE_PRESET.systemPrompt
    });

    // Add custom prompt files
    try {
      const customFiles = await this.systemPromptService.getCustomPromptFiles();
      for (const file of customFiles) {
        items.push({
          id: `custom-${file.path}`,
          name: file.name,
          description: `Custom prompt from: ${file.path}`,
          type: "custom",
          path: file.path
        });
      }
    } catch (error) {
    }

    return items;
  }

  /**
   * Convert system prompt items to list items for the modal
   */
  private convertToListItems(items: SystemPromptItem[]): ListItem[] {
    return items.map(item => {
      const isSelected = this.isItemSelected(item);
      
      return {
        id: item.id,
        title: item.name,
        description: item.description,
        icon: this.getItemIcon(item),
        selected: isSelected,
        badge: item.type === "custom" ? "Custom" : ""
      };
    });
  }

  /**
   * Check if an item is currently selected
   */
  private isItemSelected(item: SystemPromptItem): boolean {
    if (item.type === "custom" && this.currentType === "custom") {
      return item.path === this.currentPath;
    }
    return item.type === this.currentType;
  }

  /**
   * Get icon for a system prompt item
   */
  private getItemIcon(item: SystemPromptItem): string {
    switch (item.type) {
      case "general-use":
        return "message-square";
      case "concise":
        return "zap";
      case "agent":
        return "cpu";
      case "custom":
        return "file-text";
      default:
        return "file-text";
    }
  }

  /**
   * Search system prompt items
   */
  private searchItems(items: SystemPromptItem[], query: string): ListItem[] {
    if (!query || query.trim() === '') {
      return this.convertToListItems(items);
    }

    const results = this.searchService.search(
      items,
      query,
      (item) => this.getSearchableFields(item),
      {
        initialResultsLimit: 25,
        maxFilteredResults: 50,
      }
    );

    const filteredResults = results
      .filter(result => result.matches.length > 0 && result.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(result => result.item);

    return this.convertToListItems(filteredResults);
  }

  /**
   * Get searchable fields from a system prompt item
   */
  private getSearchableFields(item: SystemPromptItem): SearchableField[] {
    return [
      { field: "name", text: item.name || "", weight: 2.0 },
      { field: "description", text: item.description || "", weight: 1.0 },
      { field: "type", text: item.type || "", weight: 0.5 }
    ];
  }

  /**
   * Create filter controls
   */
  private createFilters(containerEl: HTMLElement): void {
    const filtersContainer = containerEl.createDiv({ cls: "ss-modal-filters-container" });

    // Create action buttons container
    const actionsContainer = containerEl.createDiv({ cls: "ss-modal-actions-container" });

    // Add "Create New System Prompt" button
    const createButton = actionsContainer.createEl("button", {
      text: "Create New System Prompt",
      cls: "mod-cta ss-modal-create-button",
    });

    const createIconSpan = createButton.createSpan({ cls: "ss-modal-create-icon" });
    setIcon(createIconSpan, "plus-circle");

    createButton.addEventListener("click", () => {
      this.openSystemPromptCreator();
    });

    // Add a refresh button to reload custom prompts
    const refreshButton = actionsContainer.createEl("button", {
      text: "Refresh Custom Prompts",
      cls: "ss-modal-refresh-button",
    });

    const refreshIconSpan = refreshButton.createSpan({ cls: "ss-modal-refresh-icon" });
    setIcon(refreshIconSpan, "refresh-cw");

    refreshButton.addEventListener("click", async () => {
      const originalText = refreshButton.textContent || "Refresh Custom Prompts";
      refreshButton.textContent = "Refreshing...";
      refreshButton.classList.add("is-loading");
      refreshIconSpan.addClass("ss-modal-refresh-icon--spinning");

      try {
        this.allItems = await this.loadSystemPromptItems();
        this.updateItemList();
      } catch (error) {
      } finally {
        refreshButton.textContent = originalText;
        refreshButton.classList.remove("is-loading");
        refreshIconSpan.removeClass("ss-modal-refresh-icon--spinning");
      }
    });
  }

  /**
   * Open the system prompt creator modal
   */
  private openSystemPromptCreator(): void {
    const creatorModal = new SystemPromptCreatorModal({
      app: this.app,
      plugin: this.plugin,
      onCreated: async (filePath: string) => {
        // Refresh the system prompt items to include the newly created one
        try {
          this.allItems = await this.loadSystemPromptItems();
          this.updateItemList();
          
          // Optional: Auto-select the newly created prompt
          // We can find it by path and auto-select it
          const newItem = this.allItems.find(item => item.path === filePath);
          if (newItem && this.modalInstance) {
            // Trigger selection of the new item
            setTimeout(() => {
              // Find the list item and trigger selection
              const listItems = this.modalInstance?.contentEl.querySelectorAll('.ss-modal__list-item');
              const targetItem = Array.from(listItems || []).find(
                el => el.getAttribute('data-id') === newItem.id
              ) as HTMLElement;
              
              if (targetItem) {
                targetItem.click();
              }
            }, 100);
          }
          
          new Notice('System prompt list updated with your new prompt!', 3000);
        } catch (error) {
          new Notice('Created prompt successfully, but failed to refresh list. Please refresh manually.', 5000);
        }
      }
    });
    
    creatorModal.open();
  }

  /**
   * Update the item list
   */
  private updateItemList(): void {
    if (!this.modalInstance) {
      return;
    }

    const items = this.convertToListItems(this.allItems);
    this.modalInstance.setItems(items);
  }

  /**
   * Show warning when agent prompt is selected but agent mode is disabled
   */
  private async showAgentModeWarning(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.textContent = "Agent Mode Required";
      
      const content = modal.contentEl;
      content.empty();
      
      content.createEl("p", {
        text: "The Agent prompt requires Agent Mode to be enabled for full functionality. Agent Mode provides the AI with vault exploration and file operation capabilities."
      });
      
      content.createEl("p", {
        text: "Would you like to enable Agent Mode now?"
      });
      
      const buttonContainer = content.createDiv({ cls: "ss-modal-button-container ss-modal-margin-top-16" });
      
      new ButtonComponent(buttonContainer)
        .setButtonText("Cancel")
        .onClick(() => {
          modal.close();
          resolve(false);
        });
        
      new ButtonComponent(buttonContainer)
        .setButtonText("Enable Agent Mode")
        .setCta()
        .onClick(() => {
          modal.close();
          resolve(true);
        });
      
      modal.open();
    });
  }

  /**
   * Open the modal and get selection
   */
  async open() {
    try {
      // Note: Agent mode check is now handled at the chat view level since it's per-chat

      // Load all system prompt items
      this.allItems = await this.loadSystemPromptItems();
      const items = this.convertToListItems(this.allItems);

      // Create the modal
      const modal = new ListSelectionModal(this.app, items, {
        title: this.modalTitle,
        description: this.modalDescription,
        emptyText: "No system prompts found.",
        placeholder: "Search prompts...",
        withSearch: true,
        size: "medium",
        closeOnSelect: true,
        customContent: (containerEl: HTMLElement) => {
          // Add filter controls
          this.createFilters(containerEl);
        }
      });

      // Store the modal instance
      this.modalInstance = modal;

      // Add custom class to modal
      modal.contentEl.addClass("systemsculpt-system-prompt-selection-modal");

      // Custom search handler
      modal.setCustomSearchHandler(async (query: string) => {
        return this.searchItems(this.allItems, query);
      });

      // Open the modal and wait for selection
      const selectedItems = await modal.openAndGetSelection();

      // Process the selection
      if (selectedItems && selectedItems.length > 0) {
        const selectedItem = selectedItems[0];
        const item = this.allItems.find(i => i.id === selectedItem.id);

        if (item) {
          // Note: Agent prompt selection is now handled at the chat view level since agent mode is per-chat

          let result: SystemPromptSelectionResult;

          if (item.type === "custom" && item.path) {
            // Load the custom prompt content
            const customPrompt = await this.systemPromptService.getSystemPromptContent("custom", item.path);
            result = {
              type: "custom",
              prompt: customPrompt,
              path: item.path
            };
          } else {
            // Use preset prompt
            result = {
              type: item.type,
              prompt: item.prompt || ""
            };
          }

          // Call the onSelect callback
          this.onSelect(result);
        }
      } else {
      }
    } catch (error) {
    }
  }
}