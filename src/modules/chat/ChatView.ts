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

export const VIEW_TYPE_CHAT = 'chat-view';

export class ChatView extends ItemView {
  chatMessages: ChatMessage[];
  brainModule: BrainModule;
  chatModule: ChatModule;
  chatFile: TFile;
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
    } else {
      console.error('Context Files button not found');
    }
  }

  private attachChatTitleListener() {
    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl) {
      titleEl.style.cursor = 'pointer';
      titleEl.addEventListener('click', () => {
        console.log('Chat title clicked'); // Add this line for debugging
        this.openChatHistoryFile();
      });
    } else {
      console.error('Chat title element not found'); // Add this line for debugging
    }
  }

  openChatHistoryFile() {
    console.log('Opening chat history file'); // Add this line for debugging
    this.chatHistoryManager.openChatHistoryFile();
  }

  async handleFirstMessage() {
    if (this.chatFile) {
      const fileName = this.chatFile.basename;
      this.updateChatTitle(fileName);
      await this.updateTokenCount();
      this.chatModule.saveLastOpenedChat(this.chatFile.path);
    }
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

    if (this.chatFile) {
      const currentIndex = allChatFiles.findIndex(
        file => file.path === this.chatFile.path
      );
      if (currentIndex !== -1 && currentIndex < allChatFiles.length - 1) {
        return allChatFiles[currentIndex + 1];
      } else if (currentIndex > 0) {
        return allChatFiles[currentIndex - 1];
      }
    }

    return allChatFiles.length > 0 ? allChatFiles[0] : null;
  }

  async archiveChat() {
    if (!this.chatFile) return;

    const nextChatFile = this.getNextChatFile();

    const archivePath = `${this.chatModule.settings.chatsPath}/Archive`;
    await this.app.vault.createFolder(archivePath).catch(() => {});
    const newFilePath = `${archivePath}/${this.chatFile.name}`;
    await this.app.fileManager.renameFile(this.chatFile, newFilePath);

    showCustomNotice(`Archived '${this.chatFile.basename}' successfully!`);

    if (nextChatFile) {
      this.chatFile = nextChatFile;
      await this.visualReload();
    } else {
      this.chatModule.openNewChat();
    }
  }

  async deleteChat() {
    if (!this.chatFile) return;

    const nextChatFile = this.getNextChatFile();

    await this.app.vault.delete(this.chatFile);
    showCustomNotice(`Deleted '${this.chatFile.basename}' successfully!`);

    if (nextChatFile) {
      this.chatFile = nextChatFile;
      await this.visualReload();
    } else {
      this.chatModule.openNewChat();
    }
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

    const randomIndex = Math.floor(Math.random() * chatFiles.length);
    const randomChatFile = chatFiles[randomIndex];

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
    container.createEl('div', { text: 'Loading chat...' });

    // Use setTimeout to ensure the DOM is fully rendered
    setTimeout(() => {
      container.empty();
      container.innerHTML = chatTemplate;
      this.attachEventListeners(container as HTMLElement);
      this.attachContextFilesButtonListener();
      this.attachChatTitleListener(); // Move this line here
    }, 0);

    // wait 100ms before focusing the input field
    setTimeout(() => {
      this.focusInput();
    }, 100);

    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (this.chatFile) {
      await this.loadChatFile(this.chatFile);
      if (titleEl) {
        const fileName = this.chatFile.basename;
        titleEl.textContent = fileName;
      }
    } else {
      // Set the title to the current date and time if no chat file exists
      if (titleEl) {
        titleEl.textContent = moment().format('YYYY-MM-DD HH-mm-ss');
      }
    }

    // Update token count initially
    this.updateTokenCount();
    this.attachChatTitleListener();
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
      const fileName = file.basename;
      titleEl.textContent = fileName;
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
    const loadingContainer = this.containerEl.querySelector(
      '.loading-container'
    ) as HTMLElement;
    const chatInputContainer = this.containerEl.querySelector(
      '.chat-input-container'
    ) as HTMLElement;
    if (loadingContainer && chatInputContainer) {
      chatInputContainer.style.display = 'none';
      loadingContainer.style.display = 'flex';
      loadingContainer.classList.add('visible');
    }
  }

  hideLoading() {
    const loadingContainer = this.containerEl.querySelector(
      '.loading-container'
    ) as HTMLElement;
    const chatInputContainer = this.containerEl.querySelector(
      '.chat-input-container'
    ) as HTMLElement;
    if (loadingContainer && chatInputContainer) {
      loadingContainer.style.display = 'none';
      loadingContainer.classList.remove('visible');
      chatInputContainer.style.display = 'flex';
      this.focusInput(); // Refocus the input field
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
    await this.chatFileManager.updateChatFileAfterDeletion(
      this.chatFile,
      deletedMessage,
      index
    );
    await this.loadChatFile(this.chatFile);
  }

  addMessage(message: ChatMessage) {
    this.chatMessages.push(message);

    this.renderMessages();
    this.updateTokenCount(); // Update token count after adding message
  }

  async createChatFile(initialMessage: string) {
    this.chatFile = await this.chatFileManager.createChatFile(
      initialMessage,
      this.contextFiles
    );
    return this.chatFile;
  }

  async updateChatFile(content: string) {
    await this.chatFileManager.updateChatFile(this.chatFile, content);
    await this.loadChatFile(this.chatFile); // Reload the chat file to update the view
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

    // Refresh the input field
    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = '';
    }

    this.focusInput();
  }
}
