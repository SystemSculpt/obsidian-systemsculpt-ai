import { ItemView, WorkspaceLeaf, TFile, moment } from 'obsidian';
import { ChatMessage } from './ChatMessage';
import { BrainModule } from '../brain/BrainModule';
import { ChatModule } from './ChatModule';
import { renderMessages } from './functions/renderMessages';
import { chatTemplate } from './ChatTemplate';
import { TokenManager } from './TokenManager';
import { ChatHistoryManager } from './ChatHistoryManager';
import { ContextFileManager } from './ContextFileManager';
import { ChatFileManager } from './ChatFileManager';
import {
  attachEventListeners,
  attachFileSearcherListeners,
} from './functions/EventListeners';
import { CostEstimator } from '../../interfaces/CostEstimatorModal';
import { ActionsModal } from './views/ActionsModal';
import {
  toggleEditTitle,
  generateTitleForChat,
  updateChatTitle,
} from './functions/generateTitleForChat';
import { FileSearcher } from './FileSearcher';
import { showCustomNotice } from '../../modals';
import { logger } from '../../utils/logger';

export const VIEW_TYPE_CHAT = 'chat-view';

export class ChatView extends ItemView {
  chatMessages: ChatMessage[];
  brainModule: BrainModule;
  chatModule: ChatModule;
  chatFile: TFile | null;
  contextFiles: TFile[] = [];
  public tokenManager: TokenManager;
  public chatHistoryManager: ChatHistoryManager;
  public contextFileManager: ContextFileManager;
  public chatFileManager: ChatFileManager;

  constructor(
    leaf: WorkspaceLeaf,
    brainModule: BrainModule,
    chatModule: ChatModule
  ) {
    super(leaf);
    this.chatMessages = [];
    this.brainModule = brainModule;
    this.chatModule = chatModule;
    this.initializeManagers();
  }

  private initializeManagers() {
    this.contextFileManager = new ContextFileManager(this.app, this);
    this.tokenManager = new TokenManager(this.app);
    this.chatHistoryManager = new ChatHistoryManager(
      this.app,
      this,
      this.contextFileManager
    );
    this.chatFileManager = new ChatFileManager(
      this.app,
      this.chatModule.settings.chatsPath
    );
  }

  private attachListeners() {
    this.attachContextFilesButtonListener();
    this.attachChatTitleListener();
  }

  private attachContextFilesButtonListener() {
    const contextFilesButton = this.containerEl.querySelector(
      '.context-files-header'
    ) as HTMLElement;
    if (contextFilesButton) {
      contextFilesButton.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        this.openContextFilesSearch();
      });
    }
  }

  private attachChatTitleListener() {
    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl) {
      titleEl.style.cursor = 'pointer';
      titleEl.addEventListener('click', () => this.openChatHistoryFile());
    }
  }

  openChatHistoryFile() {
    this.chatHistoryManager.openChatHistoryFile();
  }

  async handleMessage(message: string) {
    if (!this.chatFile) {
      // This is the first message, create a new chat file
      this.chatFile = await this.createChatFile(message);
      this.updateChatTitle(this.chatFile.basename);
      this.chatModule.saveLastOpenedChat(this.chatFile.path);
    } else {
      await this.updateChatFile(message);
    }
    const userMessage = new ChatMessage('user', message);
    this.addMessage(userMessage);
    await this.updateTokenCount();
  }

  private getNextChatFile(): TFile | null {
    const allChatFiles = this.app.vault
      .getFiles()
      .filter(
        file =>
          file.path.startsWith(this.chatModule.settings.chatsPath) &&
          !file.path.includes('/Archive/') &&
          file.extension === 'md'
      )
      .sort((a, b) => a.basename.localeCompare(b.basename));

    const currentIndex = this.chatFile
      ? allChatFiles.findIndex(file => file.path === this.chatFile!.path)
      : -1;
    if (currentIndex !== -1 && currentIndex < allChatFiles.length - 1) {
      return allChatFiles[currentIndex + 1];
    } else if (currentIndex > 0) {
      return allChatFiles[currentIndex - 1];
    }

    return allChatFiles.length > 0 ? allChatFiles[0] : null;
  }

  async archiveChat() {
    if (!this.chatFile) return;

    const currentChatFile = this.chatFile;
    this.chatFile = null; // Clear the current chat file reference

    try {
      const archivePath = `${this.chatModule.settings.chatsPath}/Archive`;
      await this.app.vault.createFolder(archivePath).catch(() => {});
      const newFilePath = `${archivePath}/${currentChatFile.name}`;
      await this.app.fileManager.renameFile(currentChatFile, newFilePath);

      showCustomNotice(`Archived '${currentChatFile.basename}' successfully!`);

      const nextChatFile = this.getNextChatFile();
      if (nextChatFile) {
        this.chatFile = nextChatFile;
        await this.visualReload();
      } else {
        await this.handleNoMoreChats(
          "All tidy! You've archived all your chats; here's a fresh start."
        );
      }
    } catch (error) {
      logger.error('Error archiving chat file:', error);
      showCustomNotice(
        `Failed to archive '${currentChatFile.basename}'. Error: ${error.message}`
      );
      this.chatFile = currentChatFile; // Restore the chat file reference if archiving failed
    }
  }

  async deleteChat() {
    if (!this.chatFile) return;

    const currentChatFile = this.chatFile;
    this.chatFile = null; // Clear the current chat file reference

    try {
      await this.app.vault.delete(currentChatFile);
      showCustomNotice(`Deleted '${currentChatFile.basename}' successfully!`);

      const nextChatFile = this.getNextChatFile();
      if (nextChatFile) {
        this.chatFile = nextChatFile;
        await this.visualReload();
      } else {
        await this.handleNoMoreChats(
          "All clean! You've deleted all your chats; here's a fresh start."
        );
      }
    } catch (error) {
      logger.error('Error deleting chat file:', error);
      showCustomNotice(
        `Failed to delete '${currentChatFile.basename}'. Error: ${error.message}`
      );
      this.chatFile = currentChatFile; // Restore the chat file reference if deletion failed
    }
  }

  private async handleNoMoreChats(message: string) {
    await this.chatModule.openNewChat();
    this.initializeChatView();
    await this.visualReload();
    showCustomNotice(message);
  }

  async openRandomChat() {
    const chatFiles = this.app.vault
      .getFiles()
      .filter(
        file =>
          file.path.startsWith(this.chatModule.settings.chatsPath) &&
          !file.path.includes('/Archive/') &&
          file.extension === 'md'
      );

    if (chatFiles.length === 0) {
      this.chatModule.openNewChat();
      showCustomNotice(
        "You don't seem to have any chat history yet; here's a new chat for you!"
      );
      return;
    }

    const randomChatFile =
      chatFiles[Math.floor(Math.random() * chatFiles.length)];
    this.setChatFile(randomChatFile);
    await this.loadChatFile(randomChatFile);
    this.chatModule.saveLastOpenedChat(randomChatFile.path);
  }

  private openContextFilesSearch() {
    const fileSearcher = new FileSearcher(this.app);
    fileSearcher.setPlaceholder('Search for context files');
    fileSearcher.onChooseItem = (file: TFile) => {
      this.contextFileManager.addFileToContextFiles(file);
    };
    fileSearcher.open();
  }

  openFileSearcher(
    inputEl?: HTMLTextAreaElement,
    addToContextFiles: boolean = false
  ) {
    attachFileSearcherListeners(this, inputEl, addToContextFiles);
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText() {
    return 'SystemSculpt AI Chat';
  }

  getIcon() {
    return 'messages-square';
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.innerHTML = chatTemplate;

    this.attachEventListeners(container as HTMLElement);
    this.attachListeners();

    // Defer non-critical operations
    setTimeout(() => {
      this.initializeChatView();
      this.focusInput();
    }, 0);
  }

  public initializeChatView() {
    this.chatFile = null;
    this.chatMessages = [];
    this.contextFiles = [];

    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl) {
      titleEl.textContent = moment().format('YYYY-MM-DD HH-mm-ss');
    }

    // Defer token count update
    setTimeout(() => {
      this.updateTokenCount();
    }, 0);
  }

  public clearChatView() {
    const messagesContainer = this.containerEl.querySelector('.chat-messages');
    if (messagesContainer) {
      messagesContainer.innerHTML = '';
    }

    const contextFilesContainer = this.containerEl.querySelector('.context-files');
    if (contextFilesContainer) {
      contextFilesContainer.innerHTML = '';
    }

    const inputEl = this.containerEl.querySelector('.chat-input') as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = '';
    }

    this.updateTokenCount();
  }

  handleExitButtonClick(exitButton: HTMLElement) {
    if (exitButton.classList.contains('confirm-exit')) {
      this.leaf.detach();
    } else {
      exitButton.classList.add('confirm-exit');
      exitButton.innerHTML = 'You sure? ❌';
      setTimeout(() => {
        exitButton.classList.remove('confirm-exit');
        exitButton.innerHTML = '❌';
      }, 3000);
    }
  }

  openChatHistory() {
    this.chatHistoryManager.openChatHistory();
  }

  async loadChatFile(file: TFile) {
    await this.chatHistoryManager.loadChatFile(file);
  }

  setChatFile(file: TFile) {
    this.chatFile = file;
    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl) {
      titleEl.textContent = file.basename;
    }
  }

  attachEventListeners(container: HTMLElement) {
    attachEventListeners(this);
  }

  async getTokenCount(): Promise<number> {
    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    const inputText = inputEl ? inputEl.value : '';
    return this.tokenManager.getTokenCount(
      this.chatMessages,
      this.contextFiles,
      inputText
    );
  }

  adjustInputHeight(inputEl: HTMLTextAreaElement) {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 250)}px`;
  }

  detectFileLink(inputEl: HTMLTextAreaElement) {
    const value = inputEl.value;
    if (value.endsWith('[[')) {
      this.openFileSearcher(inputEl, true);
    }
  }

  async constructMessageHistory(): Promise<
    { role: string; content: string }[]
  > {
    const messageHistory = this.chatMessages.map(msg => ({
      role: msg.role,
      content: msg.text,
    }));

    const contextFilesContent = await this.tokenManager.getContextFilesContent(
      this.contextFiles
    );
    if (contextFilesContent) {
      messageHistory.unshift({
        role: 'user',
        content: `CONTEXT FILES:\n${contextFilesContent}`,
      });
    }

    return messageHistory;
  }

  showLoading() {
    this.toggleLoadingState(true);
  }

  hideLoading() {
    this.toggleLoadingState(false);
  }

  private toggleLoadingState(isLoading: boolean) {
    const loadingContainer = this.containerEl.querySelector(
      '.loading-container'
    ) as HTMLElement;
    const chatInputContainer = this.containerEl.querySelector(
      '.chat-input-container'
    ) as HTMLElement;
    if (loadingContainer && chatInputContainer) {
      chatInputContainer.style.display = isLoading ? 'none' : 'flex';
      loadingContainer.style.display = isLoading ? 'flex' : 'none';
      loadingContainer.classList.toggle('visible', isLoading);
      if (!isLoading) {
        this.focusInput();
      }
    }
  }

  appendToLastMessage(content: string) {
    const lastMessage = this.chatMessages[this.chatMessages.length - 1];
    if (lastMessage && lastMessage.role === 'ai') {
      lastMessage.text += content;
      this.renderMessages();
    } else {
      const aiMessage = new ChatMessage('ai', content);
      this.addMessage(aiMessage);
    }
  }

  updateLastMessage(content: string) {
    const lastMessage = this.chatMessages[this.chatMessages.length - 1];
    if (lastMessage && lastMessage.role === 'ai') {
      lastMessage.text = content;
      this.renderMessages();
    } else {
      const aiMessage = new ChatMessage('ai', content);
      this.addMessage(aiMessage);
    }
  }

  renderMessages() {
    const messagesContainer = this.containerEl.querySelector('.chat-messages');
    if (messagesContainer instanceof HTMLElement) {
      renderMessages(
        this.chatMessages,
        messagesContainer,
        this.deleteMessage.bind(this)
      );
    }
  }

  async deleteMessage(index: number) {
    const deletedMessage = this.chatMessages.splice(index, 1)[0];
    this.renderMessages();
    this.updateTokenCount();

    if (this.chatFile) {
      await this.updateChatFileAfterDeletion(deletedMessage, index);
    }
  }

  async updateChatFileAfterDeletion(
    deletedMessage: ChatMessage,
    index: number
  ) {
    if (this.chatFile) {
      await this.chatFileManager.updateChatFileAfterDeletion(
        this.chatFile,
        deletedMessage,
        index
      );
      await this.loadChatFile(this.chatFile);
    }
  }

  addMessage(message: ChatMessage) {
    this.chatMessages.push(message);
    this.renderMessages();
    this.updateTokenCount();
  }

  async createChatFile(initialMessage: string) {
    this.chatFile = await this.chatFileManager.createChatFile(
      initialMessage,
      this.contextFiles
    );
    return this.chatFile;
  }

  async updateChatFile(content: string) {
    if (this.chatFile) {
      await this.chatFileManager.updateChatFile(this.chatFile, content);
      await this.loadChatFile(this.chatFile);
    } else {
      logger.error('No chat file to update');
    }
  }

  async onFileChange(file: TFile) {
    if (this.chatFile && file.path === this.chatFile.path) {
      await this.loadChatFile(file);
    }
  }

  async onFileRename(file: TFile, oldPath: string) {
    if (this.chatFile && file.path === this.chatFile.path) {
      this.setChatFile(file);
    }
  }

  focusInput() {
    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.focus();
    }
  }

  async updateTokenCount() {
    const tokenCount = await this.getTokenCount();
    this.tokenManager.displayTokenCount(
      tokenCount,
      this.containerEl,
      this.chatMessages.length
    );
  }

  async updateTokenCountWithInput(input: string) {
    const tokenCount = await this.tokenManager.getTokenCount(
      this.chatMessages,
      this.contextFiles,
      input
    );
    this.tokenManager.displayTokenCount(
      tokenCount,
      this.containerEl,
      this.chatMessages.length
    );
  }

  setChatInputValue(value: string) {
    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = value;
    }
  }

  async openCostEstimator() {
    const tokenCount = await this.tokenManager.getTokenCount(
      this.chatMessages,
      this.contextFiles,
      ''
    );
    const costEstimator = new CostEstimator(
      this.app,
      this.brainModule.settings.defaultModelId,
      tokenCount,
      this.brainModule.settings.maxTokens
    );
    costEstimator.open();
  }

  showActionsModal() {
    new ActionsModal(this.app, this).open();
  }

  async handleEditTitle() {
    if (this.chatFile) {
      await toggleEditTitle(
        this.app,
        this.chatFile,
        this.chatFile.basename,
        (newTitle: string) => this.updateChatTitle(newTitle)
      );
    }
  }

  async handleGenerateTitle() {
    if (this.chatFile) {
      await generateTitleForChat(
        this.app,
        this.chatFile,
        this.brainModule,
        (newTitle: string) => this.updateChatTitle(newTitle)
      );
    }
  }

  updateChatTitle(title: string) {
    updateChatTitle(this.containerEl, title);
    if (this.chatFile) {
      this.setChatFile(this.chatFile);
    }
  }

  async visualReload() {
    if (this.chatFile) {
      await this.loadChatFile(this.chatFile);
    }
    this.renderMessages();
    this.updateTokenCount();
    this.contextFileManager.renderContextFiles();

    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl && this.chatFile) {
      titleEl.textContent = this.chatFile.basename;
    }

    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = '';
    }

    this.focusInput();
  }
}
