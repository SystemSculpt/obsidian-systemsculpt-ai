import { App, Modal, Setting, TFolder } from "obsidian";
import { MultiSuggest } from "../../../utils/MultiSuggest";

export class SaveChatAsNoteModal extends Modal {
  fileName: string;
  folderPath: string;
  onSave: (fileName: string, folderPath: string) => void;

  constructor(
    app: App,
    fileName: string,
    folderPath: string,
    onSave: (fileName: string, folderPath: string) => void
  ) {
    super(app);
    this.fileName = fileName.replace(/\.md$/, "");
    this.folderPath = folderPath;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Save Chat as Note" });

    new Setting(contentEl)
      .setName("File name")
      .addText((text) =>
        text
          .setValue(this.fileName)
          .onChange((value) => (this.fileName = value.replace(/\.md$/, "")))
      );

    new Setting(contentEl).setName("Folder path").addText((text) => {
      text
        .setValue(this.folderPath)
        .onChange((value) => (this.folderPath = value));

      const inputEl = text.inputEl;
      const suggestionContent = this.getFolderSuggestions();
      const onSelectCallback = (selectedPath: string) => {
        this.folderPath = selectedPath;
        text.setValue(selectedPath);
      };

      new MultiSuggest(
        inputEl,
        new Set(suggestionContent),
        onSelectCallback,
        this.app
      );
    });

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          const finalFileName = `${this.fileName.trim()}.md`;
          this.onSave(finalFileName, this.folderPath);
          this.close();
        })
    );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  private getFolderSuggestions(): string[] {
    const folders: string[] = [];
    const stack: TFolder[] = [this.app.vault.getRoot()];

    while (stack.length > 0) {
      const currentFolder = stack.pop()!;
      folders.push(currentFolder.path);

      currentFolder.children
        .filter((child): child is TFolder => child instanceof TFolder)
        .forEach((childFolder) => stack.push(childFolder));
    }

    return folders;
  }
}
