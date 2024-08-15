import { ItemView, WorkspaceLeaf, TFile, moment, Notice } from 'obsidian';
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
import { ActionsModal } from './views/ActionsModal';
import {
  toggleEditTitle,
  generateTitleForChat,
  updateChatTitle,
} from './functions/generateTitleForChat';
import { FileSearcher } from './FileSearcher';
import { showCustomNotice } from '../../modals';
import { logger } from '../../utils/logger';
import { displayTokenCount, formatNumber } from './utils';
import { CostEstimator } from '../../interfaces/CostEstimatorModal';
import { PDFExtractor } from './PDFExtractor';

export const VIEW_TYPE_CHAT = 'chat-view';

export class ChatView extends ItemView {
  chatMessages: ChatMessage[];
  brainModule: BrainModule;
  chatModule: ChatModule;
  chatFile: TFile | null = null;
  contextFiles: TFile[] = [];
  public tokenManager!: TokenManager;
  public chatHistoryManager!: ChatHistoryManager;
  public contextFileManager!: ContextFileManager;
  public chatFileManager!: ChatFileManager;
  private loadingContainer!: HTMLElement;
  private loadingText!: HTMLElement;
  private progressText!: HTMLElement;
  private progressBarFill!: HTMLElement;

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
    this.listenForModelChanges();
  }

  public setChatModule(chatModule: ChatModule) {
    this.chatModule = chatModule;
    this.initializeManagers();
  }

  private listenForModelChanges() {
    this.brainModule.on('model-changed', async () => {
      await this.updateTokenCount();
    });

    this.brainModule.on('cost-estimate-updated', ({ minCost, maxCost }) => {
      this.updateCostEstimate(minCost, maxCost);
    });
  }

  private updateCostEstimate(minCost: number, maxCost: number) {
    const costEstimateEl = this.containerEl.querySelector(
      '.cost-estimate'
    ) as HTMLElement;
    if (costEstimateEl) {
      costEstimateEl.textContent = `Estimated Cost: $${formatNumber(
        minCost
      )} - $${formatNumber(maxCost)}`;
    }
  }

  private initializeManagers() {
    this.contextFileManager = new ContextFileManager(this.app, this);
    this.tokenManager = new TokenManager(this.app);
    this.chatHistoryManager = new ChatHistoryManager(
      this.app,
      this,
      this.contextFileManager,
      this.chatModule
    );
    this.chatFileManager = new ChatFileManager(this.app, this.chatModule);
  }

  private attachListeners() {
    this.attachContextFilesButtonListener();
    this.attachChatTitleListener();
    this.attachFilePasteListener();
  }

  private attachFilePasteListener() {
    const inputEl = this.containerEl.querySelector('.chat-input') as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.addEventListener('paste', this.handleFilePaste.bind(this));
    }
  }

  private async handleFilePaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return;

    event.preventDefault();

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0) return;

    this.resetLoadingContainer();
    this.showLoadingContainer(`Processing ${files.length} file${files.length > 1 ? 's' : ''}...`);
    this.updateLoadingProgress(0, files.length);

    for (let i = 0; i < files.length; i++) {
      await this.processPastedFile(files[i]);
      this.updateLoadingProgress(i + 1, files.length);
    }

    this.hideLoadingContainer();
  }

  private resetLoadingContainer() {
    this.loadingText.textContent = '';
    this.progressText.textContent = '';
    this.progressBarFill.style.width = '0%';
  }

  private showLoadingContainer(text: string) {
    this.loadingText.textContent = text;
    this.containerEl.querySelector('.loading-overlay')?.classList.add('visible');
  }

  private updateLoadingProgress(current: number, total: number) {
    this.progressText.textContent = `${current} / ${total} file${total > 1 ? 's' : ''} processed`;
    const percentage = (current / total) * 100;
    this.progressBarFill.style.width = `${percentage}%`;
  }

  private hideLoadingContainer() {
    this.containerEl.querySelector('.loading-overlay')?.classList.remove('visible');
  }

  private async processPastedFile(file: File) {
    const blob = new Blob([file], { type: file.type });
    if (file.type === 'application/pdf') {
      await this.processPDF(await this.saveTemporaryFile(blob, file.name));
    } else {
      await this.saveAndAddFileToContext(blob, file.name);
    }
  }

  private async saveTemporaryFile(blob: Blob, fileName: string): Promise<TFile> {
    const arrayBuffer = await blob.arrayBuffer();
    const tempPath = `${this.chatModule.settings.attachmentsPath}/${fileName}`;
    return await this.app.vault.createBinary(tempPath, arrayBuffer);
  }

  private async saveAndAddFileToContext(blob: Blob, fileName?: string) {
    const fileExtension = this.getFileExtension(blob.type);
    let finalFileName = fileName || `pasted_file_${Date.now()}.${fileExtension}`;
    finalFileName = finalFileName.replace(/\s+/g, '_'); // Replace spaces with underscores
    const baseName = finalFileName.replace(`.${fileExtension}`, '');
    const filePath = `${this.chatModule.settings.attachmentsPath}/${baseName}/${finalFileName}`;

    console.log(`Attempting to save file: ${filePath}`);

    try {
      // Ensure the directory exists
      await this.app.vault.adapter.mkdir(`${this.chatModule.settings.attachmentsPath}/${baseName}`);
      console.log(`Directory ensured: ${this.chatModule.settings.attachmentsPath}/${baseName}`);

      // Check if file exists and delete it
      const existingFile = this.app.vault.getAbstractFileByPath(filePath);
      if (existingFile instanceof TFile) {
        console.log(`Existing file found. Attempting to delete: ${filePath}`);
        await this.app.vault.delete(existingFile);
        
        // Wait for the file to be deleted
        let deletionAttempts = 0;
        while (this.app.vault.getAbstractFileByPath(filePath) && deletionAttempts < 10) {
          console.log(`Waiting for file deletion... Attempt ${deletionAttempts + 1}`);
          await new Promise(resolve => setTimeout(resolve, 100));
          deletionAttempts++;
        }
        
        if (this.app.vault.getAbstractFileByPath(filePath)) {
          throw new Error("Failed to delete existing file");
        }
        console.log(`Existing file deleted successfully`);
      } else {
        console.log(`No existing file found at ${filePath}`);
      }

      // Convert blob to ArrayBuffer
      const arrayBuffer = await blob.arrayBuffer();
      console.log(`Blob converted to ArrayBuffer`);

      // Write the new file
      console.log(`Attempting to create new file: ${filePath}`);
      const newFile = await this.app.vault.createBinary(filePath, arrayBuffer);

      if (newFile instanceof TFile) {
        console.log(`File created successfully: ${filePath}`);
        await this.contextFileManager.addFileToContextFiles(newFile);
        this.updateLoadingText(`File processed: ${finalFileName}`);
      } else {
        throw new Error("Failed to create file");
      }
    } catch (error) {
      console.error('Error saving pasted file:', error);
      // If the error is "File already exists", try to delete it and retry
      if ((error as Error).message === "File already exists.") {
        console.log("File already exists. Attempting to delete and retry...");
        try {
          const existingFile = this.app.vault.getAbstractFileByPath(filePath);
          if (existingFile instanceof TFile) {
            await this.app.vault.delete(existingFile);
            console.log("Existing file deleted. Retrying file creation...");
            const newFile = await this.app.vault.createBinary(filePath, await blob.arrayBuffer());
            if (newFile instanceof TFile) {
              console.log(`File created successfully on retry: ${filePath}`);
              await this.contextFileManager.addFileToContextFiles(newFile);
              this.updateLoadingText(`File processed: ${finalFileName}`);
              return;
            }
          }
        } catch (retryError) {
          console.error('Error during retry:', retryError);
        }
      }
      this.updateLoadingText(`Failed to save pasted file: ${(error as Error).message}`);
    }
  }

  private updateLoadingText(text: string) {
    this.loadingText.textContent = text;
  }

  private getFileExtension(mimeType: string): string {
    switch (mimeType) {
      case 'application/pdf':
        return 'pdf';
      case 'image/png':
        return 'png';
      case 'image/jpeg':
        return 'jpg';
      case 'image/gif':
        return 'gif';
      case 'audio/mpeg':
        return 'mp3';
      case 'audio/wav':
        return 'wav';
      case 'audio/x-m4a':
        return 'm4a';
      case 'audio/ogg':
        return 'ogg';
      default:
        return mimeType.split('/')[1] || 'unknown';
    }
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

      this.updateLoadingText(`Archived '${currentChatFile.basename}' successfully!`);

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
      this.updateLoadingText(
        `Failed to archive '${currentChatFile.basename}'. Error: ${
          (error as Error).message
        }`
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
      this.updateLoadingText(`Deleted '${currentChatFile.basename}' successfully!`);

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
      this.updateLoadingText(
        `Failed to delete '${currentChatFile.basename}'. Error: ${
          (error as Error).message
        }`
      );
      this.chatFile = currentChatFile; // Restore the chat file reference if deletion failed
    }
  }

  private async handleNoMoreChats(message: string) {
    await this.chatModule.openNewChat();
    this.initializeChatView();
    await this.visualReload();
    this.updateLoadingText(message);
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
      this.updateLoadingText(
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

    this.initializeLoadingContainer();
    this.attachEventListeners(container as HTMLElement);
    this.attachListeners();
    this.attachDragAndDropListeners(container);

    // Defer non-critical operations
    setTimeout(() => {
      this.initializeChatView();
      this.focusInput();
    }, 0);
  }

  private initializeLoadingContainer() {
    this.loadingContainer = this.containerEl.querySelector('.loading-container') as HTMLElement;
    this.loadingText = this.loadingContainer.querySelector('.loading-text') as HTMLElement;
    this.progressText = this.loadingContainer.querySelector('.progress-text') as HTMLElement;
    this.progressBarFill = this.loadingContainer.querySelector('.progress-bar-fill') as HTMLElement;
  }

  private attachDragAndDropListeners(container: HTMLElement) {
    container.addEventListener('dragover', this.handleDragOver.bind(this));
    container.addEventListener('drop', this.handleDrop.bind(this));
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  }

  private async handleDrop(e: DragEvent) {
    e.preventDefault();
    console.log('Drop event triggered');

    const items = e.dataTransfer!.items;
    console.log('Dropped items:', items);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log('Processing item:', item);

      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          await this.handleDroppedFile(file);
        }
      } else if (item.kind === 'string') {
        item.getAsString(async (data) => {
          console.log('Dropped string content:', data);
          await this.handleDroppedString(data);
        });
      }
    }
  }

  private async handleDroppedFile(file: File) {
    const obsidianFile = this.app.vault.getAbstractFileByPath(file.name);
    if (obsidianFile instanceof TFile) {
      console.log('Adding existing file to context:', obsidianFile.path);
      await this.contextFileManager.addFileToContextFiles(obsidianFile);
    } else {
      console.log('Saving new file and adding to context');
      const newFile = await this.saveDroppedFile(file);
      if (newFile) {
        await this.contextFileManager.addFileToContextFiles(newFile);
      }
    }
  }

  private async handleDroppedString(data: string) {
    const match = data.match(/obsidian:\/\/open\?vault=.*?&file=(.*)$/);
    if (match) {
      let filePath = decodeURIComponent(match[1]);
      // If the file doesn't have an extension, assume it's a markdown file
      if (!filePath.includes('.')) {
        filePath += '.md';
      }
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        console.log('Adding file from Obsidian URI to context:', file.path);
        await this.contextFileManager.addFileToContextFiles(file);
      } else {
        console.log('File not found:', filePath);
      }
    } else {
      console.log('Invalid Obsidian URI:', data);
    }
  }

  private async saveDroppedFile(file: File): Promise<TFile | null> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const path = `${this.chatModule.settings.attachmentsPath}/${file.name}`;
      const newFile = await this.app.vault.createBinary(path, arrayBuffer);
      return newFile;
    } catch (error) {
      console.error('Error saving dropped file:', error);
      return null;
    }
  }

  public initializeChatView() {
    this.chatFile = null;
    this.chatMessages = [];
    this.contextFiles = [];

    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl) {
      // Reason to ignore: works just fine, fixes seem to fuck things up tbh
      // @ts-ignore
      titleEl.textContent = moment().format('YYYY-MM-DD HH-mm-ss');
    }

    // Defer token count update
    setTimeout(() => {
      this.updateTokenCount();
    }, 0);

    this.scrollToBottom();
  }

  public clearChatView() {
    const messagesContainer = this.containerEl.querySelector('.chat-messages');
    if (messagesContainer) {
      messagesContainer.innerHTML = '';
    }

    const contextFilesContainer =
      this.containerEl.querySelector('.context-files');
    if (contextFilesContainer) {
      contextFilesContainer.innerHTML = '';
    }

    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
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
    this.scrollToBottom();
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
    this.attachInputChangeListener();
  }

  private attachInputChangeListener() {
    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.addEventListener('input', () => {
        this.updateTokenCountAndCost();
      });
    }
  }

  private async updateTokenCountAndCost() {
    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    const inputText = inputEl ? inputEl.value : '';
    const tokenCount = await this.tokenManager.getTokenCount(
      this.chatMessages,
      this.contextFiles,
      inputText
    );
    const currentModel = this.brainModule.getCurrentModel();
    if (currentModel) {
      displayTokenCount(
        tokenCount,
        this.containerEl,
        this.chatMessages.length,
        currentModel,
        this.brainModule.getMaxOutputTokens()
      );
      this.brainModule.updateCostEstimate(tokenCount);
    }
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
    { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[]
  > {
    const messageHistory = this.chatMessages.map(msg => ({
      role: msg.role,
      content: msg.text,
    }));

    const contextFilesContent = await this.tokenManager.getContextFilesContent(
      this.contextFiles
    );
    
    if (contextFilesContent.text || contextFilesContent.images.length > 0) {
      const userContent: { type: string; text?: string; image_url?: { url: string } }[] = [];
      
      if (contextFilesContent.text) {
        userContent.push({
          type: 'text',
          text: `CONTEXT FILES:\n${contextFilesContent.text}`,
        });
      }
      
      contextFilesContent.images.forEach(image => {
        userContent.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${image.base64}`
          }
        });
      });
      
      messageHistory.unshift({
        role: 'user',
        content: userContent as unknown as string, // Type assertion to satisfy TypeScript
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
      this.scrollToBottom();
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
    if (!this.chatModule) {
      throw new Error('ChatModule is not initialized');
    }
    this.chatFile = await this.chatModule.chatFileManager.createChatFile(
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
    await this.updateTokenCountAndCost();
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
    const currentModel = this.brainModule.getCurrentModel();
    if (currentModel) {
      const costEstimator = new CostEstimator(
        this.app,
        currentModel,
        tokenCount
      );
      costEstimator.open();
    } else {
      new Notice(
        "Couldn't find the current model. Please check your settings."
      );
    }
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

  scrollToBottom() {
    const messagesContainer = this.containerEl.querySelector('.chat-messages');
    if (messagesContainer instanceof HTMLElement) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  async processPDF(file: TFile) {
    await this.contextFileManager.processPDF(file);
    await this.contextFileManager.addFileToContextFiles(file);
    this.updateTokenCount();
    this.scrollToBottom();
    
    // Add a slight delay before refreshing the file explorer
    setTimeout(() => {
      this.app.workspace.trigger('file-menu');
    }, 100);
  }
}
