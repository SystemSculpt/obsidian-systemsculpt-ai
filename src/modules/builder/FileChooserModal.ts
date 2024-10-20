import { FuzzySuggestModal, TFile, App } from "obsidian";

export class FileChooserModal extends FuzzySuggestModal<TFile> {
  onChooseCallback: (file: TFile) => void;

  constructor(app: App, onChooseCallback: (file: TFile) => void) {
    super(app);
    this.onChooseCallback = onChooseCallback;
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseCallback(file);
    this.close();
  }
}
