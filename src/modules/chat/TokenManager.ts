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

  public async getContextFilesContent(contextFiles: TFile[]): Promise<{ text: string, images: { path: string, base64: string }[] }> {
    const textContent = await getContextFilesContent(this.app, contextFiles);
    const images = await this.getImageFilesContent(contextFiles);
    return { text: textContent, images };
  }

  private async getImageFilesContent(contextFiles: TFile[]): Promise<{ path: string, base64: string }[]> {
    const imageFiles = contextFiles.filter(file => 
      ['png', 'jpg', 'jpeg', 'gif'].includes(file.extension.toLowerCase())
    );

    const imageContents = await Promise.all(imageFiles.map(async file => {
      const arrayBuffer = await this.app.vault.readBinary(file);
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );
      return { path: file.path, base64 };
    }));

    return imageContents;
  }

  displayTokenCount(
    tokenCount: number,
    containerEl: HTMLElement,
    chatMessagesLength: number,
    model: any,
    maxOutputTokens: number
  ) {
    displayTokenCount(tokenCount, containerEl, chatMessagesLength, model, maxOutputTokens);
  }
}