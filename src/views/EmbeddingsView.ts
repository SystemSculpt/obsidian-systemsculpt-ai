import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import SystemSculptPlugin from '../main';
import { EMBEDDINGS_VIEW_TYPE } from "../core/plugin/viewTypes";
import { CHAT_VIEW_TYPE } from "../core/plugin/viewTypes";
import { SearchResult } from '../services/embeddings/types';
import type { AgentChatView } from './chatview/AgentChatView';
import { SystemSculptSettings } from '../types';
import { EmbeddingsPendingFilesModal } from '../modals/EmbeddingsPendingFilesModal';
import { SimilarNotesPresentation } from './SimilarNotesPresentation';
import { buildChatSemanticQuery, buildNoteSemanticQuery } from '../services/embeddings/SemanticQuery';
import {
  CHAT_TRANSCRIPT_COMMITTED_EVENT,
  type ChatTranscriptCommittedEvent,
} from './chatview/ChatTranscriptEvents';
import {
  SimilaritySearchRunCoordinator,
  chatSimilaritySource,
  fileSimilaritySource,
  type SimilaritySearchRun,
} from './SimilaritySearchRunCoordinator';
import { readEmbeddingErrorMessage } from '../services/embeddings/EmbeddingErrorMessage';
import type { SemanticIndexSnapshot } from '../services/embeddings/SemanticIndexLifecycle';
import { getSurfaceOwnerWindow } from '../core/ui/surface/SurfaceDomContext';
import {
  FILE_CONTEXT_STATE_CHANGED_EVENT,
  type FileContextStateChangedEvent,
} from './chatview/FileContextManager';

export { EMBEDDINGS_VIEW_TYPE };

export class EmbeddingsView extends ItemView {
  private plugin: SystemSculptPlugin;
  private presentation: SimilarNotesPresentation | null = null;
  private currentFile: TFile | null = null;
  private currentChatView: AgentChatView | null = null;
  private currentResults: SearchResult[] = [];
  private lastFileHash = '';
  private forceRefreshNextCheck = false;
  private lastEmbeddingsConfigKey = '';
  private isDragging = false;
  private unsubscribeIndexLifecycle: (() => void) | null = null;
  private lastIndexSnapshot: Readonly<SemanticIndexSnapshot> | null = null;
  private deletedSourcePath: string | null = null;
  private readonly searchRuns: SimilaritySearchRunCoordinator;
  private readonly SEARCH_DELAY = 300; // 300ms delay
  
  constructor(leaf: WorkspaceLeaf, plugin: SystemSculptPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.searchRuns = new SimilaritySearchRunCoordinator({
      isVisible: () => this.isViewVisible(),
      getOwnerWindow: () => getSurfaceOwnerWindow(this.contentEl),
      execute: (run) => this.executeSimilaritySearch(run),
      onError: (error) => this.showError(`Failed to find similar notes: ${this.errorMessage(error)}`),
      onCancel: () => this.presentation?.setRefreshing(false),
    });
  }

  private getActiveChatView(): AgentChatView | null {
    const activeLeaf = this.app.workspace.activeLeaf;
    const activeView = activeLeaf?.view as AgentChatView | undefined;
    if (activeView?.getViewType?.() !== CHAT_VIEW_TYPE) {
      return null;
    }
    return activeView;
  }
  
  getViewType(): string {
    return EMBEDDINGS_VIEW_TYPE;
  }
  
  getDisplayText(): string {
    return 'Similar notes';
  }
  
  getIcon(): string {
    return 'network';
  }
  
  async onOpen(): Promise<void> {
    this.searchRuns.open();
    this.contentEl = this.containerEl.children[1] as HTMLElement;
    this.contentEl.empty();
    this.contentEl.addClass('systemsculpt-embeddings-view');
    
    this.setupUI();
    this.bindIndexLifecycle();
    this.registerEvents();
    this.lastEmbeddingsConfigKey = this.getEmbeddingsConfigKey(this.plugin.settings);
    
    // Immediately evaluate the current active file/chat to populate results on open
    // so users don't need to refocus the editor to see similar notes.
    this.debouncedCheckActiveFile();
  }
  
  private setupUI(): void {
    if (this.presentation) {
      this.removeChild(this.presentation);
      this.presentation.unload();
    }
    this.contentEl.empty();
    this.presentation = new SimilarNotesPresentation(this.contentEl, {
      onRefresh: () => this.refreshCurrentContext(),
      onOpenSettings: () => this.plugin.openSettingsTab("knowledge"),
      onOpenPendingFiles: () => this.openPendingFilesModal(),
      onStartProcessing: () => this.startProcessing(),
      onOpenFile: (path) => this.openFile(path),
      onAddToContext: (path) => this.addResultToCurrentChat(path),
      onDragStateChange: (dragging) => {
        this.isDragging = dragging;
        if (!dragging) {
          this.debouncedCheckActiveFile();
        }
      },
      isInContext: (path) => this.isNoteInContext(path),
    });
    this.addChild(this.presentation);
    this.showEmptyState();
  }
  
  private registerEvents(): void {
    // Listen for active leaf changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view?.getViewType?.() === EMBEDDINGS_VIEW_TYPE) {
          this.forceRefreshNextCheck = true;
        }
        // If the user brought this view to front, resume the exact deferred
        // source. Other leaf changes invalidate it and re-evaluate context.
        if (leaf?.view?.getViewType?.() === EMBEDDINGS_VIEW_TYPE && this.searchRuns.hasPending()) {
          this.searchRuns.reconcileVisibility();
        } else {
          this.debouncedCheckActiveFile();
        }
      })
    );
    
    // Also listen for direct file-open events which can fire without a leaf switch
    this.registerEvent(
      // @ts-ignore - 'file-open' exists on workspace event bus
      this.app.workspace.on('file-open', (file) => {
        if (file instanceof TFile && file.path === this.deletedSourcePath) {
          this.deletedSourcePath = null;
        }
        this.forceRefreshNextCheck = true;
        this.debouncedCheckActiveFile();
      })
    );

    // Refresh results when managed indexing settings change.
    this.registerEvent(
      this.app.workspace.on("systemsculpt:settings-updated", (_oldSettings, newSettings: SystemSculptSettings) => {
        const nextKey = this.getEmbeddingsConfigKey(newSettings);
        if (nextKey === this.lastEmbeddingsConfigKey) {
          return;
        }
        this.lastEmbeddingsConfigKey = nextKey;
        this.bindIndexLifecycle();
        this.forceRefreshNextCheck = true;
        this.debouncedCheckActiveFile();
      })
    );
    
    // Listen for layout changes so we can run any pending searches when the view becomes visible
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.searchRuns.reconcileVisibility();
      })
    );
    
    // Listen for file modifications
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file === this.currentFile) {
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
      this.app.vault.on("delete", (file) => this.handleVaultDelete(file))
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
    
    // Durable transcript changes are emitted only after the vault write commits.
    this.registerEvent(
      (this.app.workspace as any).on(CHAT_TRANSCRIPT_COMMITTED_EVENT, (event: ChatTranscriptCommittedEvent) => {
        if (this.currentChatView && this.currentChatView.chatId === event?.chatId) {
          this.debouncedSearchCurrentChat();
        }
      })
    );
    
    // File context is plugin state, not document state. The workspace event
    // bus keeps this synchronized even when either view lives in a popout.
    this.registerEvent(
      (this.app.workspace as any).on(
        FILE_CONTEXT_STATE_CHANGED_EVENT,
        (event: FileContextStateChangedEvent) => {
          if (
            event?.kind === "context" &&
            event.manager === this.currentChatView?.contextManager &&
            this.currentResults.length > 0
          ) {
            this.updateContextIndicators();
          }
        },
      ),
    );
  }

  private bindIndexLifecycle(): void {
    this.unsubscribeIndexLifecycle?.();
    this.unsubscribeIndexLifecycle = null;
    this.lastIndexSnapshot = null;
    this.presentation?.clearIndexSnapshot();

    if (!this.plugin.settings.embeddingsEnabled) return;
    const manager = this.plugin.getOrCreateEmbeddingsManager();
    this.unsubscribeIndexLifecycle = manager.subscribeLifecycle((snapshot) => {
      this.presentation?.setIndexSnapshot(snapshot);

      const previous = this.lastIndexSnapshot;
      this.lastIndexSnapshot = snapshot;
      const generationChanged = Boolean(
        previous?.generation?.namespace
        && snapshot.generation?.namespace
        && previous.generation.namespace !== snapshot.generation.namespace,
      );
      const reconciliationSettled = previous?.phase === "reconciling"
        && snapshot.phase !== "reconciling";
      if (generationChanged || reconciliationSettled) {
        this.forceRefreshNextCheck = true;
        this.debouncedCheckActiveFile();
      }
    });
  }
  
  private debouncedCheckActiveFile(): void {
    this.searchRuns.scheduleTask(() => this.checkActiveFile(), this.SEARCH_DELAY);
  }
  
  private debouncedSearchCurrentFile(): void {
    if (this.currentFile) {
      this.searchRuns.schedule(fileSimilaritySource(this.currentFile), this.SEARCH_DELAY * 2);
    }
  }

  private debouncedSearchCurrentChat(): void {
    if (this.currentChatView) {
      this.searchRuns.schedule(chatSimilaritySource(this.currentChatView), this.SEARCH_DELAY * 2);
    }
  }

  private handleVaultDelete(file: { path?: string }): void {
    if (this.isDragging) return;
    this.searchRuns.cancel();
    const deletedPath = typeof file?.path === "string" ? file.path : "";
    if (!deletedPath) return;

    if (deletedPath === this.currentFile?.path) {
      this.deletedSourcePath = deletedPath;
      this.lastFileHash = "";
      this.forceRefreshNextCheck = false;
      this.showEmptyState();
      return;
    }

    if (this.currentResults.some((result) => result.path === deletedPath)) {
      const filtered = this.currentResults.filter((result) => result.path !== deletedPath);
      this.currentResults = filtered;
      if (this.currentFile) {
        void this.updateResults(filtered, this.currentFile).catch(() => undefined);
      } else if (this.currentChatView) {
        void this.updateResults(
          filtered,
          null,
          this.currentChatView.getChatTitle() || "Chat",
        ).catch(() => undefined);
      }
    }
    this.forceRefreshNextCheck = true;
    this.debouncedCheckActiveFile();
  }
  
  private startRefreshAnimation(): void {
    this.presentation?.setRefreshing(true);
  }
  
  private updateFileName(fileName: string): void {
    this.presentation?.setSourceName(fileName);
  }

  private async refreshCurrentContext(): Promise<void> {
    if (!this.plugin.settings.embeddingsEnabled) {
      this.searchRuns.cancel();
      this.showDisabledState();
      return;
    }

    if (this.currentFile) {
      await this.searchForSimilar(this.currentFile);
      return;
    }
    if (this.currentChatView) {
      await this.searchForSimilarFromChat(this.currentChatView);
      return;
    }

    this.forceRefreshNextCheck = true;
    this.checkActiveFile();
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
      this.searchRuns.cancel();
      this.showDisabledState();
      return;
    }
    
    let activeChatView = this.getActiveChatView();
    // `workspace.getActiveFile()` can be null while focus is on non-file views (including this Similar Notes view).
    // Prefer the active agent workspace when present; otherwise use the workspace file.
    let activeFile = activeChatView ? null : this.app.workspace.getActiveFile();
    if (activeFile?.path === this.deletedSourcePath) {
      activeFile = null;
    }

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
      this.searchRuns.schedule(fileSimilaritySource(activeFile), 50);
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
      this.searchRuns.schedule(chatSimilaritySource(activeChatView), 50);
    } else if (isRefocusingOnChat) {
      if (!activeChatView) return;
      // Re-focusing on the same chat - check if content changed
      // No logging for re-focus, only for content changes
      const chatContent = this.extractChatContent(activeChatView);
      const contentHash = this.hashContent(chatContent);
      if (forceRefresh || contentHash !== this.lastFileHash) {
        // Content changed, refresh the results
        this.searchRuns.schedule(chatSimilaritySource(activeChatView), 50);
      }
    } else if (switchingFromNonContentView) {
      // Switching from settings/file explorer back to content
      if (activeFile) {
        // No need to log returning to same file
        this.currentFile = activeFile;
        this.currentChatView = null;
        this.updateFileName(activeFile.basename);
        this.searchRuns.schedule(fileSimilaritySource(activeFile), 50);
      } else if (activeChatView) {
        // No need to log returning to same chat
        this.currentChatView = activeChatView;
        this.currentFile = null;
        this.updateFileName(activeChatView.getChatTitle() || 'Chat');
        this.searchRuns.schedule(chatSimilaritySource(activeChatView), 50);
      }
    } else if (forceRefresh) {
      // Force refresh current context after an indexing setting or vault change.
      if (activeFile) {
        this.currentFile = activeFile;
        this.currentChatView = null;
        this.updateFileName(activeFile.basename);
        this.searchRuns.schedule(fileSimilaritySource(activeFile), 50);
      } else if (activeChatView) {
        this.currentChatView = activeChatView;
        this.currentFile = null;
        this.updateFileName(activeChatView.getChatTitle() || 'Chat');
        this.searchRuns.schedule(chatSimilaritySource(activeChatView), 50);
      }
    }
    // If none of the above, preserve current state
  }

  private getEmbeddingsConfigKey(settings: SystemSculptSettings): string {
    const enabled = settings?.embeddingsEnabled ? "1" : "0";
    const exclusions = settings?.embeddingsExclusions ?? {};
    return JSON.stringify({
      enabled,
      exclusions,
    });
  }

  private async searchForSimilar(file: TFile): Promise<void> {
    await this.searchRuns.run(fileSimilaritySource(file));
  }

  private async searchForSimilarFromChat(chatView: AgentChatView): Promise<void> {
    await this.searchRuns.run(chatSimilaritySource(chatView));
  }

  private async executeSimilaritySearch(run: SimilaritySearchRun): Promise<void> {
    const manager = this.plugin.getOrCreateEmbeddingsManager();
    await manager.awaitReady();
    if (!run.isCurrent()) return;

    const hasAnyEmbeddings = manager.hasAnyEmbeddings();
    const lifecycle = manager.getLifecycleSnapshot();

    if (run.source.kind === "file") {
      const file = run.source.file;
      const fingerprint = `${file.stat.mtime}-${file.stat.size}`;
      const fileIndex = manager.getFileIndexSnapshot(file.path);
      if (fileIndex.state === "empty") {
        this.showEmptyContent();
        return;
      }
      if (!hasAnyEmbeddings) {
        this.showUnavailableIndex(lifecycle);
        return;
      }
      const fileInEmbeddings = fileIndex.ready;
      if (!fileInEmbeddings || fingerprint !== this.lastFileHash) {
        this.showSmartLoading(file.basename, !fileInEmbeddings);
        this.lastFileHash = fingerprint;
      } else {
        this.showQuickLoading(file.basename);
      }

      if (!fileInEmbeddings) {
        const content = await this.app.vault.read(file);
        if (!run.isCurrent()) return;
        if (!content.trim()) {
          this.showEmptyContent();
          return;
        }
        this.showQuickLoading(file.basename);
        const results = await manager.searchSimilar(
          buildNoteSemanticQuery(content),
          15,
          run.signal,
        );
        if (run.isCurrent()) await this.updateResults(results, file);
        return;
      }

      const results = await manager.findSimilar(file.path, 15, run.signal);
      if (run.isCurrent()) await this.updateResults(results, file);
      return;
    }

    const chatView = run.source.chatView;
    const chatContent = this.extractChatContent(chatView);
    if (!chatContent.trim()) {
      this.showEmptyContent();
      return;
    }
    if (!hasAnyEmbeddings) {
      this.showUnavailableIndex(lifecycle);
      return;
    }
    const contentHash = this.hashContent(chatContent);
    const chatTitle = chatView.getChatTitle() || 'Chat';
    if (contentHash !== this.lastFileHash) {
      this.showSmartLoading(chatTitle, false);
      this.lastFileHash = contentHash;
    } else {
      this.showQuickLoading(chatTitle);
    }
    const results = await manager.searchSimilar(chatContent, 15, run.signal);
    if (run.isCurrent()) await this.updateResults(results, null, chatTitle);
  }

  private extractChatContent(chatView: AgentChatView): string {
    return buildChatSemanticQuery(chatView.getMessages() || []);
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

  private updateContextIndicators(): void {
    this.presentation?.syncContextIndicators();
  }

  private showSmartLoading(fileName: string, _needsProcessing: boolean): void {
    this.updateFileName(fileName);
    this.startRefreshAnimation();
  }

  private showQuickLoading(fileName: string): void {
    this.updateFileName(fileName);
    this.startRefreshAnimation();
  }

  private showEmptyState(): void {
    this.currentFile = null;
    this.currentChatView = null;
    this.currentResults = [];
    this.presentation?.render({ state: 'idle' });
  }

  private showEmptyContent(): void {
    this.currentResults = [];
    this.presentation?.render({ state: 'empty-content' });
  }

  private showError(message: string): void {
    this.currentResults = [];
    this.presentation?.render({
      state: 'error',
      message: readEmbeddingErrorMessage(message, 'Similar notes are unavailable. Try again.'),
    });
  }

  private showDisabledState(): void {
    this.currentFile = null;
    this.currentChatView = null;
    this.currentResults = [];
    this.presentation?.render({ state: 'disabled' });
  }

  private async updateResults(results: SearchResult[], sourceFile: TFile | null, sourceName?: string): Promise<void> {
    this.currentResults = results;
    const displayName = sourceName || sourceFile?.basename || 'Unknown';
    this.presentation?.render({
      state: 'results',
      sourceName: displayName,
      results,
      chatContext: this.currentChatView !== null,
    });
  }
  
  private async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    }
  }

  private async addResultToCurrentChat(path: string): Promise<void> {
    const chatView = this.currentChatView;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!chatView || !(file instanceof TFile)) {
      new Notice('This note is no longer available.');
      return;
    }

    try {
      await chatView.addFileToContext(file);
      this.updateContextIndicators();
    } catch (error) {
      new Notice(`Could not add note to chat: ${this.errorMessage(error)}`);
    }
  }

  /**
   * Show processing prompt - now uses unified state
   */
  private showProcessingPrompt(): void {
    this.currentResults = [];
    this.presentation?.render({ state: 'index-required' });
  }

  private showUnavailableIndex(snapshot: Readonly<SemanticIndexSnapshot>): void {
    if (snapshot.phase === "reconciling" || snapshot.pending > 0) {
      this.showProcessingStatus();
      return;
    }
    if (snapshot.phase === "error" || snapshot.failed > 0) {
      this.showError(snapshot.lastError?.message || "The semantic index needs attention.");
      return;
    }
    this.showProcessingPrompt();
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
        this.showProcessingStatus();
        new Notice('Processing already in progress');
        return;
      }

      this.showProcessingStatus();

      const result = await manager.processVault((progress) => {
        this.updateProcessingStatus(progress);
      });

      if (result.status === 'complete') {
        if (this.currentFile) {
          await this.searchForSimilar(this.currentFile);
        } else if (this.currentChatView) {
          await this.searchForSimilarFromChat(this.currentChatView);
        } else {
          await this.refreshCurrentContext();
        }
      } else {
        this.showError(readEmbeddingErrorMessage(
          result.message ?? result.failure,
          'Embeddings processing stopped. Try again.',
        ));
      }

    } catch (error) {
      this.showError(`Failed to process embeddings: ${this.errorMessage(error)}`);
    }
  }
  
  /**
   * Show processing status - simplified and user-friendly
   */
  private showProcessingStatus(): void {
    this.currentResults = [];
    this.presentation?.render({ state: 'processing' });
  }
  
  /**
   * Update processing progress
   */
  private updateProcessingStatus(progress: { current: number; total: number; currentFile?: string }): void {
    this.presentation?.updateProgress(progress);
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
    this.searchRuns.close();
    this.unsubscribeIndexLifecycle?.();
    this.unsubscribeIndexLifecycle = null;
    this.lastIndexSnapshot = null;
    if (this.presentation) {
      this.removeChild(this.presentation);
      this.presentation.unload();
      this.presentation = null;
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

  private errorMessage(error: unknown): string {
    return readEmbeddingErrorMessage(error, 'Similar notes are unavailable. Try again.');
  }

} 
