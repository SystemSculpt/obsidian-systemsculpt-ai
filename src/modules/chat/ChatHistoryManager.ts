import { App, TFile, MarkdownView } from 'obsidian';
import { ChatHistorySearcher } from './ChatHistorySearcher';
import { ChatMessage } from './ChatMessage';
import { ChatView } from './ChatView';
import { ContextFileManager } from './ContextFileManager';

export class ChatHistoryManager {
  constructor(
    private app: App,
    private chatView: ChatView,
    private contextFileManager: ContextFileManager,
    private chatModule: any
  ) {}

  openChatHistory() {
    const chatHistorySearcher = new ChatHistorySearcher(
      this.app,
      this.chatModule.settings.chatsPath
    );
    chatHistorySearcher.open();
    chatHistorySearcher.onChooseItem = (file: TFile) => {
      this.openChatFile(file);
    };
  }

  async openChatFile(file: TFile) {
    this.chatView.setChatFile(file);
    await this.loadChatFile(file);
    this.chatModule.saveLastOpenedChat(file.path);
    this.chatView.focusInput();
  }

  openChatHistoryFile() {
    if (this.chatView.chatFile) {
      const leaves = this.app.workspace.getLeavesOfType('markdown');
      for (const leaf of leaves) {
        const view = leaf.view;
        if (
          view instanceof MarkdownView &&
          view.file &&
          view.file.path === this.chatView.chatFile.path
        ) {
          this.app.workspace.revealLeaf(leaf);
          return;
        }
      }
      this.app.workspace.openLinkText(this.chatView.chatFile.path, '', true);
    }
  }

  async loadChatFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const messages: ChatMessage[] = [];
    this.chatView.contextFiles = []; // Clear existing context files

    // Extract the "Context Files" section
    const contextFilesSection = content.match(
      /# Context Files\n([\s\S]*?)\n# AI Chat History/
    );
    if (contextFilesSection) {
      const contextFilesContent = contextFilesSection[1];
      const linkRegex = /\[\[([^\]]+)\]\]/g;
      let match;

      while ((match = linkRegex.exec(contextFilesContent)) !== null) {
        const linkText = match[1].trim();
        const contextFile = this.app.metadataCache.getFirstLinkpathDest(
          linkText,
          file.path
        ) as TFile;
        if (
          contextFile &&
          !this.chatView.contextFiles.some(
            existingFile => existingFile.path === contextFile.path
          )
        ) {
          this.chatView.contextFiles.push(contextFile);
        }
      }
    }

    // Match all code blocks with user or ai roles
    const blockRegex = /`````\s*(user|ai(?:-[^\n]+)?)\s*([\s\S]*?)\s*`````/g;
    let match;

    while ((match = blockRegex.exec(content)) !== null) {
      const role = match[1] as 'user' | 'ai';
      const text = match[2].trim();
      const model = role.startsWith('ai-') ? match[1].slice(3) : undefined;
      messages.push(new ChatMessage(role as 'user' | 'ai', text, model));
    }

    this.chatView.chatMessages = messages;
    this.chatView.chatFile = file;
    this.chatView.renderMessages();
    this.contextFileManager.renderContextFiles();
    await this.chatView.updateTokenCount();
    this.chatView.scrollToBottom();
  }
}