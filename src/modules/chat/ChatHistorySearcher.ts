import { App, TFile, FuzzySuggestModal, FuzzyMatch } from "obsidian";

export class ChatHistorySearcher extends FuzzySuggestModal<TFile> {
  private chatHistoryPath: string;

  constructor(app: App, chatHistoryPath: string) {
    super(app);
    this.chatHistoryPath = chatHistoryPath;
  }

  getItems(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter(
        (file) =>
          file.path.startsWith(this.chatHistoryPath) &&
          file.extension === "md" &&
          !file.path.includes("/Archive/"),
      )
      .sort((a, b) => b.stat.ctime - a.stat.ctime); // Sort by creation time, newest first
  }

  getItemText(file: TFile): string {
    return file.basename;
  }

  onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent): void {
    // This method will be overridden by the caller
  }

  renderSuggestion(item: FuzzyMatch<TFile>, el: HTMLElement): void {
    const file = item.item;
    el.createEl("div", { text: file.basename });
    el.createEl("small", { text: new Date(file.stat.ctime).toLocaleString() }); // Display creation date
  }
}
