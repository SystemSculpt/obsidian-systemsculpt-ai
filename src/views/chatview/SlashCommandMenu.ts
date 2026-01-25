import { Component, setIcon, Notice, Modal } from "obsidian";
import type SystemSculptPlugin from "../../main";
import type { ChatView } from "./ChatView";
import { CHAT_VIEW_TYPE } from "./ChatView";
import { ChatExportModal } from "./ChatExportModal";

export interface SlashCommand {
  id: string;
  name: string;
  description: string;
  icon: string;
  execute: (chatView: ChatView) => Promise<void>;
}

export interface SlashCommandMenuOptions {
  plugin: SystemSculptPlugin;
  chatView: ChatView;
  inputElement: HTMLTextAreaElement;
  inputHandler: any; // InputHandler reference for accessing its methods
  onClose: () => void;
  onExecute: (command: SlashCommand) => Promise<void>;
}

export class SlashCommandMenu extends Component {
  private plugin: SystemSculptPlugin;
  private chatView: ChatView;
  private inputElement: HTMLTextAreaElement;
  private inputHandler: any; // InputHandler reference
  private onClose: () => void;
  private onExecute: (command: SlashCommand) => Promise<void>;
  
  private menuElement: HTMLElement;
  private searchInput: HTMLInputElement;
  private resultsContainer: HTMLElement;
  private commands: SlashCommand[] = [];
  private filteredCommands: SlashCommand[] = [];
  private selectedIndex = 0;
  private isVisible = false;

  constructor(options: SlashCommandMenuOptions) {
    super();
    this.plugin = options.plugin;
    this.chatView = options.chatView;
    this.inputElement = options.inputElement;
    this.inputHandler = options.inputHandler;
    this.onClose = options.onClose;
    this.onExecute = options.onExecute;
    
    this.initializeCommands();
    this.createMenuElement();
    this.setupEventListeners();
  }

  private initializeCommands(): void {
    this.commands = [
      {
        id: 'new',
        name: 'New Chat',
        description: 'Start a new chat conversation',
        icon: 'plus-circle',
        execute: async (chatView: ChatView) => {
          // Navigate to a new chat using the proper pattern
          const { workspace } = this.plugin.app;
          const leaf = workspace.getLeaf("tab");

          // Set empty view state for a new chat
          await leaf.setViewState({
            type: CHAT_VIEW_TYPE,
            state: {
              chatId: "", // Empty ID for new chat
              selectedModelId: this.plugin.settings.selectedModelId // Default model
            }
          });

          workspace.setActiveLeaf(leaf, { focus: true });
        }
      },
      {
        id: 'clear',
        name: 'Clear Chat',
        description: 'Remove all messages from the current chat',
        icon: 'eraser',
        execute: async (chatView: ChatView) => {
          // Simple vanilla confirmation modal
          const confirmModal = new Modal(this.plugin.app);
          
          confirmModal.onOpen = () => {
            const { contentEl } = confirmModal;
            
            contentEl.createEl('h2', { text: 'Clear chat?' });
            contentEl.createEl('p', { text: 'This will remove all messages from the current chat.' });
            
            const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
            
            const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
            cancelBtn.addEventListener('click', () => confirmModal.close());
            
            const clearBtn = buttonContainer.createEl('button', { 
              text: 'Clear',
              cls: 'mod-warning'
            });
            
            clearBtn.addEventListener('click', async () => {
              try {
                // Empty in-memory message list
                chatView.messages.splice(0, chatView.messages.length);

                // Reset identifiers so the next save starts a fresh conversation
                chatView.chatId = '';
                chatView.chatVersion = 0;
                chatView.isFullyLoaded = false;

                // Clear UI
                chatView.chatContainer.empty();

                // Clear any context files linked to this chat
                chatView.contextManager?.clearContext();

                // Give the user visual feedback
                new Notice('Chat cleared');
              } catch (err) {
                new Notice('Failed to clear chat');
              } finally {
                confirmModal.close();
              }
            });
            
            // Enter key confirms (prevent newline in textarea after focus)
            contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                clearBtn.click();
              }
            });
            
            // Focus the clear button so Enter works immediately
            setTimeout(() => clearBtn.focus(), 0);
          };
          
          // After the modal fully closes, focus the input for immediate typing
          confirmModal.onClose = () => {
            chatView.inputHandler?.focus();
          };
          
          confirmModal.open();
        }
      },
      {
        id: 'agent',
        name: 'Switch Agent',
        description: 'Change the system prompt/agent for this chat',
        icon: 'user-check',
        execute: async (chatView: ChatView) => {
          // Trigger the agent selection menu
          // This will be handled by typing /agent followed by space
          // For now, just close this menu and let the user type /agent
          this.hide();
          
          // Insert /agent into the input if not already there
          const currentValue = this.inputElement.value;
          if (!currentValue.startsWith('/agent')) {
            this.inputElement.value = '/agent ';
            this.inputElement.dispatchEvent(new Event('input'));
          }
        }
      },
      {
        id: 'export',
        name: 'Export Chat',
        description: 'Export chat as markdown note',
        icon: 'download',
        execute: async (chatView: ChatView) => {
          const modal = new ChatExportModal(this.plugin, chatView);
          modal.open();
        }
      },
      {
        id: 'debug',
        name: 'Copy Chat Debug',
        description: 'Copy a full chat debug snapshot to the clipboard',
        icon: 'bug',
        execute: async (chatView: ChatView) => {
          await chatView.copyDebugSnapshotToClipboard();
        }
      },
      {
        id: 'history',
        name: 'Open Chat History',
        description: 'Open the chat history file',
        icon: 'file-text',
        execute: async (chatView: ChatView) => {
          // Call the InputHandler's method
          await this.inputHandler.handleOpenChatHistoryFile();
        }
      },
      {
        id: 'save',
        name: 'Save as Note',
        description: 'Save chat as a markdown note',
        icon: 'file-plus',
        execute: async (chatView: ChatView) => {
          // Call the InputHandler's method
          await this.inputHandler.handleSaveChatAsNote();
        }
      },
      {
        id: 'delete',
        name: 'Delete This Chat',
        description: 'Permanently delete this chat and close the view',
        icon: 'trash-2',
        execute: async (chatView: ChatView) => {
          // Check if there's a chat to delete
          if (!chatView.chatId) {
            new Notice('No chat to delete - this is a new conversation');
            return;
          }

          // Simple vanilla confirmation modal
          const confirmModal = new Modal(this.plugin.app);
          
          confirmModal.onOpen = () => {
            const { contentEl } = confirmModal;
            
            contentEl.createEl('h2', { text: 'Delete this chat?' });
            contentEl.createEl('p', { 
              text: 'This will permanently delete the chat file and close this view. This action cannot be undone.' 
            });
            
            const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
            
            const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
            cancelBtn.addEventListener('click', () => confirmModal.close());
            
            const deleteBtn = buttonContainer.createEl('button', { 
              text: 'Delete Chat',
              cls: 'mod-warning'
            });
            
            deleteBtn.addEventListener('click', async () => {
              try {
                // Get the chat file path
                const chatDirectory = this.plugin.settings.chatsDirectory;
                const filePath = `${chatDirectory}/${chatView.chatId}.md`;
                const file = this.plugin.app.vault.getAbstractFileByPath(filePath);

                // Delete the chat file if it exists
                if (file) {
                  await this.plugin.app.vault.trash(file, true);
                }

                // Close the ChatView
                if (chatView.leaf) {
                  chatView.leaf.detach();
                }

                // Show success notice
                new Notice('Chat deleted successfully');

              } catch (err) {
                new Notice('Failed to delete chat');
              } finally {
                confirmModal.close();
              }
            });

            // Enter key confirms (prevent unintended newline)
            contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                deleteBtn.click();
              }
            });

            // Focus the delete button so Enter works immediately
            setTimeout(() => deleteBtn.focus(), 0);
          };

          confirmModal.open();
        }
      },
      {
        id: 'agent-status',
        name: 'Agent Status',
        description: 'Show agent tools and model compatibility status',
        icon: 'activity',
        execute: async (chatView: ChatView) => {
          await this.showAgentStatus(chatView);
        }
      }
    ];

    this.filteredCommands = [...this.commands];
  }

  /**
   * Shows agent status information including available tools and model compatibility
   */
  private async showAgentStatus(chatView: ChatView): Promise<void> {
    const statusModal = new Modal(this.plugin.app);

    statusModal.onOpen = async () => {
      const { contentEl } = statusModal;
      contentEl.empty();

      contentEl.createEl('h2', { text: 'Agent Status' });

      // Loading state
      const loadingEl = contentEl.createEl('p', { text: 'Loading status...' });

      try {
        // Import utilities dynamically
        const { MCPService } = await import('./MCPService');
        const { getToolCompatibilityInfo, ensureCanonicalId, getDisplayName } = await import('../../utils/modelUtils');

        // Get MCP service and tools
        const mcpService = new MCPService(this.plugin, this.plugin.app);
        const tools = await mcpService.getAvailableTools();

        // Get model info
        let modelCompatibility: { isCompatible: boolean; confidence: 'high' | 'medium' | 'low'; reason: string } = {
          isCompatible: true,
          confidence: 'low',
          reason: 'No model selected'
        };
        let modelName = 'No model selected';

        if (chatView.selectedModelId) {
          const models = await this.plugin.modelService.getModels();
          const canonicalId = ensureCanonicalId(chatView.selectedModelId);
          const model = models.find(m => ensureCanonicalId(m.id) === canonicalId);
          modelName = getDisplayName(canonicalId);

          if (model) {
            modelCompatibility = getToolCompatibilityInfo(model);
          }
        }

        // Remove loading
        loadingEl.remove();

        // Model section
        const modelSection = contentEl.createDiv({ cls: 'systemsculpt-agent-status-section' });
        modelSection.createEl('h3', { text: 'Current Model' });
        const modelInfo = modelSection.createEl('p');
        modelInfo.textContent = modelName;

        // Tool compatibility
        const compatSection = contentEl.createDiv({ cls: 'systemsculpt-agent-status-section' });
        compatSection.createEl('h3', { text: 'Tool Support' });
        const compatInfo = compatSection.createEl('p');

        if (modelCompatibility.isCompatible) {
          compatInfo.textContent = `✓ Compatible (${modelCompatibility.confidence} confidence)`;
          compatInfo.style.color = 'var(--text-success)';
        } else {
          compatInfo.textContent = `✗ Not Compatible - ${modelCompatibility.reason}`;
          compatInfo.style.color = 'var(--text-error)';
        }

        // Tools section
        const toolsSection = contentEl.createDiv({ cls: 'systemsculpt-agent-status-section' });
        toolsSection.createEl('h3', { text: `Available Tools (${tools.length})` });

        if (tools.length === 0) {
          toolsSection.createEl('p', { text: 'No tools available' });
        } else {
          const toolList = toolsSection.createEl('ul', { cls: 'systemsculpt-agent-status-tools' });

          // Group tools by server
          const toolsByServer: Record<string, string[]> = {};
          for (const tool of tools) {
            const name = tool.function?.name || 'unknown';
            const [serverId] = name.split('_');
            if (!toolsByServer[serverId]) toolsByServer[serverId] = [];
            toolsByServer[serverId].push(name.replace(`${serverId}_`, ''));
          }

          for (const [serverId, serverTools] of Object.entries(toolsByServer)) {
            const serverItem = toolList.createEl('li');
            serverItem.createEl('strong', { text: serverId });
            serverItem.createEl('span', { text: ` (${serverTools.length} tools)` });

            const toolSubList = serverItem.createEl('ul');
            // Show first 5 tools, then "and X more"
            const displayTools = serverTools.slice(0, 5);
            const remaining = serverTools.length - 5;

            for (const t of displayTools) {
              toolSubList.createEl('li', { text: t });
            }

            if (remaining > 0) {
              toolSubList.createEl('li', { text: `...and ${remaining} more`, cls: 'systemsculpt-agent-status-more' });
            }
          }
        }

        // Close button
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        const closeBtn = buttonContainer.createEl('button', { text: 'Close' });
        closeBtn.addEventListener('click', () => statusModal.close());

      } catch (error) {
        loadingEl.textContent = `Error loading status: ${error instanceof Error ? error.message : 'Unknown error'}`;
      }
    };

    statusModal.open();
  }

  private createMenuElement(): void {
    this.menuElement = document.createElement('div');
    this.menuElement.className = 'systemsculpt-slash-command-menu';
    
    // Create results container first (so it appears at the top)
    this.resultsContainer = this.menuElement.createEl('div', { cls: 'systemsculpt-slash-results-container' });
    
    // Create search input at the bottom
    const searchContainer = this.menuElement.createEl('div', { cls: 'systemsculpt-slash-search-container' });
    
    const searchIcon = searchContainer.createEl('div', { cls: 'systemsculpt-slash-search-icon' });
    setIcon(searchIcon, 'search');
    
    this.searchInput = searchContainer.createEl('input', {
      cls: 'systemsculpt-slash-search-input',
      attr: { placeholder: 'Search commands...' }
    });
    
    // Initially hidden
    this.menuElement.style.display = 'none';
    
    // Add to document body to avoid positioning issues
    document.body.appendChild(this.menuElement);
  }

  private setupEventListeners(): void {
    // Search input events
    this.registerDomEvent(this.searchInput, 'input', () => {
      this.filterCommands();
    });
    
    this.registerDomEvent(this.searchInput, 'keydown', (e: KeyboardEvent) => {
      this.handleSearchKeydown(e);
    });
    
    // Close menu when clicking outside
    this.registerDomEvent(document, 'click', (e: MouseEvent) => {
      if (!this.menuElement.contains(e.target as Node)) {
        this.hide();
      }
    });
  }

  private filterCommands(): void {
    const query = this.searchInput.value.toLowerCase();
    this.filteredCommands = this.commands.filter(cmd => 
      cmd.name.toLowerCase().includes(query) || 
      cmd.description.toLowerCase().includes(query)
    );
    this.selectedIndex = 0;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultsContainer.empty();
    
    if (this.filteredCommands.length === 0) {
      // Show empty state
      const emptyState = this.resultsContainer.createEl('div', { cls: 'systemsculpt-slash-empty-state' });
      emptyState.textContent = 'No commands found';
      return;
    }
    
    this.filteredCommands.forEach((command, index) => {
      const item = this.resultsContainer.createEl('div', {
        cls: `systemsculpt-slash-result-item ${index === this.selectedIndex ? 'is-selected' : ''}`
      });
      
      const icon = item.createEl('div', { cls: 'systemsculpt-slash-result-icon' });
      setIcon(icon, command.icon);
      
      const content = item.createEl('div', { cls: 'systemsculpt-slash-result-content' });
      const title = content.createEl('div', { cls: 'systemsculpt-slash-result-title', text: command.name });
      const description = content.createEl('div', { cls: 'systemsculpt-slash-result-description', text: command.description });
      
      this.registerDomEvent(item, 'click', () => {
        this.executeCommand(command);
      });
      
      this.registerDomEvent(item, 'mouseover', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });
    });
  }

  private handleSearchKeydown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = (this.selectedIndex + 1) % this.filteredCommands.length;
        this.updateSelection();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredCommands.length - 1 : this.selectedIndex - 1;
        this.updateSelection();
        break;
      case 'Enter':
        e.preventDefault();
        if (this.filteredCommands.length > 0) {
          this.executeCommand(this.filteredCommands[this.selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hide();
        break;
      case 'Backspace':
        if (this.searchInput.value === '') {
          e.preventDefault();
          this.removeSlashAndClose();
        }
        break;
    }
  }

  private updateSelection(): void {
    const items = this.resultsContainer.querySelectorAll('.systemsculpt-slash-result-item');
    items.forEach((item, index) => {
      item.classList.toggle('is-selected', index === this.selectedIndex);
    });
    
    // Scroll selected item into view
    const selectedItem = items[this.selectedIndex] as HTMLElement;
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }

  private async executeCommand(command: SlashCommand): Promise<void> {
    try {
      await this.onExecute(command);
      this.hide();
    } catch (error) {
      new Notice(`Error executing command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public show(query = ''): void {
    this.isVisible = true;
    this.searchInput.value = query;
    this.filterCommands();
    
    // Position the menu relative to the input
    this.positionMenu();
    
    this.menuElement.style.display = 'block';
    this.searchInput.focus();
  }

  public hide(): void {
    if (!this.isVisible) return;
    
    this.isVisible = false;
    this.menuElement.style.display = 'none';
    this.searchInput.value = '';
    this.onClose();
  }

  public isOpen(): boolean {
    return this.isVisible;
  }

  public updateQuery(query: string): void {
    if (!this.isVisible) return;
    
    this.searchInput.value = query;
    this.filterCommands();
  }

  public handleKeydown(e: KeyboardEvent): boolean {
    if (!this.isVisible) return false;
    
    // Forward arrow keys and enter to search input
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
      this.handleSearchKeydown(e);
      return true;
    }
    
    return false;
  }

  private positionMenu(): void {
    const inputRect = this.inputElement.getBoundingClientRect();
    const menuWidth = 400;
    
    // Position above the input to avoid covering it, but anchor to bottom
    let bottom = window.innerHeight - inputRect.top + 10; // Distance from bottom of viewport
    let left = inputRect.left;
    
    // Ensure menu stays within viewport horizontally
    if (left + menuWidth > window.innerWidth - 10) {
      left = window.innerWidth - menuWidth - 10;
    }
    
    // Check if there's enough space above the input
    if (inputRect.top < 320) { // Not enough space above, position below instead
      this.menuElement.style.position = 'fixed';
      this.menuElement.style.top = `${inputRect.bottom + 10}px`;
      this.menuElement.style.bottom = 'auto';
    } else {
      // Position above input, anchored to bottom so it shrinks downward
      this.menuElement.style.position = 'fixed';
      this.menuElement.style.top = 'auto';
      this.menuElement.style.bottom = `${bottom}px`;
    }
    
    this.menuElement.style.left = `${left}px`;
    this.menuElement.style.zIndex = '1000';
  }

  private removeSlashAndClose(): void {
    // Remove the / symbol from the input
    const currentValue = this.inputElement.value;
    if (currentValue.startsWith('/')) {
      this.inputElement.value = currentValue.substring(1);
      // Set cursor to beginning
      this.inputElement.selectionStart = this.inputElement.selectionEnd = 0;
    }
    
    // Close the menu
    this.hide();
  }

  public unload(): void {
    if (this.menuElement && this.menuElement.parentNode) {
      this.menuElement.parentNode.removeChild(this.menuElement);
    }
    super.unload();
  }
} 
