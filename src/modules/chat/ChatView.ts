import { ItemView, WorkspaceLeaf, TFile, Notice, TFolder } from "obsidian";
import moment from "moment";
import { ChatMessage } from "./ChatMessage";
import { BrainModule } from "../brain/BrainModule";
import { ChatModule } from "./ChatModule";
import { renderMessages } from "./functions/renderMessages";
import { chatTemplate } from "./ChatTemplate";
import { TokenManager } from "./TokenManager";
import { ChatHistoryManager } from "./ChatHistoryManager";
import { ContextFileManager } from "./ContextFileManager";
import { ChatFileManager } from "./ChatFileManager";
import {
  attachEventListeners,
  attachFileSearcherListeners,
} from "./functions/EventListeners";
import { ActionsModal } from "./views/ActionsModal";
import {
  toggleEditTitle,
  generateTitleForChat,
  updateChatTitle,
} from "./functions/generateTitleForChat";
import { FileSearcher } from "./FileSearcher";
import { formatNumber } from "./utils";
import { CostEstimator } from "../../interfaces/CostEstimatorModal";
import { SaveChatAsNoteModal } from "./views/SaveChatAsNoteModal";

export const VIEW_TYPE_CHAT = "chat-view";

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
  private userScrolledUp: boolean = false;

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
    this.brainModule.on("model-changed", async () => {
      await this.updateTokenCount();
    });

    this.brainModule.on("cost-estimate-updated", ({ minCost, maxCost }) => {
      this.updateCostEstimate(minCost, maxCost);
    });
  }

  private updateCostEstimate(minCost: number, maxCost: number) {
    const costEstimateEl = this.containerEl.querySelector(
      ".systemsculpt-cost-estimate"
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
    const inputEl = this.containerEl.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.addEventListener("paste", this.handleFilePaste.bind(this));
    }
  }

  private async handleFilePaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return;

    const files: File[] = Array.from(items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    if (files.length > 0) {
      event.preventDefault();
      this.initializeLoadingContainer();
      this.resetLoadingContainer();
      this.showLoadingContainer(
        `Processing ${files.length} file${files.length > 1 ? "s" : ""}...`
      );

      for (let i = 0; i < files.length; i++) {
        await this.processFile(files[i]);
        this.updateLoadingProgress(i + 1, files.length);
      }
    }
  }

  private resetLoadingContainer() {
    if (this.loadingText) {
      this.loadingText.textContent = "";
    }
    if (this.progressText) {
      this.progressText.textContent = "";
    }
    if (this.progressBarFill) {
      this.progressBarFill.style.width = "0%";
    }
  }

  private showLoadingContainer(text: string) {
    if (this.loadingText) {
      this.loadingText.textContent = text;
    }
    const loadingOverlay = this.containerEl.querySelector(
      ".systemsculpt-loading-overlay"
    );
    if (loadingOverlay) {
      loadingOverlay.classList.add("visible");
    }
  }

  private updateLoadingProgress(current: number, total: number) {
    if (this.progressText) {
      this.progressText.textContent = `${current} / ${total} file${total > 1 ? "s" : ""} processed`;
    }
    if (this.progressBarFill) {
      const percentage = (current / total) * 100;
      this.progressBarFill.style.width = `${percentage}%`;
    }
  }

  private hideLoadingContainer() {
    const loadingOverlay = this.containerEl.querySelector(
      ".systemsculpt-loading-overlay"
    );
    if (loadingOverlay) {
      loadingOverlay.classList.remove("visible");
    }
  }

  private async processFile(file: File | TFile): Promise<void> {
    try {
      this.showLoadingContainer(`Processing file: ${file.name}`);
      let newFile: TFile;

      if (file instanceof File) {
        newFile = await this.saveDroppedFile(file);
      } else {
        newFile = file;
      }

      this.updateLoadingProgress(50, 100);
      await this.contextFileManager.addFileToContextFiles(newFile);
      this.updateLoadingProgress(100, 100);
      this.updateLoadingText(`File processed: ${newFile.name}`);
    } catch (error) {
      console.error("Error processing file:", error);
      this.updateLoadingText(
        `Error processing file: ${(error as Error).message}`
      );
    } finally {
      this.hideLoadingContainer();
    }
  }

  private async saveDroppedFile(file: File): Promise<TFile> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const path = `${this.chatModule.settings.attachmentsPath}/${file.name}`;
      const existingFile = this.app.vault.getAbstractFileByPath(path);

      if (existingFile instanceof TFile) {
        console.log(`Existing file found. Overwriting: ${path}`);
        await this.app.vault.modifyBinary(existingFile, arrayBuffer);
        return existingFile;
      } else {
        console.log(`Creating new file: ${path}`);
        return await this.app.vault.createBinary(path, arrayBuffer);
      }
    } catch (error) {
      console.error("Error saving dropped file:", error);
      throw error;
    }
  }

  private updateLoadingText(text: string) {
    if (this.loadingText) {
      this.loadingText.textContent = text;
    }
  }

  private attachContextFilesButtonListener() {
    const contextFilesButton = this.containerEl.querySelector(
      ".systemsculpt-context-files-header"
    ) as HTMLElement;
    if (contextFilesButton) {
      contextFilesButton.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.openContextFilesSearch();
      });
    }
  }

  private attachChatTitleListener() {
    const titleEl = this.containerEl.querySelector(
      ".systemsculpt-chat-title-text"
    ) as HTMLElement;
    if (titleEl) {
      titleEl.style.cursor = "pointer";
      titleEl.addEventListener("click", () => this.openChatHistoryFile());
    }
  }

  openChatHistoryFile() {
    this.chatHistoryManager.openChatHistoryFile();
  }

  async handleMessage(message: string) {
    if (!this.chatFile) {
      this.chatFile = await this.createChatFile(message);
      this.updateChatTitle(this.chatFile.basename);
      this.chatModule.saveLastOpenedChat(this.chatFile.path);
    } else {
      await this.updateChatFile(message);
    }
    const userMessage = new ChatMessage("user", message);
    this.addMessage(userMessage);
    await this.updateTokenCount();
  }

  private getNextChatFile(): TFile | null {
    const allChatFiles = this.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.path.startsWith(this.chatModule.settings.chatsPath) &&
          !file.path.includes("/Archive/") &&
          file.extension === "md"
      )
      .sort((a, b) => a.basename.localeCompare(b.basename));

    const currentIndex = this.chatFile
      ? allChatFiles.findIndex((file) => file.path === this.chatFile!.path)
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
    this.chatFile = null;

    try {
      const archivePath = `${this.chatModule.settings.chatsPath}/Archive`;
      await this.app.vault.createFolder(archivePath).catch(() => {});
      const newFilePath = `${archivePath}/${currentChatFile.name}`;
      await this.app.fileManager.renameFile(currentChatFile, newFilePath);

      this.updateLoadingText(
        `Archived '${currentChatFile.basename}' successfully!`
      );

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
      console.error("Error archiving chat file:", error);
      this.updateLoadingText(
        `Failed to archive '${currentChatFile.basename}'. Error: ${
          (error as Error).message
        }`
      );
      this.chatFile = currentChatFile;
    }
  }

  async deleteChat() {
    if (!this.chatFile) return;

    const currentChatFile = this.chatFile;
    this.chatFile = null;

    try {
      await this.app.vault.delete(currentChatFile);
      this.updateLoadingText(
        `Deleted '${currentChatFile.basename}' successfully!`
      );

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
      console.error("Error deleting chat file:", error);
      this.updateLoadingText(
        `Failed to delete '${currentChatFile.basename}'. Error: ${
          (error as Error).message
        }`
      );
      this.chatFile = currentChatFile;
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
        (file) =>
          file.path.startsWith(this.chatModule.settings.chatsPath) &&
          !file.path.includes("/Archive/") &&
          file.extension === "md"
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
    fileSearcher.setPlaceholder("Search for context files or folders");
    fileSearcher.onChooseItems = async (items: (TFile | TFolder)[]) => {
      for (const item of items) {
        if (item instanceof TFolder) {
          await this.contextFileManager.addDirectoryToContextFiles(item);
        } else {
          await this.contextFileManager.addFileToContextFiles(item);
        }
      }
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
    return "SystemSculpt AI Chat";
  }

  getIcon() {
    return "messages-square";
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.innerHTML = chatTemplate;

    this.initializeLoadingContainer();
    this.attachEventListeners(container as HTMLElement);
    this.attachListeners();
    this.attachDragAndDropListeners(container);
    this.attachScrollListener();

    setTimeout(() => {
      this.initializeChatView();
      this.focusInput(true);
    }, 0);
  }

  private initializeLoadingContainer() {
    this.loadingContainer = this.containerEl.querySelector(
      ".systemsculpt-loading-container"
    ) as HTMLElement;
    this.loadingText = this.loadingContainer.querySelector(
      ".systemsculpt-loading-text"
    ) as HTMLElement;
    this.progressText = this.loadingContainer.querySelector(
      ".systemsculpt-progress-text"
    ) as HTMLElement;
    this.progressBarFill = this.loadingContainer.querySelector(
      ".systemsculpt-progress-bar-fill"
    ) as HTMLElement;
  }

  private attachDragAndDropListeners(container: HTMLElement) {
    container.addEventListener("dragover", this.handleDragOver.bind(this));
    container.addEventListener("drop", this.handleDrop.bind(this));
  }

  private handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  }

  private async handleDrop(e: DragEvent) {
    e.preventDefault();
    console.log("Drop event triggered");

    const items = e.dataTransfer!.items;
    console.log("Dropped items:", items);

    const files: File[] = [];
    const stringItems: DataTransferItem[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log("Processing item:", item);

      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      } else if (item.kind === "string") {
        stringItems.push(item);
      }
    }

    if (files.length > 0) {
      this.resetLoadingContainer();
      this.showLoadingContainer(
        `Processing ${files.length} file${files.length > 1 ? "s" : ""}...`
      );

      for (let i = 0; i < files.length; i++) {
        await this.processFile(files[i]);
        this.updateLoadingProgress(i + 1, files.length);
      }
    }

    for (const item of stringItems) {
      item.getAsString(async (data) => {
        console.log("Dropped string content:", data);
        await this.handleDroppedString(data);
      });
    }
  }

  private async handleDroppedString(data: string) {
    const match = data.match(/obsidian:\/\/open\?vault=.*?&file=(.*)$/);
    if (match) {
      let filePath = decodeURIComponent(match[1]);
      if (!filePath.includes(".")) {
        filePath += ".md";
      }
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        console.log("Adding file from Obsidian URI to context:", file.path);
        this.showLoadingContainer(`Processing file: ${file.name}`);
        try {
          await this.processFile(file);
        } catch (error) {
          console.error("Error processing file:", error);
          this.updateLoadingText(
            `Error processing file: ${(error as Error).message}`
          );
        } finally {
          this.hideLoadingContainer();
        }
      } else {
        console.log("File not found:", filePath);
        this.updateLoadingText(`File not found: ${filePath}`);
      }
    } else {
      console.log("Invalid Obsidian URI:", data);
      this.updateLoadingText(`Invalid Obsidian URI: ${data}`);
    }
  }

  public initializeChatView() {
    this.chatFile = null;
    this.chatMessages = [];
    this.contextFiles = [];

    const titleEl = this.containerEl.querySelector(
      ".systemsculpt-chat-title-text"
    ) as HTMLElement;
    if (titleEl) {
      titleEl.textContent = moment().format("YYYY-MM-DD HH-mm-ss");
    }

    this.initializeTokenCountAndCost();
    this.scrollToBottom();
  }

  private async initializeTokenCountAndCost() {
    const tokenCount = 0;
    const currentModel = this.brainModule.getCurrentModel();
    const maxOutputTokens = this.brainModule.getMaxOutputTokens();

    if (currentModel) {
      this.tokenManager.displayTokenCount(
        tokenCount,
        this.containerEl,
        this.chatMessages.length,
        currentModel,
        maxOutputTokens
      );
    }
  }

  public clearChatView() {
    const messagesContainer = this.containerEl.querySelector(
      ".systemsculpt-chat-messages"
    );
    if (messagesContainer) {
      messagesContainer.innerHTML = "";
    }

    const contextFilesContainer = this.containerEl.querySelector(
      ".systemsculpt-context-files"
    );
    if (contextFilesContainer) {
      contextFilesContainer.innerHTML = "";
    }

    const inputEl = this.containerEl.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = "";
    }

    this.updateTokenCount();
  }

  handleExitButtonClick(exitButton: HTMLElement) {
    if (exitButton.classList.contains("systemsculpt-confirm-exit")) {
      this.leaf.detach();
    } else {
      exitButton.classList.add("systemsculpt-confirm-exit");
      exitButton.innerHTML = "You sure? ❌";
      setTimeout(() => {
        exitButton.classList.remove("systemsculpt-confirm-exit");
        exitButton.innerHTML = "❌";
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
      ".systemsculpt-chat-title-text"
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
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.addEventListener("input", () => {
        this.updateTokenCountAndCost();
      });
    }
  }

  public async updateTokenCountAndCost() {
    const inputEl = this.containerEl.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    const inputValue = inputEl ? inputEl.value : "";
    const tokenCount = await this.tokenManager.getTokenCount(
      this.chatMessages,
      this.contextFiles,
      inputValue
    );
    const currentModel = this.brainModule.getCurrentModel();
    const maxOutputTokens = this.brainModule.getMaxOutputTokens();
    this.tokenManager.displayTokenCount(
      tokenCount,
      this.containerEl,
      this.chatMessages.length,
      currentModel,
      maxOutputTokens
    );
  }

  async getTokenCount(): Promise<number> {
    const inputEl = this.containerEl.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    const inputText = inputEl ? inputEl.value : "";
    return this.tokenManager.getTokenCount(
      this.chatMessages,
      this.contextFiles,
      inputText
    );
  }

  adjustInputHeight(inputEl: HTMLTextAreaElement) {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 250)}px`;
  }

  public updateTokenCountWithInput(inputValue: string) {
    const inputEl = this.containerEl.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = inputValue;
      this.updateTokenCountAndCost();
    }
  }

  detectFileLink(inputEl: HTMLTextAreaElement) {
    const value = inputEl.value;
    if (value.endsWith("[[")) {
      this.openFileSearcher(inputEl, true);
    }
  }

  async constructMessageHistory(): Promise<
    {
      role: string;
      content:
        | string
        | { type: string; text?: string; image_url?: { url: string } }[];
    }[]
  > {
    const messageHistory = this.chatMessages.map((msg) => ({
      role: msg.role,
      content: msg.text,
    }));

    const contextFilesContent = await this.tokenManager.getContextFilesContent(
      this.contextFiles
    );

    if (contextFilesContent.text || contextFilesContent.images.length > 0) {
      const userContent: {
        type: string;
        text?: string;
        image_url?: { url: string };
      }[] = [];

      if (contextFilesContent.text) {
        userContent.push({
          type: "text",
          text: `CONTEXT FILES:\n${contextFilesContent.text}`,
        });
      }

      contextFilesContent.images.forEach((image) => {
        userContent.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${image.base64}`,
          },
        });
      });

      messageHistory.unshift({
        role: "user",
        content: userContent as unknown as string,
      });
    }

    return messageHistory;
  }

  showLoading() {
    const messagesContainer = this.containerEl.querySelector(
      ".systemsculpt-chat-messages"
    );
    if (messagesContainer instanceof HTMLElement) {
      const loadingEl = document.createElement("div");
      loadingEl.className =
        "systemsculpt-chat-message systemsculpt-ai systemsculpt-loading";
      loadingEl.innerHTML = `
        <div class="systemsculpt-chat-message-content">
          <div class="systemsculpt-loading-spinner"></div>
          <span>AI is thinking...</span>
        </div>
      `;
      messagesContainer.appendChild(loadingEl);
      this.scrollToBottom();
    }

    const inputContainer = this.containerEl.querySelector(
      ".systemsculpt-chat-input-container"
    ) as HTMLElement;
    const loadingSpinner = inputContainer.querySelector(
      ".systemsculpt-chat-input-loading"
    );
    if (loadingSpinner) {
      loadingSpinner.classList.remove("systemsculpt-hidden");
    }
    const chatInputWrapper = inputContainer.querySelector(
      ".systemsculpt-chat-input-wrapper"
    );
    if (chatInputWrapper) {
      chatInputWrapper.classList.add("systemsculpt-hidden");
    }
  }

  hideLoading() {
    const loadingEl = this.containerEl.querySelector(
      ".systemsculpt-chat-message.systemsculpt-ai.systemsculpt-loading"
    );
    if (loadingEl) {
      loadingEl.remove();
    }

    const inputContainer = this.containerEl.querySelector(
      ".systemsculpt-chat-input-container"
    ) as HTMLElement;
    const loadingSpinner = inputContainer.querySelector(
      ".systemsculpt-chat-input-loading"
    );
    if (loadingSpinner) {
      loadingSpinner.classList.add("systemsculpt-hidden");
    }
    const chatInputWrapper = inputContainer.querySelector(
      ".systemsculpt-chat-input-wrapper"
    );
    if (chatInputWrapper) {
      chatInputWrapper.classList.remove("systemsculpt-hidden");
    }

    this.focusInput();
  }

  appendToLastMessage(content: string) {
    const lastMessage = this.chatMessages[this.chatMessages.length - 1];
    if (lastMessage && lastMessage.role === "ai") {
      lastMessage.text += content;
      this.renderMessages();
    } else {
      const aiMessage = new ChatMessage("ai", content);
      this.addMessage(aiMessage);
    }
  }

  updateLastMessage(content: string) {
    const lastMessage = this.chatMessages[this.chatMessages.length - 1];
    if (lastMessage && lastMessage.role === "ai") {
      lastMessage.text = content;
      this.renderMessages();
    } else {
      const aiMessage = new ChatMessage("ai", content);
      this.addMessage(aiMessage);
    }
  }

  renderMessages() {
    const messagesContainer = this.containerEl.querySelector(
      ".systemsculpt-chat-messages"
    );
    if (messagesContainer instanceof HTMLElement) {
      renderMessages(
        this.chatMessages,
        messagesContainer,
        this.deleteMessage.bind(this)
      );

      if (!this.userScrolledUp) {
        this.scrollToBottom();
      }
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
      throw new Error("ChatModule is not initialized");
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
      console.error("No chat file to update");
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

  focusInput(initialLoad: boolean = false) {
    if (initialLoad) {
      const inputEl = this.containerEl.querySelector(
        ".systemsculpt-chat-input"
      ) as HTMLTextAreaElement;
      if (inputEl) {
        inputEl.focus();
      }
    }
  }

  async updateTokenCount() {
    await this.updateTokenCountAndCost();
  }

  setChatInputValue(value: string) {
    const inputEl = this.containerEl.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = value;
    }
  }

  async openCostEstimator() {
    const tokenCount = await this.tokenManager.getTokenCount(
      this.chatMessages,
      this.contextFiles,
      ""
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
      ".systemsculpt-chat-title-text"
    ) as HTMLElement;
    if (titleEl && this.chatFile) {
      titleEl.textContent = this.chatFile.basename;
    }

    const inputEl = this.containerEl.querySelector(
      ".systemsculpt-chat-input"
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = "";
    }

    this.focusInput();
  }

  scrollToBottom() {
    const messagesContainer = this.containerEl.querySelector(
      ".systemsculpt-chat-messages"
    );
    if (messagesContainer instanceof HTMLElement) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }

  async processDocument(file: TFile) {
    await this.contextFileManager.processDocument(file);
    await this.contextFileManager.addFileToContextFiles(file);
    this.updateTokenCount();
    this.scrollToBottom();
  }

  public async addFileToContext(file: TFile) {
    this.initializeLoadingContainer();
    this.resetLoadingContainer();
    this.showLoadingContainer(`Processing file: ${file.name}`);

    try {
      await this.processFile(file);
      this.updateLoadingProgress(1, 1);
    } catch (error) {
      console.error("Error processing file:", error);
      this.updateLoadingText(
        `Error processing file: ${(error as Error).message}`
      );
    } finally {
      this.hideLoadingContainer();
    }

    await this.updateTokenCountAndCost();
    this.scrollToBottom();
  }

  attachScrollListener() {
    const messagesContainer = this.containerEl.querySelector(
      ".systemsculpt-chat-messages"
    );
    if (messagesContainer instanceof HTMLElement) {
      messagesContainer.addEventListener("scroll", () => {
        const isScrolledToBottom =
          messagesContainer.scrollHeight - messagesContainer.clientHeight <=
          messagesContainer.scrollTop + 1;
        this.userScrolledUp = !isScrolledToBottom;
      });
    }
  }

  async saveChatAsNote() {
    if (this.chatMessages.length === 0) {
      new Notice("No chat messages to save.");
      return;
    }

    const fileName = `Chat Note ${moment().format("YYYY-MM-DD HH-mm-ss")}.md`;
    const folderPath = this.app.fileManager.getNewFileParent("").path;

    new SaveChatAsNoteModal(
      this.app,
      fileName,
      folderPath,
      async (newFileName: string, newFolderPath: string) => {
        let noteContent = "# Chat History\n\n";

        for (const message of this.chatMessages) {
          const role = message.role === "user" ? "User" : message.model || "AI";
          noteContent += `###### ${role}\n${message.text}\n\n`;
        }

        const filePath = `${newFolderPath}/${newFileName}`;

        try {
          const newFile = await this.app.vault.create(filePath, noteContent);
          new Notice(`Chat saved as note: ${newFileName}`);
          this.app.workspace.openLinkText(newFile.path, "", true);
        } catch (error) {
          console.error("Error saving chat as note:", error);
          new Notice("Failed to save chat as note. Check console for details.");
        }
      }
    ).open();
  }
}
