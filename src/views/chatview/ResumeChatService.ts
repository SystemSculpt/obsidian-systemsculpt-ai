import { App, MarkdownView, WorkspaceLeaf, TFile, Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { SystemSculptSettings } from "../../types";
import { CHAT_VIEW_TYPE } from "./ChatView";

export class ResumeChatService {
  private app: App;
  private plugin: SystemSculptPlugin;
  private settings: SystemSculptSettings;
  private listeners: Array<{ element: HTMLElement; type: string; listener: EventListener }> = [];
  // Track inserted resume buttons per leaf to avoid broad DOM scans
  private resumeButtonByLeaf: WeakMap<WorkspaceLeaf, HTMLElement> = new WeakMap();

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.settings = plugin.settings;

    // ResumeChatService initialized - silent success

    // Register workspace events for handling markdown views
    this.registerWorkspaceEvents();
  }

  private registerWorkspaceEvents() {
    // Handle active leaf changes
    this.plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf) {
          this.handleLeafChange(leaf);
        }
      })
    );

    // Handle layout changes
    this.plugin.registerEvent(
      this.app.workspace.on('layout-change', this.debouncedRefreshAllLeaves())
    );

    // Handle file changes
    this.plugin.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (this.isChatHistoryFile(file)) {
          this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
              this.handleLeafChange(leaf);
            }
          });
        }
      })
    );
  }

  private debouncedRefreshAllLeaves() {
    let scheduled = false;
    return () => {
      if (scheduled) return;
      scheduled = true;
      // Defer and coalesce repeated layout-change bursts
      setTimeout(() => {
        try {
          this.app.workspace.iterateAllLeaves((leaf) => {
            this.handleLeafChange(leaf);
          });
        } finally {
          scheduled = false;
        }
      }, 50);
    };
  }

  private async handleLeafChange(leaf: WorkspaceLeaf) {
    // Freeze diagnostics breadcrumb for when chat leaves are inspected
    try { (window as any).FreezeMonitor?.mark?.('resume-chat:handleLeafChange:start'); } catch {}
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    const file = view.file;

    // Remove any existing resume chat button for this leaf (targeted)
    const existingButton = this.resumeButtonByLeaf.get(leaf);
    if (existingButton && existingButton.isConnected) {
      existingButton.remove();
    }
    this.resumeButtonByLeaf.delete(leaf);

    // If not a chat history file, return early after cleanup
    if (!file || !this.isChatHistoryFile(file)) return;

    // Get the appropriate container based on current view mode
    const editorContainer = view.contentEl.querySelector('.cm-editor');
    const contentContainer = view.getMode() === 'source' ? editorContainer : view.contentEl;
    if (!contentContainer) return;

    // Extract chat ID from the file
    const chatId = this.extractChatId(file);
    if (!chatId) return;

    // Create and insert the resume chat button
    const buttonContainer = this.createResumeChatButton(chatId, file);
    contentContainer.insertBefore(buttonContainer, contentContainer.firstChild);
    this.resumeButtonByLeaf.set(leaf, buttonContainer);
    try { (window as any).FreezeMonitor?.mark?.('resume-chat:handleLeafChange:end'); } catch {}
  }

  public isChatHistoryFile(file: TFile): boolean {
    // Check if file is in the chats directory
    const chatsDirectory = this.settings.chatsDirectory || "SystemSculpt/Chats";
    if (!file.path.startsWith(chatsDirectory)) return false;

    // Check if it's a markdown file
    if (!file.path.endsWith('.md')) return false;

    // Check metadata to confirm it's a chat file
    const cache = this.app.metadataCache.getCache(file.path);
    if (!cache?.frontmatter) return false;

    // Check for expected chat metadata fields
    const metadata = cache.frontmatter;
    return !!(metadata.id && metadata.model && (metadata.created || metadata.lastModified));
  }

  public extractChatId(file: TFile): string | null {
    // First try to get ID from metadata
    const cache = this.app.metadataCache.getCache(file.path);
    if (cache?.frontmatter?.id) {
      return cache.frontmatter.id;
    }

    // Fallback: extract from filename (remove .md extension)
    const filename = file.basename;
    return filename || null;
  }

  public getModelFromFile(file: TFile): string {
    const cache = this.app.metadataCache.getCache(file.path);
    return cache?.frontmatter?.model || this.plugin.settings.selectedModelId;
  }

  private createResumeChatButton(chatId: string, file: TFile): HTMLElement {
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'systemsculpt-resume-chat-button';

    const button = document.createElement('button');
    button.className = 'systemsculpt-resume-chat-btn';
    button.textContent = 'Resume this chat';

    // Get the selected model from metadata if available
    const selectedModelId = this.getModelFromFile(file);

    const clickHandler = async () => {
      await this.openChat(chatId, selectedModelId);
    };

    this.registerListener(button, 'click', clickHandler);

    buttonContainer.appendChild(button);

    return buttonContainer;
  }

  public async openChat(chatId: string, selectedModelId: string): Promise<void> {
    try {
      const { workspace } = this.app;
      const leaf = workspace.getLeaf("tab");

      // Set view state with chat ID and model
      await leaf.setViewState({
        type: CHAT_VIEW_TYPE,
        state: {
          chatId: chatId,
          selectedModelId: selectedModelId
        }
      });

      workspace.setActiveLeaf(leaf, { focus: true });
    } catch (e) {
      new Notice("Error opening chat. Please try again.");
    }
  }

  private registerListener(element: HTMLElement, type: string, listener: EventListener) {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  cleanup() {
    // Remove all registered event listeners
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
  }
}