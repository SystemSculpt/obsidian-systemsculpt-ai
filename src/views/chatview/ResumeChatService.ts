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
  private readonly resumeActionByView = new Map<MarkdownView, {
    element: HTMLElement;
    filePath: string;
    chatId: string;
  }>();
  private readonly schedulerWindow: Window;
  private initialRefreshHandle: number | null = null;
  private layoutRefreshHandle: number | null = null;
  private disposed = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.schedulerWindow = window;
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
    this.initialRefreshHandle = this.schedulerWindow.setTimeout(() => {
      this.initialRefreshHandle = null;
      if (this.disposed) return;
      this.refreshAllLeaves();
    }, 0);
  }

  private debouncedRefreshAllLeaves() {
    return () => {
      if (this.disposed || this.layoutRefreshHandle !== null) return;
      // Defer and coalesce repeated layout-change bursts
      this.layoutRefreshHandle = this.schedulerWindow.setTimeout(() => {
        this.layoutRefreshHandle = null;
        if (this.disposed) return;
        this.refreshAllLeaves();
      }, 50);
    };
  }

  private refreshAllLeaves(): void {
    if (this.disposed) return;
    const liveViews = new Set<MarkdownView>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        liveViews.add(leaf.view);
      }
      this.handleLeafChange(leaf);
    });

    for (const view of this.resumeActionByView.keys()) {
      if (!liveViews.has(view)) {
        this.removeResumeAction(view);
      }
    }
  }

  private handleLeafChange(leaf: WorkspaceLeaf): void {
    if (this.disposed) return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;

    const file = view.file;
    if (!file || !this.isChatHistoryFile(file)) {
      this.removeResumeAction(view);
      return;
    }

    // Extract chat ID from the file
    const chatId = this.extractChatId(file);
    if (!chatId) {
      this.removeResumeAction(view);
      return;
    }

    const current = this.resumeActionByView.get(view);
    if (
      current?.element.isConnected &&
      current.filePath === file.path &&
      current.chatId === chatId
    ) return;
    this.removeResumeAction(view);

    const action = view.addAction("message-circle", "Resume this chat", () => {
      void this.openChat(chatId, file.path);
    });
    this.resumeActionByView.set(view, {
      element: action,
      filePath: file.path,
      chatId,
    });
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

  private removeResumeAction(view: MarkdownView): void {
    this.resumeActionByView.get(view)?.element.remove();
    this.resumeActionByView.delete(view);
  }

  cleanup(): void {
    this.disposed = true;
    if (this.initialRefreshHandle !== null) {
      this.schedulerWindow.clearTimeout(this.initialRefreshHandle);
      this.initialRefreshHandle = null;
    }
    if (this.layoutRefreshHandle !== null) {
      this.schedulerWindow.clearTimeout(this.layoutRefreshHandle);
      this.layoutRefreshHandle = null;
    }
    for (const action of this.resumeActionByView.values()) {
      action.element.remove();
    }
    this.resumeActionByView.clear();
  }
}
