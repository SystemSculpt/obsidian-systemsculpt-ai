import { App, ButtonComponent, Modal, Notice, SearchComponent, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import SystemSculptPlugin from "../../main";
import { ChatMessage, ChatRole } from "../../types";
import { showPopup } from "../../core/ui";
import { SearchService, SearchResult } from "../../services/SearchService";
import { ChatStorageService } from "./ChatStorageService";
import { StandardModal } from "../../core/ui/modals/standard/StandardModal";
import { CHAT_VIEW_TYPE } from "./ChatView";
import { ChatState } from "../../types/index";
import { FavoritesService } from "../../services/FavoritesService";
import { ChatFavoritesService } from "./ChatFavoritesService";
import { ChatFavoriteToggle } from "./ChatFavoriteToggle";

interface ChatHistoryItem {
  id: string;
  messages: ChatMessage[];
  selectedModelId: string;
  lastModified: number;
  title: string;
  context_files?: string[];
  customPromptFilePath?: string;
  systemPromptType?: string;
}

// Define structure to fill in the missing information
interface ChatDocument {
  id: string;
  text: string;
  metadata: {
  item: ChatHistoryItem;
  }
}

// Simplified interface for chat items in the list
interface ChatListItem {
    id: string;
    title: string;
    lastModified: number;
    selectedModelId: string; // Keep this for opening the chat
    messages: ChatMessage[]; // Keep messages for searching within content
    isFavorite: boolean;
}

/**
 * Simplified modal for loading chat history
 */
export class LoadChatModal extends StandardModal {
  private chatItems: ChatHistoryItem[] = [];
  private searchService: SearchService;
  private chatStorage: ChatStorageService;
  private chatListContainer: HTMLElement;
  private searchInput: SearchComponent;
  private emptyStateEl: HTMLElement;
  private isLoading = false;
  private modelNameCache = new Map<string, string>();
  private allChats: ChatListItem[] = [];
  private filteredChats: ChatListItem[] = [];
  private favoritesService: FavoritesService;
  private chatFavoritesService: ChatFavoritesService;
  private showFavoritesOnlyChats: boolean = false;

  // Keyboard navigation
  private keyboardSelectedIndex: number = -1;
  private chatItemElements: HTMLElement[] = [];
  
  // Guard against multiple opens
  private isOpening = false;

  constructor(private plugin: SystemSculptPlugin) {
    super(plugin.app);

    // Initialize services
    this.searchService = new SearchService();
    this.chatStorage = new ChatStorageService(plugin.app, plugin.settings.chatsDirectory || "SystemSculpt/Chats");
    this.favoritesService = FavoritesService.getInstance(plugin);
    this.chatFavoritesService = ChatFavoritesService.getInstance(plugin);
    
    // Set up modal
    this.setSize("large");
    this.modalEl.addClass("systemsculpt-load-chat-modal");
  }

  async onOpen() {
    super.onOpen();
    
    // Set title
    this.addTitle("Load Chat", "Select a chat to continue your conversation");
    
    // Create search input
    this.createSearchBar();
    
    // Create chat list container
    this.chatListContainer = this.contentEl.createDiv("systemsculpt-chat-list");
    this.chatListContainer.style.height = "400px";
    this.chatListContainer.style.overflow = "auto";
    
    // Create empty state
    this.emptyStateEl = this.contentEl.createDiv("systemsculpt-empty-state");
    this.emptyStateEl.style.display = "none";
    this.emptyStateEl.style.textAlign = "center";
    this.emptyStateEl.style.padding = "20px";
    this.emptyStateEl.style.color = "var(--text-muted)";
    setIcon(this.emptyStateEl.createDiv(), "message-square");
    this.emptyStateEl.createDiv().setText("No chats found");
    
    // Add buttons
    const cancelButton = this.addActionButton("Cancel", () => {
      this.close();
    }, false);
    
    // Add "New Chat" button
    const newChatButton = this.addActionButton("Open New Chat Instead", () => {
      this.openNewChat();
    }, false);
    newChatButton.style.marginRight = "auto";
    
    // Global keyboard handlers for the modal
    this.modalEl.addEventListener("keydown", (e) => {
      this.handleModalKeydown(e);
    });
    
    // Load chats
    this.isLoading = true;
    await this.loadAndDisplayChats();
  }

  private createSearchBar() {
    const searchContainer = this.contentEl.createDiv("systemsculpt-search-container");
    searchContainer.style.marginBottom = "16px";
    searchContainer.style.display = "flex";
    searchContainer.style.gap = "8px";

    this.searchInput = new SearchComponent(searchContainer);
    this.searchInput.setPlaceholder("Search chats by title & content...");
    this.searchInput.inputEl.style.flexGrow = "1";

    const favContainer = searchContainer.createDiv();
    const favToggle = favContainer.createDiv({
      cls: "systemsculpt-favorites-filter",
      attr: { role: "button", tabindex: "0" }
    });
    const starIcon = favToggle.createSpan({ cls: "systemsculpt-favorites-icon" });
    setIcon(starIcon, "star");
    const label = favToggle.createSpan({ cls: "systemsculpt-favorites-label" });
    const updateFavToggle = () => {
      if (this.showFavoritesOnlyChats) {
        favToggle.addClass("is-active");
        favToggle.setAttr("aria-pressed", "true");
        label.setText("Favorites only");
      } else {
        favToggle.removeClass("is-active");
        favToggle.setAttr("aria-pressed", "false");
        label.setText("Show favorites");
      }
    };
    updateFavToggle();
    favToggle.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showFavoritesOnlyChats = !this.showFavoritesOnlyChats;
      updateFavToggle();
      await this.filterAndDisplayChats();
    });
    favToggle.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.showFavoritesOnlyChats = !this.showFavoritesOnlyChats;
        updateFavToggle();
        await this.filterAndDisplayChats();
      }
    });
    
    // Add search functionality
    this.searchInput.onChange(async (value) => {
      // Reset keyboard selection when search changes
      this.keyboardSelectedIndex = -1;
      await this.filterAndDisplayChats();
    });
    
    // Add keyboard navigation from search box
    this.searchInput.inputEl.addEventListener("keydown", (e) => {
      this.handleSearchKeydown(e);
    });
  }

  private async loadAndDisplayChats(): Promise<void> {
    this.emptyStateEl.setText("Loading chats...");
    this.emptyStateEl.style.display = "block";
    this.chatListContainer.empty(); // Clear previous list items if any
    this.chatListContainer.appendChild(this.emptyStateEl);

    try {
      const allSummaries = await this.chatStorage.loadChats(); // Assuming loadChats returns summaries

      // Transform summaries into the simpler ChatListItem structure, but keep messages for searching
      this.allChats = allSummaries.map(summary => ({
        id: summary.id,
        title: summary.title || `Chat from ${this.formatRelativeDate(summary.lastModified)}`,
        lastModified: summary.lastModified,
        selectedModelId: summary.selectedModelId || this.plugin.settings.selectedModelId,
        messages: summary.messages || [], // Keep messages for content search
        isFavorite: this.chatFavoritesService.isFavorite(summary.id)
      }));

      const favoritesFirst = this.favoritesService.getFavoritesFirst();
      this.allChats.sort((a, b) => {
        if (favoritesFirst) {
          if (a.isFavorite && !b.isFavorite) return -1;
          if (!a.isFavorite && b.isFavorite) return 1;
        }
        return b.lastModified - a.lastModified;
      });

    } catch (error) {
      this.emptyStateEl.setText("Failed to load chats.");
      this.allChats = []; // Ensure list is empty on error
    }

    // Initial display (will show all chats or empty state)
    this.filterAndDisplayChats();
  }

  private async filterAndDisplayChats(): Promise<void> {
    const searchTerm = this.searchInput.getValue().trim();

    let baseList = this.showFavoritesOnlyChats
      ? this.allChats.filter(c => c.isFavorite)
      : [...this.allChats];

    if (!searchTerm) {
      this.filteredChats = baseList;
      this.displayChats();
      return;
    }
    
    // Split search into terms for better matching
    const searchTerms = searchTerm.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    
    if (searchTerms.length === 0) {
      this.filteredChats = [...this.allChats];
      this.displayChats();
      return;
    }
    
    // Search in title and message content
    this.filteredChats = baseList.filter(chat => {
      // Check title
      if (chat.title && searchTerms.some(term => chat.title.toLowerCase().includes(term))) {
        return true;
      }
      
      // Check message content
      if (chat.messages && chat.messages.length > 0) {
        // Check if any message contains all search terms
        return chat.messages.some(msg => {
          if (typeof msg.content !== 'string') return false;
          const content = msg.content.toLowerCase();
          return searchTerms.some(term => content.includes(term));
        });
      }
      
      return false;
    });
    
    const favoritesFirst = this.favoritesService.getFavoritesFirst();
    this.filteredChats.sort((a, b) => {
      if (favoritesFirst) {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
      }
      return b.lastModified - a.lastModified;
    });

    this.displayChats(searchTerms);
  }

  private displayChats(searchTerms: string[] = []): void {
    this.chatListContainer.empty(); // Clear previous list
    this.chatItemElements = []; // Reset item elements
    this.keyboardSelectedIndex = -1; // Reset keyboard selection

    if (this.filteredChats.length === 0) {
      const searchTerm = this.searchInput.getValue().trim();
      this.emptyStateEl.setText(searchTerm ? "No chats match your search." : "No chats found.");
      this.emptyStateEl.style.display = "block";
      this.chatListContainer.appendChild(this.emptyStateEl);
      return;
    }

    this.emptyStateEl.style.display = "none"; // Hide empty state

    // If we have search terms, display a header
    if (searchTerms.length > 0) {
      const headerEl = this.chatListContainer.createEl("h3", {
        text: `Search Results (${this.filteredChats.length})`,
        cls: "systemsculpt-section-header"
      });
    }

    // Render each chat item
    this.filteredChats.forEach(chat => {
      const chatItemEl = this.chatListContainer.createDiv("systemsculpt-modal-list-item");
      chatItemEl.dataset.chatId = chat.id;
      chatItemEl.dataset.favorite = chat.isFavorite ? "true" : "false";
      
      // Add favorite star toggle
      const favContainer = chatItemEl.createDiv("systemsculpt-chat-favorite");
      new ChatFavoriteToggle(favContainer, chat.id, this.chatFavoritesService, async (chatId, isFavorite) => {
        chat.isFavorite = isFavorite;
        chatItemEl.dataset.favorite = isFavorite ? "true" : "false";
        // Only re-sort if we need to reorder based on favorites
        if (this.favoritesService.getFavoritesFirst()) {
          await this.filterAndDisplayChats();
        }
      });
      
      // Create content container for better layout control
      const contentEl = chatItemEl.createDiv("systemsculpt-modal-list-item-content");
      
      // Track the element for keyboard navigation
      this.chatItemElements.push(chatItemEl);

      // --- Chat Content ---
      // Title (with highlighting if search terms exist)
      const titleEl = contentEl.createDiv("systemsculpt-modal-list-item-title");
      
      if (searchTerms.length > 0) {
        const { html: highlightedTitle } = this.highlightText(chat.title, searchTerms);
        titleEl.appendChild(highlightedTitle);
      } else {
        titleEl.textContent = chat.title;
      }

      // Preview content - either show matching content or last messages
      const previewEl = contentEl.createDiv("systemsculpt-modal-list-item-preview");
      
      if (searchTerms.length > 0) {
        // Try to find a match in message content
        let foundMatchContext = false;
        
        // Get all message content as one string
        const allContent = chat.messages
          .map(m => typeof m.content === 'string' ? m.content : '')
          .join(' ');
        
        // Get context around matches
        if (allContent) {
          const matchContext = this.getMatchContext(allContent, searchTerms);
          
          // If we found matches, show the context with highlighting
          if (matchContext !== allContent) {
            foundMatchContext = true;
            const { html } = this.highlightText(matchContext, searchTerms);
            previewEl.appendChild(html);
          }
        }
        
        // If no matches found in content, show last message
        if (!foundMatchContext) {
          this.renderLastMessages(previewEl, chat);
        }
      } else {
        // No search, just show last messages
        this.renderLastMessages(previewEl, chat);
      }

      // Metadata
      const metadataEl = contentEl.createDiv("systemsculpt-modal-list-item-meta");
      
      // Date
      const dateEl = metadataEl.createDiv("systemsculpt-modal-list-item-date");
      dateEl.textContent = this.formatRelativeDate(chat.lastModified);
      
      // Message count
      const countEl = metadataEl.createDiv("systemsculpt-modal-list-item-count");
      countEl.textContent = `${chat.messages.length} messages`;

      // --- Event Listeners ---
      // Click to open chat
      chatItemEl.addEventListener("click", () => {
        this.openChat(chat.id, chat.selectedModelId);
      });
    });
  }

  private renderLastMessages(container: HTMLElement, chat: ChatListItem): void {
    // Find the last user message and assistant response
    if (!chat.messages || chat.messages.length === 0) {
      container.textContent = "Empty chat";
      return;
    }
    
    const lastMessages = this.getRecentMessages(chat);
    
    lastMessages.forEach(msg => {
      const msgEl = document.createElement("div");
      msgEl.className = "systemsculpt-modal-message";
      
      // Show a truncated version of the message
      let content = typeof msg.content === "string" 
        ? msg.content 
        : "Complex message with images or attachments";
      
      // Truncate content if too long
      if (content.length > 200) {
        content = content.substring(0, 200) + "...";
      }
      
      msgEl.textContent = content;
      container.appendChild(msgEl);
    });
  }

  private getRecentMessages(chat: ChatListItem): ChatMessage[] {
    const messages = chat.messages;
    if (!messages || messages.length === 0) return [];
    
    // If there's only one message, return it
    if (messages.length === 1) return [messages[0]];
    
    // Find the last user message and the following assistant message (if any)
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    
    if (lastUserIndex === -1) {
      // No user messages found, just return the last message
      return [messages[messages.length - 1]];
    }
    
    // Get the user message and the assistant response (if available)
    const userMessage = messages[lastUserIndex];
    const assistantMessage = lastUserIndex + 1 < messages.length ? messages[lastUserIndex + 1] : null;
    
    return assistantMessage ? [userMessage, assistantMessage] : [userMessage];
  }

  private formatRelativeDate(timestamp: number): string {
    const now = Date.now();
    const diffSeconds = Math.round((now - timestamp) / 1000);
    const diffMinutes = Math.round(diffSeconds / 60);
    const diffHours = Math.round(diffMinutes / 60);
    const diffDays = Math.round(diffHours / 24);
    const diffWeeks = Math.round(diffDays / 7);
    
    if (diffSeconds < 60) return `${diffSeconds}s ago`;
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks < 5) return `${diffWeeks}w ago`;
    
    // For older dates, show the actual date
    const date = new Date(timestamp);
    return date.toLocaleDateString();
  }

  private async getModelName(modelId: string): Promise<string> {
    // Check cache first
    if (this.modelNameCache.has(modelId)) {
      return this.modelNameCache.get(modelId) || "Unknown Model";
    }
    
    try {
      // Load model information
      const models = await this.plugin.modelService.getModels();
      const model = models.find(m => m.id === modelId);
      
      const name = model ? model.name : "Unknown Model";
      
      // Cache the result
      this.modelNameCache.set(modelId, name);
      
      return name;
    } catch (error) {
      return "Unknown Model";
    }
  }

  private highlightText(text: string, searchTerms: string[]): { html: HTMLElement, hasMatches: boolean } {
    const container = document.createElement('div');
    
    if (!searchTerms || searchTerms.length === 0 || !text) {
      container.textContent = text || "";
      return { html: container, hasMatches: false };
    }
    
    const lowerText = text.toLowerCase();
    let lastIndex = 0;
    let hasMatches = false;
    
    // Find all instances of search terms and wrap them in highlight spans
    const allMatches: {term: string, index: number}[] = [];
    
    // Collect all matches with their positions
    searchTerms.forEach(term => {
      if (!term) return;
      
      let index = 0;
      while ((index = lowerText.indexOf(term, index)) > -1) {
        allMatches.push({ term, index });
        index += term.length;
      }
    });
    
    // No matches found, return plain text
    if (allMatches.length === 0) {
      container.textContent = text;
      return { html: container, hasMatches: false };
    }
    
    // Sort matches by index
    allMatches.sort((a, b) => a.index - b.index);
    
    // Process matches
    allMatches.forEach(match => {
      const { term, index } = match;
      
      // Skip if this match overlaps with a previous one
      if (index < lastIndex) return;
      
      // Add text before match
      if (index > lastIndex) {
        container.appendChild(document.createTextNode(
          text.substring(lastIndex, index)
        ));
      }
      
      // Add highlighted match
      const highlight = document.createElement('span');
      highlight.className = 'systemsculpt-search-highlight';
      highlight.textContent = text.substr(index, term.length);
      container.appendChild(highlight);
      
      lastIndex = index + term.length;
      hasMatches = true;
    });
    
    // Add remaining text after last match
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(
        text.substring(lastIndex)
      ));
    }
    
    return { html: container, hasMatches };
  }

  private getMatchContext(text: string, searchTerms: string[]): string {
    if (!searchTerms || searchTerms.length === 0 || !text) {
      return text;
    }
    
    const lowerText = text.toLowerCase();
    
    // Find all matches
    const matches: {term: string, index: number}[] = [];
    searchTerms.forEach(term => {
      if (!term) return;
      
      let index = 0;
      while ((index = lowerText.indexOf(term, index)) > -1) {
        matches.push({ term, index });
        index += term.length;
      }
    });
    
    if (matches.length === 0) return text;
    
    // Sort matches by position
    matches.sort((a, b) => a.index - b.index);
    
    // Find best cluster of matches within CONTEXT_SIZE
    const CONTEXT_SIZE = 75;
    let bestStart = matches[0].index;
    let bestEnd = matches[0].index + matches[0].term.length;
    
    // Find smallest window containing most matches
    for (let i = 0; i < matches.length; i++) {
      let windowStart = matches[i].index;
      let windowEnd = matches[i].index + matches[i].term.length;
      let matchCount = 1;
      
      for (let j = i + 1; j < matches.length; j++) {
        // If next match is too far, break
        if (matches[j].index - windowEnd > CONTEXT_SIZE) break;
        
        // Extend window
        windowEnd = matches[j].index + matches[j].term.length;
        matchCount++;
      }
      
      // If this window has more than 1 match and is smaller than current best
      if (matchCount > 1 && (windowEnd - windowStart) < (bestEnd - bestStart)) {
        bestStart = windowStart;
        bestEnd = windowEnd;
      }
    }
    
    // Calculate context window with padding
    const contextStart = Math.max(0, bestStart - CONTEXT_SIZE);
    const contextEnd = Math.min(text.length, bestEnd + CONTEXT_SIZE);
    
    // Find clean word boundaries
    let previewStart = contextStart;
    while (previewStart > 0 && !/[\s.!?\n]/.test(text[previewStart - 1])) {
      previewStart--;
    }
    
    let previewEnd = contextEnd;
    while (previewEnd < text.length && !/[\s.!?\n]/.test(text[previewEnd])) {
      previewEnd++;
    }
    
    let preview = text.slice(previewStart, previewEnd).trim();
    
    // Add ellipsis if needed
    if (previewStart > 0) preview = "..." + preview;
    if (previewEnd < text.length) preview = preview + "...";
    
    return preview;
  }

  private async openChat(chatId: string, selectedModelId: string): Promise<void> {
    // Prevent multiple opens
    if (this.isOpening) {
      return;
    }
    this.isOpening = true;
    
    this.close(); // Close the modal first

    try {
      // Load the full chat data to get all metadata
      const fullChatData = await this.chatStorage.loadChat(chatId);
      
      const { workspace } = this.app;
      const leaf = workspace.getLeaf("tab");

      // Set view state with complete chat metadata
      const state: any = {
        chatId: chatId,
        selectedModelId: selectedModelId
      };
      
      // Include all metadata if available
      if (fullChatData) {
        state.systemPromptType = fullChatData.systemPromptType;
        state.systemPromptPath = fullChatData.systemPromptPath;
        state.chatFontSize = fullChatData.chatFontSize;
        state.chatTitle = fullChatData.title;
        state.version = fullChatData.version;
      }

      // Set view state with full metadata
      leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        state: state
      }).then(() => {
        workspace.setActiveLeaf(leaf, { focus: true });
      });
    } catch (e) {
      new Notice("Error opening chat. Please try again.");
      
      // Fallback to opening the chat file directly
      this.openChatFile(chatId);
    }
  }

  private openNewChat(): void {
    // Prevent multiple opens
    if (this.isOpening) {
      return;
    }
    this.isOpening = true;
    
    this.close(); // Close the modal first

    try {
      const { workspace } = this.app;
      const leaf = workspace.getLeaf("tab");

      // Set empty view state for a new chat
      leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        state: {
          chatId: "", // Empty ID for new chat
          selectedModelId: this.plugin.settings.selectedModelId, // Default model
        }
      }).then(() => {
        workspace.setActiveLeaf(leaf, { focus: true });
      });
    } catch (e) {
      new Notice("Unable to open new chat.");
    }
  }

  private async openChatFile(chatId: string) {
    // Also guard this method
    if (this.isOpening) {
      return;
    }
    
    try {
      // Generate file path
      const filePath = `${this.plugin.settings.chatsDirectory || "SystemSculpt/Chats"}/${chatId}.json`;
      
      // Get the file
      const file = this.app.vault.getAbstractFileByPath(filePath);
      
      if (file instanceof TFile) {
        // Open the file in a new tab
        await this.app.workspace.getLeaf(true).openFile(file);
        this.close();
      } else {
        throw new Error("Chat file not found");
      }
    } catch (error) {
      showPopup(this.app, "", {
        title: "Error",
        description: "Failed to open chat file",
        primaryButton: "OK"
      });
    }
  }

  onClose() {
    // Reset the opening guard
    this.isOpening = false;
  }

  private handleModalKeydown(e: KeyboardEvent) {
    // Don't handle keys if we're typing in the search
    if (document.activeElement === this.searchInput.inputEl && 
        e.key !== "Escape" && 
        e.key !== "Tab") {
      return;
    }

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        this.selectPreviousItem();
        break;
      case "ArrowDown":
        e.preventDefault();
        this.selectNextItem();
        break;
      case "Enter":
        e.preventDefault();
        if (this.keyboardSelectedIndex >= 0 && this.keyboardSelectedIndex < this.filteredChats.length) {
          const chat = this.filteredChats[this.keyboardSelectedIndex];
          this.openChat(chat.id, chat.selectedModelId);
        }
        break;
      case "Escape":
        e.preventDefault();
        this.close();
        break;
      case "Tab":
        // Prevent default tab behavior and implement our own
        e.preventDefault();
        if (e.shiftKey) {
          this.selectPreviousItem();
        } else {
          this.selectNextItem();
        }
        break;
    }
  }

  private selectNextItem() {
    if (this.chatItemElements.length === 0) return;
    
    // If nothing is selected, start at the beginning
    if (this.keyboardSelectedIndex < 0) {
      this.keyboardSelectedIndex = 0;
    } else {
      // Move to the next item, or wrap to the start
      this.keyboardSelectedIndex = (this.keyboardSelectedIndex + 1) % this.chatItemElements.length;
    }
    
    this.updateSelectedItemFromKeyboard();
  }

  private selectPreviousItem() {
    if (this.chatItemElements.length === 0) return;
    
    // If nothing is selected, start at the end
    if (this.keyboardSelectedIndex < 0) {
      this.keyboardSelectedIndex = this.chatItemElements.length - 1;
    } else {
      // Move to the previous item, or wrap to the end
      this.keyboardSelectedIndex = (this.keyboardSelectedIndex - 1 + this.chatItemElements.length) % this.chatItemElements.length;
    }
    
    this.updateSelectedItemFromKeyboard();
  }

  private updateSelectedItemFromKeyboard() {
    if (this.keyboardSelectedIndex < 0 || this.keyboardSelectedIndex >= this.chatItemElements.length) {
      return;
    }
    
    // Remove selection from all items
    this.chatItemElements.forEach(el => {
      el.classList.remove("is-selected");
    });
    
    // Select the current item
    const selectedEl = this.chatItemElements[this.keyboardSelectedIndex];
    selectedEl.classList.add("is-selected");
    
    // Scroll the item into view if needed
    selectedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private handleSearchKeydown(e: KeyboardEvent) {
    // Handle special keys in the search input
    switch (e.key) {
      case "ArrowDown":
        // Move to the first result if nothing is selected
        e.preventDefault();
        this.selectNextItem();
        break;
      case "Enter":
        // If something is selected, open it
        if (this.keyboardSelectedIndex >= 0 && this.keyboardSelectedIndex < this.filteredChats.length) {
          e.preventDefault();
          e.stopPropagation(); // Prevent the event from bubbling up to handleModalKeydown
          const chat = this.filteredChats[this.keyboardSelectedIndex];
          this.openChat(chat.id, chat.selectedModelId);
        }
        break;
    }
  }
}
