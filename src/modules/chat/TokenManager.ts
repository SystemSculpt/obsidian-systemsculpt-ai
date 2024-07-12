import { getTokenCount, getContextFilesContent, displayTokenCount } from './utils';
import { ChatMessage } from './ChatMessage';
import { TFile } from 'obsidian';

export class TokenManager {
  constructor(private app: any) {}

  async getTokenCount(
    chatMessages: ChatMessage[],
    contextFiles: TFile[],
    inputText: string
  ): Promise<number> {
    return getTokenCount(this.app, chatMessages, contextFiles, inputText);
  }

  public async getContextFilesContent(contextFiles: TFile[]): Promise<string> {
    return getContextFilesContent(this.app, contextFiles);
  }

  displayTokenCount(
    tokenCount: number,
    containerEl: HTMLElement,
    chatMessagesLength: number
  ) {
    displayTokenCount(tokenCount, containerEl, chatMessagesLength);
  }
}
