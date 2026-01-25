import { App, Modal, Notice, Setting, TFile } from "obsidian";

type IH = any;

export async function handleOpenChatHistoryFile(self: IH): Promise<void> {
  try {
    const chatId = self.getChatId();
    if (!chatId) {
      new Notice("No active chat to open history for");
      return;
    }

    const chatDirectory = self.plugin.settings.chatsDirectory || "SystemSculpt/Chats";
    const chatFilePath = `${chatDirectory}/${chatId}.md`;

    const file = self.app.vault.getAbstractFileByPath(chatFilePath);
    if (!(file instanceof TFile)) {
      new Notice("Chat history file not found");
      return;
    }

    await self.app.workspace.getLeaf(true).openFile(file);
    new Notice("Opened chat history file");
  } catch (error) {
    new Notice("Error opening chat history file");
  }
}

export async function handleSaveChatAsNote(self: IH): Promise<void> {
  try {
    if (typeof self.getChatMarkdown !== 'function' || typeof self.getChatTitle !== 'function') {
      new Notice("Error saving chat: Missing required functions.", 4000);
      return;
    }

    const chatContent = await self.getChatMarkdown();
    const currentChatTitle = self.getChatTitle();

    const now = new Date();
    const defaultFileName = `Chat ${now.toLocaleDateString()} ${now.toLocaleTimeString().replace(/:/g, "-")}`;
    const folderPath = self.plugin.settings.savedChatsDirectory || "SystemSculpt/Saved Chats";

    let fileName = currentChatTitle || defaultFileName;
    fileName = fileName.replace(/[\\/:*?"<>|]/g, "-");

    try {
      if (self.plugin.directoryManager) {
        await self.plugin.directoryManager.ensureDirectoryByPath(folderPath);
      } else {
        await self.plugin.app.vault.createFolder(folderPath).catch(() => {});
      }

      const filePath = `${folderPath}/${fileName}.md`;
      const fileExists = await self.plugin.app.vault.adapter.exists(filePath);
      if (fileExists) {
        const confirmOverwrite = await new Promise<boolean>(resolve => {
          const modal = new (class extends Modal {
            constructor(app: App) { super(app); }
            onOpen() {
              this.titleEl.setText("File Already Exists");
              this.contentEl.createEl("p", { text: `"${fileName}.md" already exists. Do you want to overwrite it with the latest chat content?` });
              new Setting(this.contentEl)
                .addButton(btn => btn.setButtonText("Cancel").onClick(() => { this.close(); resolve(false); }))
                .addButton(btn => btn.setButtonText("Overwrite").setWarning().onClick(() => { this.close(); resolve(true); }));
            }
            onClose() { this.contentEl.empty(); }
          })(self.app);
          modal.open();
        });
        if (!confirmOverwrite) return;
        const existingFile = self.app.vault.getAbstractFileByPath(filePath);
        if (existingFile instanceof TFile) {
          await self.plugin.app.vault.modify(existingFile, chatContent);
        } else {
          throw new Error("Could not locate the existing file to modify it");
        }
      } else {
        await self.plugin.app.vault.create(filePath, chatContent);
      }

      new Notice(`Chat saved to "${filePath}"`, 4000);
      const file = self.plugin.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        await self.plugin.app.workspace.openLinkText(file.path, "", true);
      }
    } catch (error) {
      new Notice("Failed to save chat as note. Please try again.", 4000);
    }
  } catch (error) {
    new Notice("An error occurred while saving chat as note", 4000);
  }
}


