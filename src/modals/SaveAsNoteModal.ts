import { App, Modal, Notice, TFile } from "obsidian";
import SystemSculptPlugin from "../main";
import { attachFolderSuggester } from "../components/FolderSuggester";

export class SaveAsNoteModal extends Modal {
  private plugin: SystemSculptPlugin;
  private defaultFolder: string;
  private defaultFileName: string;
  private content: string;
  private onSaveSuccess?: (filePath: string) => void;

  private folderInput: HTMLInputElement;
  private fileNameInput: HTMLInputElement;
  private saveButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;

  constructor(
    app: App,
    plugin: SystemSculptPlugin,
    defaultFolder: string,
    defaultFileName: string,
    content: string,
    onSaveSuccess?: (filePath: string) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.defaultFolder = defaultFolder;
    this.defaultFileName = defaultFileName;
    this.content = content;
    this.onSaveSuccess = onSaveSuccess;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.empty();

    contentEl.createEl("h2", { text: "Save as Note" });

    contentEl.createEl("p", { text: "Choose a location and name for your note" });

    // Folder input
    const folderLabel = contentEl.createEl("label", { text: "Folder" });
    folderLabel.style.marginBottom = "12px";

    this.folderInput = contentEl.createEl("input", {
      type: "text",
      value: this.defaultFolder,
      placeholder: "Folder path",
    });
    this.folderInput.style.width = "100%";
    this.folderInput.style.marginBottom = "12px";

    attachFolderSuggester(this.folderInput, (folder) => { this.folderInput.value = folder; }, this.app);

    // Filename input
    const fileNameLabel = contentEl.createEl("label", { text: "File name" });
    this.fileNameInput = contentEl.createEl("input", {
      type: "text",
      value: this.defaultFileName,
      placeholder: "File name (without extension)",
    });
    this.fileNameInput.style.width = "100%";

    // Buttons container
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    buttonContainer.style.display = "flex";
    buttonContainer.style.justifyContent = "flex-end";
    buttonContainer.style.gap = "10px";
    buttonContainer.style.marginTop = "20px";

    this.cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
    this.saveButton = buttonContainer.createEl("button", { text: "Save" });
    this.saveButton.addClass("mod-cta");

    this.cancelButton.addEventListener("click", () => this.close());
    this.saveButton.addEventListener("click", () => this.handleSave());
  }

  async handleSave() {
    const folderPath = this.folderInput.value.trim();
    const fileName = this.fileNameInput.value.trim();

    if (!folderPath) {
      new Notice("Please enter a folder path.");
      return;
    }
    if (!fileName) {
      new Notice("Please enter a file name.");
      return;
    }

    const sanitizedFileName = fileName.replace(/[/\\?%*:|"<>]/g, "").trim();
    if (!sanitizedFileName) {
      new Notice("Invalid file name.");
      return;
    }

    const fullPath = `${folderPath}/${sanitizedFileName}.md`;

    try {
      // Create folder if it doesn't exist using the DirectoryManager
      if (this.plugin.directoryManager) {
        await this.plugin.directoryManager.ensureDirectoryByPath(folderPath);
      } else {
        // Fallback to direct creation if DirectoryManager is not available
        await this.plugin.app.vault.createFolder(folderPath).catch(() => {});
      }

      // Check if file exists
      const existingFile = this.plugin.app.vault.getAbstractFileByPath(fullPath);
      if (existingFile instanceof TFile) {
        new Notice("File already exists. Please choose a different name.");
        return;
      }

      // Create the file
      await this.plugin.app.vault.create(fullPath, this.content);

      new Notice(`Note saved to "${fullPath}"`);

      // Open the new note
      const file = this.plugin.app.vault.getAbstractFileByPath(fullPath);
      if (file) {
        await this.plugin.app.workspace.openLinkText(file.path, "", true);
      }

      if (this.onSaveSuccess) {
        this.onSaveSuccess(fullPath);
      }

      // Persist last used folder
      await this.plugin.updateLastSaveAsNoteFolder(folderPath);

      this.close();
    } catch (error) {
      new Notice("Failed to save note. Please try again.");
    }
  }
}