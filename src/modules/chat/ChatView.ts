import {
  MarkdownView,
  App,
  ItemView,
  WorkspaceLeaf,
  TFile,
  moment,
  FuzzySuggestModal,
} from 'obsidian';
import { ChatMessage } from './ChatMessage';
import { BrainModule } from '../brain/BrainModule';
import { encode } from 'gpt-tokenizer';
import { ChatModule } from './ChatModule';
import { marked } from 'marked';
import { showCustomNotice, hideCustomNotice } from '../../modals';
export const VIEW_TYPE_CHAT = 'chat-view';

export class ChatView extends ItemView {
  chatMessages: ChatMessage[];
  brainModule: BrainModule;
  chatModule: ChatModule;
  chatFile: TFile;
  contextFiles: TFile[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    brainModule: BrainModule,
    chatModule: ChatModule
  ) {
    super(leaf);
    this.chatMessages = [];
    this.brainModule = brainModule;
    this.chatModule = chatModule;
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

    const chatTemplate = document.createElement('template');
    chatTemplate.innerHTML = `
      <div class="chat-container">
        <div class="chat-header">
          SystemSculpt AI Chat
          <button class="history-button" title="Open Chat History">📂</button>
          <button class="history-file-button" title="Open Chat History File">📖</button>
          <button class="exit-button" title="Exit Chat">❌</button>
          <button class="new-chat-button" title="Start New Chat">🗒️</button>
        </div>
        <div class="chat-title">
          <div class="chat-title-container" style="display: none;">
            <span class="chat-title-text"></span>
            <span class="edit-icon" title="Edit Title">✏️</span>
            <span class="generate-title-icon" title="Generate Title">🔄</span>
          </div>
          <span class="token-count" style="display: none;">Tokens: 0</span>
        </div>
        <div class="chat-messages"></div>
        <div class="context-files-container">
          <div class="context-files-header" title="Add Context File" style="cursor: pointer;">
            <h3>Context Files ➕</h3>
          </div>
          <div class="context-files"></div>
        </div>
        <div class="chat-input-container">
          <textarea class="chat-input" placeholder="Type a message..."></textarea>
          <button class="chat-send-button" title="Send Message">Send</button>
        </div>
        <div class="loading-container">
          <div class="loading-spinner"></div>
        </div>
      </div>
    `;
    container.appendChild(chatTemplate.content.cloneNode(true));

    this.attachEventListeners(container as HTMLElement);

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

    // Add event listener for the exit button
    const exitButton = this.containerEl.querySelector(
      '.exit-button'
    ) as HTMLElement;
    if (exitButton) {
      exitButton.addEventListener('click', () =>
        this.handleExitButtonClick(exitButton)
      );
    }

    // Add event listener for the history button
    const historyButton = this.containerEl.querySelector(
      '.history-button'
    ) as HTMLElement;
    if (historyButton) {
      historyButton.addEventListener('click', () => this.openChatHistory());
    }

    // Add event listener for the new chat button
    const newChatButton = this.containerEl.querySelector(
      '.new-chat-button'
    ) as HTMLElement;
    if (newChatButton) {
      newChatButton.addEventListener('click', () =>
        this.chatModule.openNewChat()
      );
    }

    // Add event listener for the add context file button
    const contextFilesHeader = this.containerEl.querySelector(
      '.context-files-header'
    ) as HTMLElement;
    if (contextFilesHeader) {
      contextFilesHeader.addEventListener('click', () => {
        this.openFileSearcher(undefined, true);
      });
    }

    // Add event listener for the history file button
    const historyFileButton = this.containerEl.querySelector(
      '.history-file-button'
    ) as HTMLElement;
    if (historyFileButton) {
      historyFileButton.addEventListener('click', () =>
        this.openChatHistoryFile()
      );
    }
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
    const fileSearcher = new FileSearcher(
      this.app,
      this.chatModule.settings.chatsPath
    );
    fileSearcher.open();
    fileSearcher.onChooseItem = (file: TFile) => {
      this.setChatFile(file);
      this.loadChatFile(file);
    };
  }

  openChatHistoryFile() {
    if (this.chatFile) {
      const leaves = this.app.workspace.getLeavesOfType('markdown');
      for (const leaf of leaves) {
        const view = leaf.view;
        if (
          view instanceof MarkdownView &&
          view.file &&
          view.file.path === this.chatFile.path
        ) {
          this.app.workspace.revealLeaf(leaf);
          return;
        }
      }
      this.app.workspace.openLinkText(this.chatFile.path, '', true);
    }
  }

  async loadChatFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const messages: ChatMessage[] = [];
    this.contextFiles = []; // Clear existing context files

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
          !this.contextFiles.some(
            existingFile => existingFile.path === contextFile.path
          )
        ) {
          this.contextFiles.push(contextFile);
        }
      }
    }

    // Match all code blocks with user or ai roles
    const blockRegex = /`````\s*(user|ai)\s*([\s\S]*?)\s*`````/g;
    let match;

    while ((match = blockRegex.exec(content)) !== null) {
      const role = match[1] as 'user' | 'ai';
      const text = match[2].trim();
      messages.push(new ChatMessage(role, text));
    }

    this.chatMessages = messages;
    this.chatFile = file;
    this.renderMessages();
    this.renderContextFiles(); // Ensure context files are rendered
    this.updateTokenCountWithInput('');
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
    const inputEl = container.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    const sendButtonEl = container.querySelector(
      '.chat-send-button'
    ) as HTMLButtonElement;
    const editIconEl = container.querySelector('.edit-icon') as HTMLElement;
    const generateTitleIconEl = container.querySelector(
      '.generate-title-icon'
    ) as HTMLElement;

    sendButtonEl.addEventListener('click', () =>
      this.handleSendMessage(inputEl)
    );
    inputEl.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.handleSendMessage(inputEl);
      } else if (event.key === 'Enter' && event.shiftKey) {
        event.stopPropagation();
      }
    });

    // Add event listener to update token count as the user types
    inputEl.addEventListener('input', () => {
      this.updateTokenCountWithInput(inputEl.value);
      this.detectFileLink(inputEl);
      this.adjustInputHeight(inputEl); // Add this line
    });

    // Add event listener for the edit icon
    editIconEl.addEventListener('click', () => this.toggleEditTitle());

    // Add event listener for the generate title icon
    generateTitleIconEl.addEventListener('click', () =>
      this.generateTitleForChat()
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

  async generateTitleForChat() {
    if (!this.chatFile) return;
    const noteContent = await this.app.vault.read(this.chatFile);
    const notice = showCustomNotice('Generating Title...');
    const titleContainerEl = this.containerEl.querySelector(
      '.chat-title-container'
    ) as HTMLElement;
    if (titleContainerEl) {
      titleContainerEl.classList.add('loading');
    }

    try {
      const generatedTitle = await this.brainModule.generateTitle(noteContent);
      if (generatedTitle) {
        await this.saveTitleEdit(
          this.containerEl.querySelector('.chat-title-text') as HTMLElement,
          generatedTitle
        );
      }
      showCustomNotice('Title generated successfully!');
    } catch (error) {
      console.error('Error generating title:', error);
      showCustomNotice(`Title generation failed: ${error.message}`);
    } finally {
      hideCustomNotice(notice);
      if (titleContainerEl) {
        titleContainerEl.classList.remove('loading');
      }
    }
  }
  openFileSearcher(
    inputEl?: HTMLTextAreaElement,
    addToContextFiles: boolean = false
  ) {
    const fileSearcher = new FileSearcher(this.app);
    fileSearcher.open();
    fileSearcher.onChooseItem = (file: TFile) => {
      const fileName = file.basename;
      if (inputEl) {
        inputEl.value = inputEl.value.slice(0, -2) + `[[${fileName}]]`;
        inputEl.focus();
        this.updateTokenCountWithInput(inputEl.value);
      }

      if (addToContextFiles) {
        this.addFileToContextFiles(file);
      }
    };
  }

  addFileToContextFiles(file: TFile) {
    if (
      !this.contextFiles.some(contextFile => contextFile.path === file.path)
    ) {
      this.contextFiles.push(file);
      this.renderContextFiles();
      this.updateChatFileWithContext(file, 'add');
    }
  }

  async updateChatFileWithContext(file: TFile, action: 'add' | 'remove') {
    if (!this.chatFile) return;

    const content = await this.app.vault.read(this.chatFile);
    const contextTagShort = `[[${file.basename}]]`;
    const contextTagFull = `[[${file.path}]]`;

    let updatedContent;
    if (action === 'add') {
      // Add context file reference under # Context Files section
      if (content.includes('# Context Files')) {
        updatedContent = content.replace(
          '# Context Files',
          `# Context Files\n${contextTagShort}`
        );
      } else {
        updatedContent = `# Context Files\n${contextTagShort}\n${content}`;
      }
    } else {
      // Remove context file reference
      const contextFilesSection = content.match(
        /# Context Files\n([\s\S]*?)\n# AI Chat History/
      );
      if (contextFilesSection) {
        const contextFilesContent = contextFilesSection[1];
        const updatedContextFilesContent = contextFilesContent
          .split('\n')
          .filter(
            line =>
              line.trim() !== contextTagShort && line.trim() !== contextTagFull
          )
          .join('\n');
        updatedContent = content.replace(
          contextFilesSection[0],
          `# Context Files\n${updatedContextFilesContent}\n# AI Chat History`
        );
      } else {
        updatedContent = content
          .replace(contextTagShort, '')
          .replace(contextTagFull, '');
      }
    }

    // Ensure the context files section is at the top
    if (!updatedContent.startsWith('# Context Files')) {
      updatedContent = `# Context Files\n\n${updatedContent}`;
    }
    await this.app.vault.modify(this.chatFile, updatedContent);
    await this.loadChatFile(this.chatFile); // Reload the chat file to update the view
  }

  renderContextFiles() {
    const contextFilesContainer =
      this.containerEl.querySelector('.context-files');
    if (!contextFilesContainer) return;
    contextFilesContainer.innerHTML = '';

    if (this.contextFiles.length === 0) {
      contextFilesContainer.classList.remove('has-files');
      return;
    }

    contextFilesContainer.classList.add('has-files');
    this.contextFiles.forEach((file, index) => {
      const fileEl = document.createElement('div');
      fileEl.className = 'context-file';
      fileEl.innerHTML = `
      <span>${file.path}</span>
      <button class="remove-context-file" title="Remove Context File">🗑️</button>
    `;
      contextFilesContainer.appendChild(fileEl);

      const removeButton = fileEl.querySelector('.remove-context-file');
      if (removeButton) {
        removeButton.addEventListener('click', () => {
          this.contextFiles.splice(index, 1);
          this.renderContextFiles();
          this.updateChatFileWithContext(file, 'remove');
        });
      }
    });
  }
  toggleEditTitle() {
    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (!titleEl) return;

    const isEditing = titleEl.querySelector(
      '.edit-title-input'
    ) as HTMLInputElement;
    if (isEditing) {
      this.saveTitleEdit(titleEl);
    } else {
      this.startTitleEdit(titleEl);
    }
  }

  startTitleEdit(titleEl: HTMLElement) {
    const currentTitle = titleEl.textContent?.trim() || '';
    titleEl.innerHTML = `
      <input type="text" class="edit-title-input" value="${currentTitle}" />
    `;

    const inputEl = titleEl.querySelector(
      '.edit-title-input'
    ) as HTMLInputElement;
    inputEl.select();
    inputEl.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        this.saveTitleEdit(titleEl);
      }
    });
  }

  async saveTitleEdit(titleEl: HTMLElement, newTitle?: string) {
    const inputEl = titleEl.querySelector(
      '.edit-title-input'
    ) as HTMLInputElement;
    const finalTitle = newTitle || inputEl.value.trim();
    if (finalTitle && this.chatFile) {
      const newFilePath = `${this.chatModule.settings.chatsPath}/${finalTitle}.md`;
      await this.app.fileManager.renameFile(this.chatFile, newFilePath);
      this.chatFile = this.app.vault.getAbstractFileByPath(
        newFilePath
      ) as TFile;
      this.updateChatTitle(finalTitle);
    }

    // Restore the title text without duplicating the edit icon
    titleEl.textContent = finalTitle;
  }

  updateChatTitle(title: string) {
    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl) {
      titleEl.innerHTML = `
        ${title}
        <span class="edit-icon">✏️</span>
        <span class="generate-title-icon">🔄</span>
      `;
      this.attachEventListeners(this.containerEl as HTMLElement);
    }
  }

  async handleSendMessage(inputEl: HTMLTextAreaElement) {
    const messageText = inputEl.value.trim();
    if (messageText === '') return;

    const userMessage = new ChatMessage('user', messageText);
    this.addMessage(userMessage);
    inputEl.value = '';

    if (!this.chatFile) {
      this.createChatFile(messageText);
    } else {
      this.updateChatFile(`\`\`\`\`\`user\n${messageText}\n\`\`\`\`\`\n\n`);
    }

    this.sendMessageToAI();
    this.updateTokenCount(); // Update token count after sending message
  }

  async getContextFilesContent(): Promise<string> {
    if (this.contextFiles.length === 0) {
      return '';
    }
    let contextContent = '';
    for (const file of this.contextFiles) {
      const content = await this.app.vault.read(file);
      contextContent += `### ${file.basename}\n${content}\n`;
    }
    return contextContent;
  }
  async sendMessageToAI() {
    const aiService = this.brainModule.openAIService;
    const modelId = this.brainModule.settings.defaultModelId;
    const maxTokens = this.brainModule.settings.maxTokens;
    let accumulatedResponse = '';

    const systemPrompt = this.chatModule.settings.systemPrompt;

    const messageHistory = await this.constructMessageHistory();

    // Change 'ai' role to 'assistant' before sending
    const updatedMessageHistory = messageHistory.map(msg => ({
      role: msg.role === 'ai' ? 'assistant' : msg.role,
      content: msg.content,
    }));

    this.showLoading(); // Show loading animation

    try {
      await aiService.createStreamingConversationWithCallback(
        systemPrompt,
        updatedMessageHistory,
        modelId,
        maxTokens,
        async (chunk: string) => {
          accumulatedResponse += this.handleStreamingResponse(chunk);
        }
      );

      await this.updateChatFile(
        `\`\`\`\`\`ai\n${accumulatedResponse}\n\`\`\`\`\`\n\n`
      );
    } catch (error) {
      console.error('Error streaming AI response:', error);
    } finally {
      this.hideLoading(); // Hide loading animation
    }
  }

  async constructMessageHistory(): Promise<
    { role: string; content: string }[]
  > {
    const messageHistory = this.chatMessages.map(msg => ({
      role: msg.role,
      content: msg.text,
    }));

    const contextFilesContent = await this.getContextFilesContent();
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

  handleStreamingResponse(chunk: string): string {
    const dataLines = chunk.split('\n');
    let incompleteJSON = '';
    let accumulatedContent = '';

    for (const line of dataLines) {
      if (line.trim() === '') {
        continue;
      }

      if (line.startsWith('data:')) {
        const dataStr = line.slice(5).trim();
        if (dataStr === '[DONE]') {
          console.log('Streaming completed');
          return accumulatedContent;
        }

        try {
          const jsonStr = incompleteJSON + dataStr;
          incompleteJSON = '';
          const data = JSON.parse(jsonStr);

          if (
            data.choices &&
            data.choices[0].delta &&
            data.choices[0].delta.content
          ) {
            accumulatedContent += data.choices[0].delta.content;
            this.appendToLastMessage(accumulatedContent);
            this.updateTokenCount(); // Update token count after appending each chunk
          }
        } catch (error) {
          if (
            error instanceof SyntaxError &&
            error.message.includes('Unexpected end of JSON input')
          ) {
            incompleteJSON += dataStr;
          } else if (
            error.message.includes('Unterminated string in JSON at position')
          ) {
            // Suppress specific error message from being logged
          } else {
            console.error('Error parsing JSON:', error);
          }
        }
      } else {
        // Handle non-JSON chat response
        const aiMessage = new ChatMessage('ai', line.trim());
        this.addMessage(aiMessage);
      }
    }

    return accumulatedContent;
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
    if (!messagesContainer) return;
    messagesContainer.innerHTML = '';

    this.chatMessages.forEach((message, index) => {
      const messageEl = document.createElement('div');
      messageEl.className = `chat-message ${message.role}`;
      messageEl.innerHTML = `
        ${marked(message.text)}
        <div class="message-actions">
          <button class="copy-button" title="Copy Message">📋</button>
          <button class="delete-button" title="Delete Message">🗑️</button>
        </div>
      `;
      messagesContainer.appendChild(messageEl);

      const copyButton = messageEl.querySelector('.copy-button');
      if (copyButton) {
        copyButton.addEventListener('click', () => {
          navigator.clipboard.writeText(message.text).then(() => {
            copyButton.classList.add('copied');
            copyButton.innerHTML = '✅';
            setTimeout(() => {
              copyButton.classList.remove('copied');
              copyButton.innerHTML = '📋';
            }, 2000);
          });
        });
      }

      const deleteButton = messageEl.querySelector('.delete-button');
      if (deleteButton) {
        deleteButton.addEventListener('click', () => {
          this.handleDeleteMessage(deleteButton as HTMLElement, index);
        });
      }
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  handleDeleteMessage(deleteButton: HTMLElement, index: number) {
    if (deleteButton.classList.contains('confirm-delete')) {
      this.deleteMessage(index);
    } else {
      deleteButton.classList.add('confirm-delete');
      deleteButton.innerHTML = 'You sure? 🗑️';
      setTimeout(() => {
        deleteButton.classList.remove('confirm-delete');
        deleteButton.innerHTML = '🗑️';
      }, 3000);
    }
  }

  deleteMessage(index: number) {
    const deletedMessage = this.chatMessages.splice(index, 1)[0];
    this.renderMessages();
    this.updateTokenCount(); // Update token count after deleting message

    if (this.chatFile) {
      this.updateChatFileAfterDeletion(deletedMessage);
    }
  }

  async updateChatFileAfterDeletion(deletedMessage: ChatMessage) {
    const content = await this.app.vault.read(this.chatFile);
    const messageBlock = `\`\`\`\`\`${deletedMessage.role}\n${deletedMessage.text}\n\`\`\`\`\`\n\n`;
    const updatedContent = content.replace(messageBlock, '');
    await this.app.vault.modify(this.chatFile, updatedContent);
  }

  addMessage(message: ChatMessage) {
    this.chatMessages.push(message);

    this.renderMessages();
    this.updateTokenCount(); // Update token count after adding message
  }

  async createChatFile(initialMessage: string) {
    const folderPath = this.chatModule.settings.chatsPath;
    await this.app.vault.createFolder(folderPath).catch(() => {});
    const fileName = moment().format('YYYY-MM-DD HH-mm-ss');
    const filePath = `${folderPath}/${fileName}.md`;

    // Include context files in the initial content
    let contextFilesContent = '';
    for (const file of this.contextFiles) {
      contextFilesContent += `[[${file.path}]]\n`;
    }

    const initialContent = `# Context Files\n${contextFilesContent}\n# AI Chat History\n\n\`\`\`\`\`user\n${initialMessage}\n\`\`\`\`\`\n\n`;
    this.chatFile = await this.app.vault.create(filePath, initialContent);
  }

  async updateChatFile(content: string) {
    if (this.chatFile) {
      const fileContent = await this.app.vault.read(this.chatFile);
      const lines = fileContent.split('\n');
      const lastLine = lines[lines.length - 1];

      let newContent = content;
      if (lastLine.trim() !== '') {
        newContent = '\n\n' + content;
      }

      await this.app.vault.append(this.chatFile, newContent);
      await this.loadChatFile(this.chatFile); // Reload the chat file to update the view
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
    const messageHistory = this.chatMessages
      .map(msg => `${msg.role}\n${msg.text}`)
      .join('\n\n');

    const contextFilesContent = await this.getContextFilesContent();
    const fullMessage = `${contextFilesContent}\n\n${messageHistory}`;
    const tokens = encode(fullMessage);

    this.displayTokenCount(tokens.length);
  }

  async updateTokenCountWithInput(input: string) {
    const messageHistory = this.chatMessages
      .map(msg => `${msg.role}\n${msg.text}`)
      .join('\n\n');

    const contextFilesContent = await this.getContextFilesContent();
    const fullMessage = `${contextFilesContent}\n\n${messageHistory}\n\nuser\n${input}`;
    const tokens = encode(fullMessage);

    this.displayTokenCount(tokens.length);
  }

  setChatInputValue(value: string) {
    const inputEl = this.containerEl.querySelector(
      '.chat-input'
    ) as HTMLTextAreaElement;
    if (inputEl) {
      inputEl.value = value;
    }
  }

  displayTokenCount(tokenCount: number) {
    let tokenCountEl = this.containerEl.querySelector(
      '.token-count'
    ) as HTMLElement;
    let titleContainerEl = this.containerEl.querySelector(
      '.chat-title-container'
    ) as HTMLElement;

    if (!tokenCountEl) {
      const chatTitleEl = this.containerEl.querySelector(
        '.chat-title'
      ) as HTMLElement;
      if (chatTitleEl) {
        tokenCountEl = document.createElement('span');
        tokenCountEl.className = 'token-count';
        chatTitleEl.appendChild(tokenCountEl);
      }
    }

    if (this.chatMessages.length === 0) {
      if (tokenCountEl) {
        tokenCountEl.style.display = 'none';
      }
      if (titleContainerEl) {
        titleContainerEl.style.display = 'none';
      }
    } else {
      if (tokenCountEl) {
        tokenCountEl.style.display = 'inline';
        tokenCountEl.textContent = `Tokens: ${tokenCount}`;
      }
      if (titleContainerEl) {
        titleContainerEl.style.display = 'flex';
      }
    }
  }
}

class FileSearcher extends FuzzySuggestModal<TFile> {
  chatsPath?: string;

  constructor(app: App, chatsPath?: string) {
    super(app);
    this.chatsPath = chatsPath;
  }

  getItems(): TFile[] {
    const allFiles = this.app.vault.getMarkdownFiles();
    if (this.chatsPath) {
      //@ts-ignore
      return allFiles.filter(file => file.path.startsWith(this.chatsPath));
    }
    return allFiles;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
    // This will be overridden by the onChooseItem callback in ChatView
  }
}
