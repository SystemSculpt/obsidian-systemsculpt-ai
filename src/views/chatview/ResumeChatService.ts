import { App, MarkdownView, WorkspaceLeaf, TFile, Notice } from "obsidian";
import SystemSculptPlugin from "../../main";
import { SystemSculptSettings } from "../../types";
import { ChatStorageService } from "./ChatStorageService";
import { openChatResumeDescriptor } from "./ChatResumeUtils";

export class ResumeChatService {
  private app: App;
  private plugin: SystemSculptPlugin;
  private settings: SystemSculptSettings;
  private chatStorage: ChatStorageService;
  private listeners: Array<{ element: HTMLElement; type: string; listener: EventListener }> = [];
  // Track inserted resume buttons per leaf to avoid broad DOM scans
  private resumeButtonByLeaf: WeakMap<WorkspaceLeaf, HTMLElement> = new WeakMap();

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.settings = plugin.settings;
    this.chatStorage = new ChatStorageService(this.app, this.settings.chatsDirectory || "SystemSculpt/Chats");

    // ResumeChatService initialized - silent success

    // Register workspace events for handling markdown views
    this.registerWorkspaceEvents();
    this.scheduleInitialRefresh();
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

  private scheduleInitialRefresh() {
    setTimeout(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        void this.handleLeafChange(leaf);
      });
    }, 0);
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

    // Check for expected chat metadata fields. Old chat files may not carry a
    // persisted model anymore, so identity + timestamps are the stable contract.
    const metadata = cache.frontmatter;
    return !!(metadata.id && (metadata.created || metadata.lastModified));
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

  private createResumeChatButton(chatId: string, file: TFile): HTMLElement {
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'systemsculpt-resume-chat-button';

    const button = document.createElement('button');
    button.className = 'systemsculpt-resume-chat-btn';
    button.textContent = 'Resume this chat';

    const clickHandler = async () => {
      await this.openChat(chatId, file.path);
    };

    this.registerListener(button, 'click', clickHandler);

    buttonContainer.appendChild(button);

    return buttonContainer;
  }

  public async openChat(chatId: string, chatPath?: string): Promise<void> {
    try {
      const descriptor = await this.chatStorage.getChatResumeDescriptor(chatId);
      if (descriptor) {
        await openChatResumeDescriptor(this.plugin, {
          ...descriptor,
          chatPath: chatPath || descriptor.chatPath,
        });
        return;
      }

      const targetLeaf = this.app.workspace.getLeaf("tab");
      await targetLeaf.setViewState({
        type: "systemsculpt-chat-view",
        state: {
          chatId,
        },
      });
      this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
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

    this.app.workspace.iterateAllLeaves((leaf) => {
      const button = this.resumeButtonByLeaf.get(leaf);
      if (button?.isConnected) {
        button.remove();
      }
      this.resumeButtonByLeaf.delete(leaf);
    });
  }
}
