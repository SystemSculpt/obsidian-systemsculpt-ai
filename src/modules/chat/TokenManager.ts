import { encode } from 'gpt-tokenizer';
import { ChatMessage } from './ChatMessage';
import { TFile } from 'obsidian';

export class TokenManager {
  constructor(private app: any) {}

  async getTokenCount(
    chatMessages: ChatMessage[],
    contextFiles: TFile[],
    inputText: string
  ): Promise<number> {
    const messageHistory = chatMessages
      .map(msg => `${msg.role}\n${msg.text}`)
      .join('\n\n');

    const contextFilesContent = await this.getContextFilesContent(contextFiles);
    const fullMessage = `${contextFilesContent}\n\n${messageHistory}\n\nuser\n${inputText}`;
    const tokens = encode(fullMessage);

    return tokens.length;
  }

  public async getContextFilesContent(contextFiles: TFile[]): Promise<string> {
    if (contextFiles.length === 0) {
      return '';
    }
    let contextContent = '';
    for (const file of contextFiles) {
      const content = await this.app.vault.read(file);
      contextContent += `### ${file.basename}\n${content}\n`;
    }
    return contextContent;
  }

  displayTokenCount(
    tokenCount: number,
    containerEl: HTMLElement,
    chatMessagesLength: number
  ) {
    let dollarButton = containerEl.querySelector(
      '.dollar-button'
    ) as HTMLElement;
    let tokenCountEl = containerEl.querySelector('.token-count') as HTMLElement;
    let titleContainerEl = containerEl.querySelector(
      '.chat-title-container'
    ) as HTMLElement;

    if (!tokenCountEl) {
      const chatTitleEl = containerEl.querySelector(
        '.chat-title'
      ) as HTMLElement;
      if (chatTitleEl) {
        tokenCountEl = document.createElement('span');
        tokenCountEl.className = 'token-count';
        chatTitleEl.appendChild(tokenCountEl);
      }
    }

    if (chatMessagesLength === 0) {
      if (tokenCountEl) {
        tokenCountEl.style.display = 'none';
      }
      if (dollarButton) {
        dollarButton.style.display = 'none';
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
      if (dollarButton) {
        dollarButton.style.display = 'inline';
      }
    }
  }
}
