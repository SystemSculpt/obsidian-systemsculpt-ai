import { FuzzySuggestModal, TFolder, App } from "obsidian";

export class DirectoryChooserModal extends FuzzySuggestModal<TFolder> {
  onChooseCallback: (folder: TFolder) => void;

  constructor(app: App, onChooseCallback: (folder: TFolder) => void) {
    super(app);
    this.onChooseCallback = onChooseCallback;
  }

  getItems(): TFolder[] {
    return this.app.vault
      .getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder);
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseCallback(folder);
    this.close();
  }
}
