import { App, TFile } from 'obsidian';
import { ChatModule } from './ChatModule';
import { ChatView } from './ChatView';

export class ArchiveManager {
  constructor(private app: App, private chatModule: ChatModule) {}

  showArchivePopup(chatView: ChatView) {
    const overlay = document.createElement('div');
    overlay.className = 'archive-popup-overlay';
    document.body.appendChild(overlay);

    const popup = document.createElement('div');
    popup.className = 'archive-popup';
    popup.innerHTML = `
      <h3>What would you like to do?</h3>
      <div class="archive-popup-buttons">
        <button class="archive-popup-button archive">Archive this chat [a]</button>
        <button class="archive-popup-button delete">Delete this chat [d]</button>
      </div>
    `;
    document.body.appendChild(popup);

    const archiveButton = popup.querySelector('.archive-popup-button.archive');
    const deleteButton = popup.querySelector('.archive-popup-button.delete');

    const handleKeyPress = (event: KeyboardEvent) => {
      if (event.key === 'a') {
        // @ts-ignore
        archiveButton?.click();
      } else if (event.key === 'd') {
        // @ts-ignore
        deleteButton?.click();
      }
    };

    archiveButton?.addEventListener('click', () => {
      this.archiveChatFile(chatView);
      this.closeArchivePopup(popup, overlay, handleKeyPress);
    });

    deleteButton?.addEventListener('click', () => {
      this.deleteChatFile(chatView);
      this.closeArchivePopup(popup, overlay, handleKeyPress);
    });

    overlay.addEventListener('click', () => {
      this.closeArchivePopup(popup, overlay, handleKeyPress);
    });

    document.addEventListener('keydown', handleKeyPress);
  }

  private closeArchivePopup(
    popup: HTMLElement,
    overlay: HTMLElement,
    handleKeyPress: (event: KeyboardEvent) => void
  ) {
    document.body.removeChild(popup);
    document.body.removeChild(overlay);
    document.removeEventListener('keydown', handleKeyPress);
  }

  async deleteChatFile(chatView: ChatView) {
    if (!chatView.chatFile) return;

    const allFiles = this.getAllChatFiles();
    const currentIndex = allFiles.findIndex(
      file => file.path === chatView.chatFile.path
    );

    let nextFile: TFile | null = null;
    if (currentIndex !== -1 && currentIndex < allFiles.length - 1) {
      nextFile = allFiles[currentIndex + 1];
    } else if (currentIndex > 0) {
      nextFile = allFiles[currentIndex - 1];
    }

    await this.app.vault.delete(chatView.chatFile);

    if (nextFile) {
      chatView.setChatFile(nextFile);
      await chatView.loadChatFile(nextFile);
    } else {
      this.chatModule.openNewChat();
    }
  }

  async archiveChatFile(chatView: ChatView) {
    if (!chatView.chatFile) return;

    const allFiles = this.getAllChatFiles();
    const currentIndex = allFiles.findIndex(
      file => file.path === chatView.chatFile.path
    );

    let nextFile: TFile | null = null;
    if (currentIndex !== -1 && currentIndex < allFiles.length - 1) {
      nextFile = allFiles[currentIndex + 1];
    } else if (currentIndex > 0) {
      nextFile = allFiles[currentIndex - 1];
    }

    const archivePath = `${this.chatModule.settings.chatsPath}/Archive`;
    await this.app.vault.createFolder(archivePath).catch(() => {});
    const newFilePath = `${archivePath}/${chatView.chatFile.name}`;
    await this.app.fileManager.renameFile(chatView.chatFile, newFilePath);

    if (nextFile) {
      chatView.setChatFile(nextFile);
      await chatView.loadChatFile(nextFile);
    } else {
      this.chatModule.openNewChat();
    }
  }

  private getAllChatFiles(): TFile[] {
    return this.app.vault
      .getMarkdownFiles()
      .filter(
        file =>
          file.path.startsWith(this.chatModule.settings.chatsPath) &&
          !file.path.includes('/Archive/')
      );
  }
}
