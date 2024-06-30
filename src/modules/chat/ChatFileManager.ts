import { App, TFile, moment } from 'obsidian';
import { ChatMessage } from './ChatMessage';

export class ChatFileManager {
  constructor(private app: App, private chatsPath: string) {}

  async createChatFile(
    initialMessage: string,
    contextFiles: TFile[]
  ): Promise<TFile> {
    await this.app.vault.createFolder(this.chatsPath).catch(() => {});
    const fileName = moment().format('YYYY-MM-DD HH-mm-ss');
    const filePath = `${this.chatsPath}/${fileName}.md`;

    let contextFilesContent = '';
    for (const file of contextFiles) {
      contextFilesContent += `[[${file.path}]]\n`;
    }

    const initialContent = `# Context Files\n${contextFilesContent}\n# AI Chat History\n\n\`\`\`\`\`user\n${initialMessage}\n\`\`\`\`\`\n\n`;
    return await this.app.vault.create(filePath, initialContent);
  }

  async updateChatFile(chatFile: TFile, content: string): Promise<void> {
    if (chatFile) {
      const fileContent = await this.app.vault.read(chatFile);
      const lines = fileContent.split('\n');
      const lastLine = lines[lines.length - 1];

      let newContent = content;
      if (lastLine.trim() !== '') {
        newContent = '\n\n' + content;
      }

      await this.app.vault.append(chatFile, newContent);
    }
  }

  async loadChatFile(file: TFile): Promise<ChatMessage[]> {
    const content = await this.app.vault.read(file);
    const messages: ChatMessage[] = [];

    const blockRegex = /`````\s*(user|ai(?:-[^\s]+)?)\s*([\s\S]*?)\s*`````/g;
    let match;

    while ((match = blockRegex.exec(content)) !== null) {
      const [, role, text] = match;
      const model = role.startsWith('ai-') ? role.split('-')[1] : undefined;
      messages.push(new ChatMessage(role as 'user' | 'ai', text.trim(), model));
    }

    return messages;
  }

  async updateChatFileAfterDeletion(
    chatFile: TFile,
    deletedMessage: ChatMessage,
    messageIndex: number
  ): Promise<void> {
    const content = await this.app.vault.read(chatFile);
    const updatedContent = this.removeMessageFromContent(
      content,
      deletedMessage,
      messageIndex
    );
    await this.app.vault.modify(chatFile, updatedContent);
  }

  removeMessageFromContent(
    content: string,
    deletedMessage: ChatMessage,
    messageIndex: number
  ): string {
    const lines = content.split('\n');
    const messageStart = `\`\`\`\`\`${deletedMessage.role}`;
    const messageEnd = '`````';

    let currentMessageCount = -1;
    let inMessageBlock = false;
    let messageStartIndex = -1;
    let messageEndIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('`````')) {
        if (inMessageBlock) {
          messageEndIndex = i;
          if (currentMessageCount === messageIndex) {
            break;
          }
          inMessageBlock = false;
        } else {
          currentMessageCount++;
          inMessageBlock = true;
          messageStartIndex = i;
        }
      }
    }

    if (messageStartIndex !== -1 && messageEndIndex !== -1) {
      lines.splice(messageStartIndex, messageEndIndex - messageStartIndex + 1);
      return lines.join('\n');
    }

    return content;
  }

  async getContextFilesFromChatFile(file: TFile): Promise<TFile[]> {
    const content = await this.app.vault.read(file);
    const contextFiles: TFile[] = [];

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
        if (contextFile) {
          contextFiles.push(contextFile);
        }
      }
    }

    return contextFiles;
  }
}
