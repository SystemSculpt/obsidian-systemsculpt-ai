import { ItemView, WorkspaceLeaf, TFile, setIcon, Notice, Component } from 'obsidian';
import SystemSculptPlugin from '../main';
import { SearchResult } from '../services/embeddings/types';
import { ChatView, CHAT_VIEW_TYPE } from './chatview/ChatView';
import { ChatMessage } from '../types';
import { EmbeddingsPendingFilesModal } from '../modals/EmbeddingsPendingFilesModal';

export const EMBEDDINGS_VIEW_TYPE = 'systemsculpt-embeddings-view';

export class EmbeddingsView extends ItemView {
  private plugin: SystemSculptPlugin;
  private resultsEl: HTMLElement;
  private statusEl: HTMLElement;
  private headerEl: HTMLElement;
  private titleEl: HTMLElement;
  private fileNameEl: HTMLElement;
  private currentFile: TFile | null = null;
  private currentChatView: ChatView | null = null;
  private currentResults: SearchResult[] = [];
  private isLoading = false;
  private lastSearchContent = '';
  private lastFileHash = '';
  private forceRefreshNextCheck = false;
  private lastEmbeddingsConfigKey = '';
  private fileExists = false;
  private isDragging = false; // Track drag state to prevent clearing results
  private dragTimeout: number | null = null; // Safety timeout for drag operations
  private contextChangeHandler: () => void;
  private pendingSearch: { type: 'file'; file: TFile } | { type: 'chat'; chatView: ChatView } | null = null;
  
  // Debouncing for active leaf changes
  private searchTimeout: number | null = null;
  private readonly SEARCH_DELAY = 300; // 300ms delay
  
  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
  
  getViewType(): string {
    return EMBEDDINGS_VIEW_TYPE;
  }
  
  getDisplayText(): string {
    return 'Similar Notes';
  }
  
  getIcon(): string {
    return 'network';
  }
  
  async onOpen(): Promise<void> {
    this.contentEl = this.containerEl.children[1] as HTMLElement;
    this.contentEl.empty();
    this.contentEl.addClass('systemsculpt-embeddings-view');
    
    this.setupUI();
    this.registerEvents();
    this.lastEmbeddingsConfigKey = this.getEmbeddingsConfigKey(this.plugin.settings as any);
    
    // Show empty state initially - no automatic searches
    this.showEmptyState();

    // Immediately evaluate the current active file/chat to populate results on open
    // so users don't need to refocus the editor to see similar notes.
    this.debouncedCheckActiveFile();
  }
  
  private setupUI(): void {
    // Create compact header
    this.headerEl = this.contentEl.createDiv({ cls: 'embeddings-view-header' });
    
    this.titleEl = this.headerEl.createDiv({ cls: 'embeddings-view-title' });
    
    // Title row with icon and text
    const titleRowEl = this.titleEl.createDiv({ cls: 'embeddings-view-title-row' });
    const iconEl = titleRowEl.createDiv({ cls: 'embeddings-view-icon' });
    setIcon(iconEl, 'network');
    titleRowEl.createSpan({ text: 'Similar Notes' });
    
    // File name element (initially hidden)
    this.fileNameEl = this.titleEl.createDiv({ cls: 'embeddings-view-file-name' });
    this.fileNameEl.style.display = 'none';
    
    // Create hidden status element (kept for compatibility but hidden)
    this.statusEl = this.contentEl.createDiv({ cls: 'embeddings-view-status', attr: { style: 'display: none;' } });
    
    // Create results container
    this.resultsEl = this.contentEl.createDiv({ cls: 'embeddings-view-results' });
    
    // Show initial state
    this.showEmptyState();
  }
  
  private registerEvents(): void {
    // Listen for active leaf changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        // Mark for freeze diagnostics
        try { (window as any).FreezeMonitor?.mark?.('embeddings:active-leaf-change'); } catch {}
        if (leaf?.view?.getViewType?.() === EMBEDDINGS_VIEW_TYPE) {
          this.forceRefreshNextCheck = true;
        }
        this.debouncedCheckActiveFile();
        // If the user brought this view to front, run any pending search now
        this.flushPendingSearchIfVisible();
      })
    );
    
    // Also listen for direct file-open events which can fire without a leaf switch
    this.registerEvent(
      // @ts-ignore - 'file-open' exists on workspace event bus
      this.app.workspace.on('file-open', () => {
        this.forceRefreshNextCheck = true;
        this.debouncedCheckActiveFile();
      })
    );

    // Refresh results when embeddings settings change (provider/model/exclusions, etc)
    this.registerEvent(
      this.app.workspace.on("systemsculpt:settings-updated", (_oldSettings, newSettings: any) => {
        const nextKey = this.getEmbeddingsConfigKey(newSettings);
        if (nextKey === this.lastEmbeddingsConfigKey) {
          return;
        }
        this.lastEmbeddingsConfigKey = nextKey;
        this.forceRefreshNextCheck = true;
        this.debouncedCheckActiveFile();
        this.flushPendingSearchIfVisible();
      })
    );
    
    // Listen for layout changes so we can run any pending searches when the view becomes visible
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.flushPendingSearchIfVisible();
      })
    );
    
    // Listen for file modifications
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file === this.currentFile) {
          try { (window as any).FreezeMonitor?.mark?.('embeddings:file-modify'); } catch {}
          this.debouncedSearchCurrentFile();
        }
      })
    );

    // Refresh Similar Notes when files are renamed/deleted (links + embeddings paths can change)
    this.registerEvent(
      this.app.vault.on("rename", (_file) => {
        if (this.isDragging) return;
        this.forceRefreshNextCheck = true;
        this.debouncedCheckActiveFile();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.isDragging) return;
        const deletedPath = typeof (file as any)?.path === "string" ? (file as any).path : "";
        if (deletedPath && this.currentResults.some((r) => r.path === deletedPath)) {
          const filtered = this.currentResults.filter((r) => r.path !== deletedPath);
          this.currentResults = filtered;

          if (this.currentFile) {
            void this.updateResults(filtered, this.currentFile).catch(() => {});
          } else if (this.currentChatView) {
            void this.updateResults(filtered, null, this.currentChatView.getChatTitle() || "Chat").catch(() => {});
          }
        }
        this.forceRefreshNextCheck = true;
        this.debouncedCheckActiveFile();
      })
    );
    
    // Listen for chat updates
    this.registerEvent(
      (this.app.workspace as any).on('systemsculpt:chat-loaded', (chatId: string) => {
        // When a chat is loaded or updated, refresh if it's the current chat
        if (this.currentChatView && this.currentChatView.chatId === chatId) {
          this.debouncedSearchCurrentChat();
        }
      })
    );
    
    // Listen for chat message updates
    this.registerEvent(
      (this.app.workspace as any).on('systemsculpt:chat-message-added', (chatId: string) => {
        // When a message is added to chat, refresh if it's the current chat
        if (this.currentChatView && this.currentChatView.chatId === chatId) {
          this.debouncedSearchCurrentChat();
        }
      })
    );
    
    // Listen for context changes to update visual indicators
    this.contextChangeHandler = () => {
      if (this.currentChatView && this.currentResults.length > 0) {
        this.updateContextIndicators();
      }
    };
    document.addEventListener('systemsculpt:context-changed', this.contextChangeHandler);
  }
  
  private debouncedCheckActiveFile(): void {
    if (this.searchTimeout) {
      window.clearTimeout(this.searchTimeout);
    }
    
    this.searchTimeout = window.setTimeout(() => {
      this.checkActiveFile();
    }, this.SEARCH_DELAY);
  }
  
  private debouncedSearchCurrentFile(): void {
    if (this.searchTimeout) {
      window.clearTimeout(this.searchTimeout);
    }
    
    this.searchTimeout = window.setTimeout(() => {
      if (this.currentFile) {
        this.searchForSimilar(this.currentFile);
      }
    }, this.SEARCH_DELAY * 2); // Longer delay for file modifications
  }

  private debouncedSearchCurrentChat(): void {
    if (this.searchTimeout) {
      window.clearTimeout(this.searchTimeout);
    }
    
    this.searchTimeout = window.setTimeout(() => {
      if (this.currentChatView) {
        this.searchForSimilarFromChat(this.currentChatView);
      }
    }, this.SEARCH_DELAY * 2); // Longer delay for chat modifications
  }
  
  private startRefreshAnimation(): void {
    this.titleEl.addClass('refreshing');
  }
  
  private stopRefreshAnimation(): void {
    this.titleEl.removeClass('refreshing');
  }
  
  private updateFileName(fileName: string): void {
    this.fileNameEl.textContent = fileName;
    this.fileNameEl.style.display = 'block';
  }
  
  private hideFileName(): void {
    this.fileNameEl.style.display = 'none';
  }

  private isViewVisible(): boolean {
    // Consider the view visible if its leaf exists, is connected, not hidden,
    // and has non-zero dimensions. This catches cases where the tab exists but
    // is not the front tab in the ribbon.
    const leafEl = this.containerEl?.closest?.('.workspace-leaf') as HTMLElement | null;
    if (!leafEl) return false;
    const isHidden = leafEl.classList.contains('is-hidden');
    const isConnected = leafEl.isConnected;
    const rect = leafEl.getBoundingClientRect?.();
    const hasSize = !!rect && rect.width > 0 && rect.height > 0;
    return isConnected && !isHidden && hasSize;
  }
  
  private checkActiveFile(): void {
    // Don't update view during drag operations to prevent clearing results
    if (this.isDragging) {
      return;
    }
    
    // Check if embeddings are enabled - if not, show disabled state
    if (!this.plugin.settings.embeddingsEnabled) {
      this.showDisabledState();
      return;
    }
    
    let activeChatView = this.app.workspace.getActiveViewOfType(ChatView);
    // `workspace.getActiveFile()` can be null while focus is on non-file views (including this Similar Notes view).
    // Prefer the actual active ChatView when present; otherwise fall back to the workspace active file.
    let activeFile = activeChatView ? null : this.app.workspace.getActiveFile();

    // If this Similar Notes view is the active leaf, keep the current context even when
    // Obsidian reports no active file/chat (prevents stale results on deletes/renames).
    const activeLeaf = this.app.workspace.activeLeaf;
    const isEmbeddingsViewActive = activeLeaf?.view?.getViewType?.() === EMBEDDINGS_VIEW_TYPE;
    if (isEmbeddingsViewActive) {
      if (!activeChatView && this.currentChatView) {
        activeChatView = this.currentChatView;
      }
      if (!activeFile && !activeChatView && this.currentFile) {
        activeFile = this.currentFile;
      }
    }
    
    // Check if we have a new file/chat or if we're re-focusing on a chat
    const hasNewFile = !!activeFile && activeFile !== this.currentFile;
    const hasNewChat = !!activeChatView && activeChatView !== this.currentChatView;
    const isRefocusingOnChat = !!activeChatView && activeChatView === this.currentChatView && !activeFile;
    const switchingFromNonContentView = !this.currentFile && !this.currentChatView && (!!activeFile || !!activeChatView);
    const forceRefresh = this.forceRefreshNextCheck;
    this.forceRefreshNextCheck = false;
    
    if (hasNewFile) {
      if (!activeFile) return;
      // Switch to a different file
      // Only log if it's actually a different file or first time
      if (this.currentFile?.path !== activeFile.path) {
      }
      this.currentFile = activeFile;
      this.currentChatView = null; // Clear chat since we're now on a file
      this.updateFileName(activeFile.basename);
      // Defer search slightly to allow editor to finish focusing and avoid jank
      setTimeout(() => this.searchForSimilar(activeFile), 50);
    } else if (hasNewChat) {
      if (!activeChatView) return;
      // Switch to a different chat
      const chatTitle = activeChatView.getChatTitle();
      // Only log if it's actually a different chat or first time
      if (this.currentChatView?.chatId !== activeChatView.chatId) {
      }
      this.currentChatView = activeChatView;
      this.currentFile = null; // Clear file since we're now on a chat
      this.updateFileName(chatTitle || 'Chat');
      setTimeout(() => this.searchForSimilarFromChat(activeChatView), 50);
    } else if (isRefocusingOnChat) {
      if (!activeChatView) return;
      // Re-focusing on the same chat - check if content changed
      // No logging for re-focus, only for content changes
      const chatContent = this.extractChatContent(activeChatView);
      const contentHash = this.hashContent(chatContent);
      if (forceRefresh || contentHash !== this.lastFileHash) {
        // Content changed, refresh the results
        setTimeout(() => this.searchForSimilarFromChat(activeChatView), 50);
      }
    } else if (switchingFromNonContentView) {
      // Switching from settings/file explorer back to content
      if (activeFile) {
        // No need to log returning to same file
        this.currentFile = activeFile;
        this.currentChatView = null;
        this.updateFileName(activeFile.basename);
        setTimeout(() => this.searchForSimilar(activeFile), 50);
      } else if (activeChatView) {
        // No need to log returning to same chat
        this.currentChatView = activeChatView;
        this.currentFile = null;
        this.updateFileName(activeChatView.getChatTitle() || 'Chat');
        setTimeout(() => this.searchForSimilarFromChat(activeChatView), 50);
      }
    } else if (forceRefresh) {
      // Force refresh current context (e.g. embeddings model/provider switch, vault rename/delete, refocus)
      if (activeFile) {
        this.currentFile = activeFile;
        this.currentChatView = null;
        this.updateFileName(activeFile.basename);
        setTimeout(() => this.searchForSimilar(activeFile), 50);
      } else if (activeChatView) {
        this.currentChatView = activeChatView;
        this.currentFile = null;
        this.updateFileName(activeChatView.getChatTitle() || 'Chat');
        setTimeout(() => this.searchForSimilarFromChat(activeChatView), 50);
      }
    }
    // If none of the above, preserve current state
  }

  private getEmbeddingsConfigKey(settings: any): string {
    const provider = String(settings?.embeddingsProvider || "");
    const endpoint = String(settings?.embeddingsCustomEndpoint || "");
    const model = String(settings?.embeddingsCustomModel || "");
    const enabled = settings?.embeddingsEnabled ? "1" : "0";
    const exclusions = settings?.embeddingsExclusions ?? {};
    return JSON.stringify({
      enabled,
      provider,
      endpoint,
      model,
      exclusions,
    });
  }
  
  private async searchForSimilar(file: TFile): Promise<void> {
    try {
      // If view isn't visible, schedule a pending search instead of doing work now
      if (!this.isViewVisible()) {
        this.pendingSearch = { type: 'file', file };
        return;
      }

      const manager = this.plugin.getOrCreateEmbeddingsManager();
      // Ensure embeddings storage is ready before querying stats/vectors
      await manager.awaitReady();
      
      const hasAnyStoredVectors = manager.hasAnyStoredVectors();

      // Check if the index is empty (any namespace)
      if (!hasAnyStoredVectors) {
        this.showProcessingPrompt();
        return;
      }

      const stats = manager.getStats();
      const hasAnyEmbeddings = manager.hasAnyEmbeddings();

      // Check if file exists in embeddings and if content changed
      // Avoid reading entire file contents on focus; use mtime+size fingerprint instead
      const fingerprint = `${file.stat.mtime}-${file.stat.size}`;
      const fileInEmbeddings = manager.hasVector(file.path);
      
      // Smart loading: only show "analyzing" if file needs processing
      if (!fileInEmbeddings || fingerprint !== this.lastFileHash) {
        this.showSmartLoading(file.basename, !fileInEmbeddings);
        this.lastFileHash = fingerprint;
        this.fileExists = fileInEmbeddings;
      } else {
        // File exists and hasn't changed, show minimal loading
        this.showQuickLoading(file.basename);
      }
      
      // Mark that we're searching for this file
      this.lastSearchContent = file.path;
      
      // If there is no existing vector for this file, but the vault has embeddings,
      // fall back to searching using the file's content instead of prompting to process
      if (!manager.hasVector(file.path)) {
        if (hasAnyEmbeddings) {
          const content = await this.app.vault.read(file);
          if (!content.trim()) {
            this.showEmptyContent();
            return;
          }
          this.showQuickLoading(file.basename);
          const results = await manager.searchSimilar(content, 15);
          if (this.isViewVisible() && this.lastSearchContent === file.path) {
            await this.updateResults(results, file);
          }
          return;
        } else {
          this.showProcessingState(
            "Embeddings not ready for this model",
            "Your vault has embeddings, but not for the current embeddings provider/model. Run embeddings processing to refresh.",
          );
          return;
        }
      }
      
      // Search for similar notes using non-blocking vector search under the hood
      const results = await manager.findSimilar(file.path, 15);
      
      // Check if view is still visible and we're still searching for the same file
      if (this.isViewVisible() && this.lastSearchContent === file.path) {
        await this.updateResults(results, file);
      }
      
    } catch (error) {
      this.showError(`Failed to find similar notes: ${error.message}`);
    }
  }

  private async searchForSimilarFromChat(chatView: ChatView): Promise<void> {
    try {
      // If view isn't visible, schedule a pending search instead of doing work now
      if (!this.isViewVisible()) {
        this.pendingSearch = { type: 'chat', chatView };
        return;
      }

      const manager = this.plugin.getOrCreateEmbeddingsManager();
      // Ensure embeddings storage is ready before querying
      await manager.awaitReady();
      
      const hasAnyStoredVectors = manager.hasAnyStoredVectors();

      // Check if the index is empty (any namespace)
      if (!hasAnyStoredVectors) {
        this.showProcessingPrompt();
        return;
      }

      const stats = manager.getStats();
      
      const hasAnyEmbeddings = manager.hasAnyEmbeddings();
      
      // Extract content from chat messages (first 3 + latest 2)
      const chatContent = this.extractChatContent(chatView);
      if (!chatContent.trim()) {
        this.showEmptyContent();
        return;
      }
      
      // Create a content hash for comparison
      const contentHash = this.hashContent(chatContent);
      
      // Show loading if content changed
      if (contentHash !== this.lastFileHash) {
        this.showSmartLoading(chatView.getChatTitle() || 'Chat', false);
        this.lastFileHash = contentHash;
      } else {
        this.showQuickLoading(chatView.getChatTitle() || 'Chat');
      }
      
      // Mark that we're searching for this chat content
      this.lastSearchContent = `chat:${chatView.chatId}`;
      
      // Search for similar notes using extracted content with non-blocking search underneath
      if (!hasAnyEmbeddings) {
        this.showProcessingState(
          "Embeddings not ready for this model",
          "Your vault has embeddings, but not for the current embeddings provider/model. Run embeddings processing to refresh.",
        );
        return;
      }
      const results = await manager.searchSimilar(chatContent, 15);
      
      // Check if view is still visible and we're still searching for the same chat
      const expectedSearchContent = `chat:${chatView.chatId}`;
      if (this.isViewVisible() && this.lastSearchContent === expectedSearchContent) {
        await this.updateResults(results, null, chatView.getChatTitle() || 'Chat');
      }
      
    } catch (error) {
      this.showError(`Failed to find similar notes: ${error.message}`);
    }
  }

  private extractChatContent(chatView: ChatView): string {
    const messages = chatView.getMessages();
    if (!messages || messages.length === 0) {
      return '';
    }
    
    // Extract first 3 messages and latest 2 messages
    const selectedMessages: ChatMessage[] = [];
    
    // Add first 3 messages
    for (let i = 0; i < Math.min(3, messages.length); i++) {
      selectedMessages.push(messages[i]);
    }
    
    // Add latest 2 messages (if we have more than 3 total)
    if (messages.length > 3) {
      const latestStart = Math.max(3, messages.length - 2);
      for (let i = latestStart; i < messages.length; i++) {
        // Avoid duplicates if there's overlap
        if (!selectedMessages.find(m => m.message_id === messages[i].message_id)) {
          selectedMessages.push(messages[i]);
        }
      }
    }
    
    // Extract text content from selected messages
    const extractedContent = selectedMessages
      .map(message => {
        if (typeof message.content === 'string') {
          return message.content;
        } else if (Array.isArray(message.content)) {
          // Handle multipart content
          return message.content
            .map((part: any) => {
              if (part.type === 'text') {
                return part.text;
              }
              return ''; // Skip non-text parts like images
            })
            .join(' ');
        }
        return '';
      })
      .filter(content => content.trim().length > 0)
      .join('\n\n');
    
    
    return extractedContent;
  }

  /**
   * Check if a note is already in the current chat's context
   */
  private isNoteInContext(notePath: string): boolean {
    if (!this.currentChatView || !this.currentChatView.contextManager) {
      return false;
    }
    
    const contextFiles = this.currentChatView.contextManager.getContextFiles();
    
    // Check both the direct path and wiki link format
    const wikiLink = `[[${notePath}]]`;
    const fileName = notePath.split('/').pop() || notePath;
    const fileNameWikiLink = `[[${fileName}]]`;
    
    return contextFiles.has(notePath) || 
           contextFiles.has(wikiLink) || 
           contextFiles.has(fileName) ||
           contextFiles.has(fileNameWikiLink);
  }

  /**
   * Update context indicators for all currently displayed results
   */
  private updateContextIndicators(): void {
    const resultElements = this.resultsEl.querySelectorAll('.similar-note-item');
    resultElements.forEach((el, index) => {
      if (index < this.currentResults.length) {
        const result = this.currentResults[index];
        const isInContext = this.isNoteInContext(result.path);
        el.classList.toggle('similar-note-in-context', isInContext);
      }
    });
  }
  
  /**
   * Smart loading - uses subtle header animation instead of loading screen
   */
  private showSmartLoading(fileName: string, needsProcessing: boolean): void {
    this.isLoading = true;
    this.startRefreshAnimation();
    // Don't clear results - keep them visible during update
  }
  
  /**
   * Quick loading - uses subtle header animation instead of loading screen
   */
  private showQuickLoading(fileName: string): void {
    this.isLoading = true;
    this.startRefreshAnimation();
    // Don't clear results - keep them visible during update
  }
  
  private showEmptyState(): void {
    this.isLoading = false;
    this.stopRefreshAnimation();
    this.hideFileName();
    this.statusEl.empty();
    this.resultsEl.empty();
    this.currentFile = null;
    this.currentChatView = null;
    this.lastSearchContent = '';
    
    const emptyEl = this.resultsEl.createDiv({ cls: 'embeddings-view-empty' });
    const iconEl = emptyEl.createDiv({ cls: 'empty-icon' });
    setIcon(iconEl, 'file-text');
    
    emptyEl.createDiv({ 
      text: 'Open a note or chat to see similar content',
      cls: 'empty-title' 
    });
    
    emptyEl.createDiv({
      text: 'Switch to any markdown note or chat view and this panel will show related notes from your vault.',
      cls: 'empty-description'
    });
  }
  
  private showEmptyContent(): void {
    this.isLoading = false;
    this.stopRefreshAnimation();
    this.statusEl.empty();
    this.resultsEl.empty();
    
    const emptyEl = this.resultsEl.createDiv({ cls: 'embeddings-view-empty' });
    const iconEl = emptyEl.createDiv({ cls: 'empty-icon' });
    setIcon(iconEl, 'file-x');
    
    emptyEl.createDiv({ 
      text: 'Note is empty',
      cls: 'empty-title' 
    });
    
    emptyEl.createDiv({ 
      text: 'Add some content to this note or chat to find similar notes.',
      cls: 'empty-description' 
    });
  }
  
  private showError(message: string): void {
    this.isLoading = false;
    this.stopRefreshAnimation();
    this.statusEl.empty();
    this.resultsEl.empty();
    
    const errorEl = this.resultsEl.createDiv({ cls: 'embeddings-view-error' });
    const iconEl = errorEl.createDiv({ cls: 'error-icon' });
    setIcon(iconEl, 'alert-circle');
    
    errorEl.createDiv({ 
      text: 'Error finding similar notes',
      cls: 'error-title' 
    });
    
    errorEl.createDiv({ 
      text: message,
      cls: 'error-message' 
    });
  }
  

  
  private showDisabledState(): void {
    this.isLoading = false;
    this.stopRefreshAnimation();
    this.hideFileName();
    this.statusEl.empty();
    this.resultsEl.empty();
    this.currentFile = null;
    this.currentChatView = null;
    this.lastSearchContent = '';
    
    const disabledEl = this.resultsEl.createDiv({ cls: 'embeddings-view-disabled' });
    const iconEl = disabledEl.createDiv({ cls: 'disabled-icon' });
    setIcon(iconEl, 'power');
    
    disabledEl.createDiv({ 
      text: 'Embeddings Disabled',
      cls: 'disabled-title' 
    });
    
    disabledEl.createDiv({ 
      text: 'Enable embeddings in Settings > SystemSculpt AI > Embeddings to find similar notes.',
      cls: 'disabled-description' 
    });
  }
  
  private async updateResults(results: SearchResult[], sourceFile: TFile | null, sourceName?: string): Promise<void> {
    this.isLoading = false;
    this.stopRefreshAnimation();
    this.currentResults = results;
    
    // Determine the source name for display
    const displayName = sourceName || sourceFile?.basename || 'Unknown';
    
    // Update status
    this.statusEl.empty();
    if (results.length > 0) {
      this.statusEl.createSpan({ 
        text: `${results.length} similar notes found for "${displayName}"`,
        cls: 'systemsculpt-status-text'
      });
    } else {
      this.statusEl.createSpan({ 
        text: `No similar notes found for "${displayName}"`,
        cls: 'systemsculpt-status-text muted'
      });
    }
    
    // Clear results
    this.resultsEl.empty();
    
    if (results.length === 0) {
      const noResultsEl = this.resultsEl.createDiv({ cls: 'embeddings-view-no-results' });
      const iconEl = noResultsEl.createDiv({ cls: 'no-results-icon' });
      setIcon(iconEl, 'search-x');
      
      noResultsEl.createDiv({ 
        text: 'No similar notes found',
        cls: 'no-results-title' 
      });
      
      noResultsEl.createDiv({ 
        text: 'This note doesn\'t have similar content in your vault yet.',
        cls: 'no-results-description' 
      });
      return;
    }
    
    // Render results
    const resultsContainer = this.resultsEl.createDiv({ cls: 'results-container' });
    
    for (const result of results) {
      await this.renderResult(resultsContainer, result);
    }
  }
  
  private async renderResult(container: HTMLElement, result: SearchResult): Promise<void> {
    const resultEl = container.createDiv({ cls: 'similar-note-item cursor-pointer' });
    
    // Check if this note is already in context (only for chat views)
    const isDraggableForChat = this.currentChatView !== null;
    if (isDraggableForChat) {
      const isInContext = this.isNoteInContext(result.path);
      if (isInContext) {
        resultEl.addClass('similar-note-in-context');
      }
    }
    
    // Make draggable if viewing results for a chat
    if (isDraggableForChat) {
      resultEl.setAttribute('draggable', 'true');
      resultEl.addClass('similar-note-draggable');
      
      // Set up drag handlers
      resultEl.addEventListener('dragstart', (e) => {
        if (!e.dataTransfer) return;
        
        // Set drag state to prevent clearing results during drag
        this.isDragging = true;
        
        // Set safety timeout to clear drag state (in case dragend doesn't fire)
        if (this.dragTimeout) {
          window.clearTimeout(this.dragTimeout);
        }
        this.dragTimeout = window.setTimeout(() => {
          this.isDragging = false;
          this.dragTimeout = null;
        }, 5000); // 5 second safety timeout
        
        // Set the file path as drag data with similar notes identifier
        e.dataTransfer.setData('text/plain', result.path);
        e.dataTransfer.setData('application/x-systemsculpt-similar-note', JSON.stringify({
          path: result.path,
          title: result.metadata.title || result.path.split('/').pop() || result.path,
          score: result.score,
          source: 'similar-notes'
        }));
        e.dataTransfer.effectAllowed = 'copy';
        
        // Add visual feedback
        resultEl.addClass('similar-note-dragging');
        
      });
      
      resultEl.addEventListener('dragend', (e) => {
        // Clear drag state
        this.isDragging = false;
        
        // Clear safety timeout
        if (this.dragTimeout) {
          window.clearTimeout(this.dragTimeout);
          this.dragTimeout = null;
        }
        
        // Remove visual feedback
        resultEl.removeClass('similar-note-dragging');
        
        // Small delay before checking active file to allow focus to settle
        setTimeout(() => {
          this.debouncedCheckActiveFile();
        }, 100);
      });
    }
    
    // Make entire card clickable
    resultEl.addEventListener('click', async (e) => {
      // Don't trigger if clicking on the title link (let it handle its own click)
      if ((e.target as HTMLElement).closest('.internal-link')) {
        return;
      }
      // Don't trigger click if this was part of a drag operation
      if (isDraggableForChat && e.defaultPrevented) {
        return;
      }
      e.preventDefault();
      await this.openFile(result.path);
    });
    
    // Score indicator with proper thresholds
    const scorePercent = Math.round(result.score * 100);
    const scoreClass = scorePercent >= 75 ? 'score-high' : 
                      scorePercent >= 50 ? 'score-medium' : 'score-low';
    const scoreEl = resultEl.createDiv({ cls: `note-score ${scoreClass}` });
    scoreEl.createSpan({ text: `${scorePercent}%` });
    
    // Note content
    const contentEl = resultEl.createDiv({ cls: 'note-content' });
    
    // Title with link (keep for accessibility and right-click context)
    const titleEl = contentEl.createDiv({ cls: 'note-title' });
    const linkEl = titleEl.createEl('a', {
      cls: 'internal-link',
      text: result.metadata.title || result.path.split('/').pop() || result.path,
      href: result.path
    });
    
    linkEl.addEventListener('click', async (e) => {
      e.preventDefault();
      await this.openFile(result.path);
    });
    
    // Excerpt or content preview
    const sectionTitle = result.metadata.sectionTitle;
    if (sectionTitle) {
      contentEl.createDiv({ cls: 'note-section-title', text: sectionTitle });
    }

    if (result.metadata.excerpt) {
      const excerptEl = contentEl.createDiv({ cls: 'note-excerpt' });
      excerptEl.textContent = result.metadata.excerpt;
    }
    
    // Metadata row
    const metaEl = contentEl.createDiv({ cls: 'note-metadata' });
    
    // Path info
    const pathParts = result.path.split('/');
    if (pathParts.length > 1) {
      const pathEl = metaEl.createSpan({ cls: 'note-path' });
      pathEl.textContent = pathParts.slice(0, -1).join('/');
    }
    
    // Tags not tracked in current implementation
    
    // Last modified
    if (result.metadata.lastModified) {
      const date = new Date(result.metadata.lastModified);
      metaEl.createSpan({ 
        cls: 'note-date',
        text: this.formatDate(date)
      });
    }
  }
  
  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  /**
   * Show processing prompt - now uses unified state
   */
  private showProcessingPrompt(): void {
    this.showProcessingState(
      'No embeddings data found',
      'Process your vault to enable finding similar notes.'
    );
  }
  
  /**
   * Start processing embeddings
   */
  private async startProcessing(): Promise<void> {
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      await manager.awaitReady();
      
      // Ensure processing isn't suspended from prior scan/config actions
      manager.resumeProcessing();

      if (manager.isCurrentlyProcessing()) {
        new Notice('Processing already in progress');
        return;
      }

      this.showProcessingStatus();

      // Prevent processing when using an incomplete custom provider configuration
      if (this.plugin.settings.embeddingsProvider === 'custom') {
        const endpoint = (this.plugin.settings.embeddingsCustomEndpoint || '').trim();
        const model = (this.plugin.settings.embeddingsCustomModel || this.plugin.settings.embeddingsModel || '').trim();
        if (!endpoint || !model) {
          this.showError('Custom embeddings provider is not configured. Set API Endpoint and Model in settings.');
          return;
        }
      }

      const result = await manager.processVault((progress) => {
        this.updateProcessingStatus(progress);
      });

      if (result.status === 'complete') {
        if (this.currentFile) {
          await this.searchForSimilar(this.currentFile);
        }
      } else if (result.status === 'cooldown') {
        this.showError(result.message || 'Embeddings processing is temporarily paused.');
      } else {
        const retrySeconds = result.retryAt ? Math.max(1, Math.ceil((result.retryAt - Date.now()) / 1000)) : null;
        const message = result.message || 'Embeddings processing paused due to provider error.';
        this.showError(retrySeconds ? `${message} Retry in ~${retrySeconds}s.` : message);
      }

    } catch (error) {
      this.showError(`Failed to process embeddings: ${error.message}`);
    }
  }
  
  /**
   * Show processing status - simplified and user-friendly
   */
  private showProcessingStatus(): void {
    this.showProcessingState(
      'Building semantic search...',
      'Preparing your notes for intelligent search. This happens once and runs in the background.',
      false
    );
    
    // Add progress elements
    const processingEl = this.resultsEl.querySelector('.embeddings-view-processing') as HTMLElement;
    if (processingEl) {
      const progressEl = processingEl.createDiv({ cls: 'processing-progress' });
      progressEl.createDiv({ 
        text: 'Starting...',
        cls: 'systemsculpt-progress-text' 
      });
      
      const progressBar = progressEl.createDiv({ cls: 'systemsculpt-progress-bar' });
      progressBar.createDiv({ cls: 'systemsculpt-progress-fill' });

      const secondaryActions = processingEl.createDiv({ cls: 'processing-secondary-actions' });
      const remainingBtn = secondaryActions.createEl('button', {
        text: 'View remaining files',
        cls: 'mod-muted'
      });
      remainingBtn.addEventListener('click', () => {
        this.openPendingFilesModal();
      });
    }
  }
  
  /**
   * Update processing progress
   */
  private updateProcessingStatus(progress: { current: number; total: number; currentFile?: string }): void {
    const progressEl = this.resultsEl.querySelector('.processing-progress');
    if (!progressEl) return;
    
    const progressText = progressEl.querySelector('.systemsculpt-progress-text') as HTMLElement;
    const progressFill = progressEl.querySelector('.systemsculpt-progress-fill') as HTMLElement;
    
    if (progressText) {
      const safeCurrent = Math.min(progress.current, progress.total);
      const percentage = progress.total > 0 ? Math.round((safeCurrent / progress.total) * 100) : 0;
      progressText.textContent = `Building embeddings... ${percentage}%`;
    }
    
    if (progressFill && progress.total > 0) {
      const safeCurrent = Math.min(progress.current, progress.total);
      const percentage = Math.min(100, (safeCurrent / progress.total) * 100);
      progressFill.style.width = `${percentage}%`;
      
      // Add processing animation when actively processing
      progressFill.classList.add('processing');
    }
  }
  
  private formatDate(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    // Less than 1 hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes}min ago`;
    }
    
    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours}h ago`;
    }
    
    // Less than 7 days
    if (diff < 604800000) {
      const days = Math.floor(diff / 86400000);
      return `${days}d ago`;
    }
    
    // Default to date
    return date.toLocaleDateString();
  }

  private openPendingFilesModal(): void {
    try {
      const modal = new EmbeddingsPendingFilesModal(this.app, this.plugin);
      modal.open();
    } catch (error) {
      console.error('EmbeddingsView: failed to open pending files modal', error);
      const message = error instanceof Error ? error.message : 'Failed to open pending files.';
      new Notice(message);
    }
  }
  
  
  async onClose(): Promise<void> {
    if (this.searchTimeout) {
      window.clearTimeout(this.searchTimeout);
    }
    if (this.dragTimeout) {
      window.clearTimeout(this.dragTimeout);
    }
    if (this.contextChangeHandler) {
      document.removeEventListener('systemsculpt:context-changed', this.contextChangeHandler);
    }
  }

  private flushPendingSearchIfVisible(): void {
    if (!this.isViewVisible() || !this.pendingSearch) return;
    const pending = this.pendingSearch;
    this.pendingSearch = null;
    if (pending.type === 'file' && pending.file) {
      // Small defer to allow layout to settle
      setTimeout(() => this.searchForSimilar(pending.file), 10);
    } else if (pending.type === 'chat' && pending.chatView) {
      setTimeout(() => this.searchForSimilarFromChat(pending.chatView), 10);
    }
  }
  
  /**
   * Simple hash function for content comparison
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  /**
   * Unified processing state - replaces multiple similar states
   */
  private showProcessingState(title: string, description: string, showActions: boolean = true): void {
    this.statusEl.empty();
    this.resultsEl.empty();

    const processingEl = this.resultsEl.createDiv({ cls: 'embeddings-view-processing' });
    
    // Processing icon
    const iconEl = processingEl.createDiv({ cls: 'processing-icon' });
    setIcon(iconEl, 'database');
    
    // Processing message
    processingEl.createDiv({ 
      text: title,
      cls: 'processing-title' 
    });
    
    processingEl.createDiv({ 
      text: description,
      cls: 'processing-description' 
    });

    if (showActions) {
      // Action buttons
      const actionsEl = processingEl.createDiv({ cls: 'processing-actions' });
      
      const startBtn = actionsEl.createEl('button', {
        text: 'Start Processing',
        cls: 'mod-cta'
      });
      startBtn.addEventListener('click', async () => {
        await this.startProcessing();
      });

      const settingsBtn = actionsEl.createEl('button', {
        text: 'Settings',
        cls: 'mod-muted'
      });
      settingsBtn.addEventListener('click', () => {
        this.plugin.openSettingsTab("embeddings");
      });
    }
  }

} 
