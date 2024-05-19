import { ItemView, WorkspaceLeaf, TFile, moment } from 'obsidian';
import { ChatMessage } from './ChatMessage';
import { BrainModule } from '../brain/BrainModule';
import { encode } from 'gpt-tokenizer';
import { ChatModule } from './ChatModule';
import { marked } from 'marked';

export const VIEW_TYPE_CHAT = 'chat-view';

export class ChatView extends ItemView {
  chatMessages: ChatMessage[];
  brainModule: BrainModule;
  chatModule: ChatModule;
  chatFile: TFile;

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
    const container = this.containerEl.children[1];
    container.empty();

    const chatTemplate = document.createElement('template');
    chatTemplate.innerHTML = `
      <div class="chat-container">
        <div class="chat-header">SystemSculpt AI Chat</div>
        <div class="chat-title">
          <div class="chat-title-container" style="display: none;">
            <span class="chat-title-text"></span>
            <span class="edit-icon">✏️</span>
          </div>
          <span class="token-count" style="display: none;">Tokens: 0</span>
        </div>
        <div class="chat-messages"></div>
        <div class="chat-input-container">
          <textarea class="chat-input" placeholder="Type a message..."></textarea>
          <button class="chat-send-button">Send</button>
        </div>
      </div>
    `;
    container.appendChild(chatTemplate.content.cloneNode(true));

    this.attachEventListeners(container as HTMLElement);

    // wait 100ms before focusing the input field
    setTimeout(() => {
      this.focusInput();
    }, 100);

    const titleEl = this.containerEl.querySelector('.chat-title-text');
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
  }

  async loadChatFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const messages: ChatMessage[] = [];

    // Match all code blocks with user or ai roles
    const blockRegex = /`````\s*(user|ai)\s*([\s\S]*?)\s*`````/g;
    let match;

    while ((match = blockRegex.exec(content)) !== null) {
      const role = match[1] as 'user' | 'ai';
      const text = match[2].trim();

      // Detect typical 3 backtick code blocks within the message text
      const codeBlockRegex = /```[\s\S]*?```/g;
      const codeBlocks = text.match(codeBlockRegex);

      if (codeBlocks) {
        codeBlocks.forEach(block => {
          // Process each code block if needed
          console.log(`Detected code block: ${block}`);
        });
      }

      messages.push(new ChatMessage(role, text));
    }

    this.chatMessages = messages;
    this.chatFile = file;
    this.renderMessages();
    this.updateTokenCountWithInput('');
  }

  setChatFile(file: TFile) {
    this.chatFile = file;
    const titleEl = this.containerEl.querySelector('.chat-title-text');
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
    });

    // Add event listener for the edit icon
    editIconEl.addEventListener('click', () => this.toggleEditTitle());
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

  async saveTitleEdit(titleEl: HTMLElement) {
    const inputEl = titleEl.querySelector(
      '.edit-title-input'
    ) as HTMLInputElement;
    const newTitle = inputEl.value.trim();
    if (newTitle && this.chatFile) {
      const newFilePath = `${this.chatModule.settings.chatsPath}/${newTitle}.md`;
      await this.app.fileManager.renameFile(this.chatFile, newFilePath);
      this.chatFile = this.app.vault.getAbstractFileByPath(
        newFilePath
      ) as TFile;
      this.updateChatTitle(newTitle);
    }

    // Restore the title text without duplicating the edit icon
    titleEl.textContent = newTitle;
  }

  updateChatTitle(title: string) {
    const titleEl = this.containerEl.querySelector(
      '.chat-title-text'
    ) as HTMLElement;
    if (titleEl) {
      titleEl.innerHTML = `
        ${title}
        <span class="edit-icon">✏️</span>
      `;
      this.attachEventListeners(this.containerEl as HTMLElement);
    }
  }

  handleSendMessage(inputEl: HTMLTextAreaElement) {
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

    this.sendMessageToAI(userMessage.text);
    this.updateTokenCount(); // Update token count after sending message
  }

  async sendMessageToAI(message: string) {
    const aiService = this.brainModule.openAIService;
    const modelId = this.brainModule.settings.defaultModelId;
    const maxTokens = this.brainModule.settings.maxTokens;
    let accumulatedResponse = '';

    const systemPrompt = this.chatModule.settings.systemPrompt;

    const messageHistory = this.chatMessages
      .slice(0, -1)
      .map(msg => `${msg.role}\n${msg.text}`)
      .join('\n\n');
    const fullMessage = `${messageHistory}\n\nuser\n${message}`;

    try {
      await aiService.createStreamingChatCompletionWithCallback(
        systemPrompt,
        fullMessage,
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
          <button class="copy-button">📋</button>
          <button class="delete-button">🗑️</button>
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
      deleteButton.innerHTML = '🛑';
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
    const initialContent = `# AI Chat History\n\n\`\`\`\`\`user\n${initialMessage}\n\`\`\`\`\`\n\n`;
    this.chatFile = await this.app.vault.create(filePath, initialContent);
  }

  async updateChatFile(content: string) {
    if (this.chatFile) {
      await this.app.vault.append(this.chatFile, content);
      await this.loadChatFile(this.chatFile); // Reload the chat file to update the view
    }
  }

  async onFileChange(file: TFile) {
    if (this.chatFile && file.path === this.chatFile.path) {
      await this.loadChatFile(file);
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

  updateTokenCount() {
    const messageHistory = this.chatMessages
      .map(msg => `${msg.role}\n${msg.text}`)
      .join('\n\n');
    const tokens = encode(messageHistory);

    this.displayTokenCount(tokens.length);
  }

  updateTokenCountWithInput(input: string) {
    const messageHistory = this.chatMessages
      .map(msg => `${msg.role}\n${msg.text}`)
      .join('\n\n');
    const fullMessage = `${messageHistory}\n\nuser\n${input}`;
    const tokens = encode(fullMessage);

    this.displayTokenCount(tokens.length);
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
