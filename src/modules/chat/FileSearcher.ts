import { App, FuzzySuggestModal, TFile, FuzzyMatch } from 'obsidian';

export class FileSearcher extends FuzzySuggestModal<TFile> {
  chatsPath?: string;

  constructor(app: App, chatsPath?: string) {
    super(app);
    this.chatsPath = chatsPath;
  }

  getItems(): TFile[] {
    const supportedExtensions = ['md', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'mp3', 'wav', 'm4a', 'ogg'];
    const allFiles = this.app.vault.getFiles().filter(file => 
      file.extension && supportedExtensions.includes(file.extension.toLowerCase())
    );
    if (this.chatsPath) {
      return allFiles.filter(
        file =>
          // @ts-ignore
          file.path.startsWith(this.chatsPath) &&
          !file.path.includes('/Archive/')
      );
    }
    return allFiles;
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  renderSuggestion(item: FuzzyMatch<TFile>, el: HTMLElement) {
    const content = el.createEl('div', { cls: 'suggestion-content' });
    const titleEl = content.createEl('span', { cls: 'suggestion-title' });
    const noteEl = content.createEl('span', { cls: 'suggestion-note' });

    this.highlightText(titleEl, item.item.name, item.match.matches);
    this.highlightText(noteEl, item.item.path, item.match.matches);
  }

  onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
    // This will be overridden by the onChooseItem callback in ChatView
  }

  highlightText(
    element: HTMLElement,
    text: string,
    matches: Array<[number, number]>
  ) {
    let lastIndex = 0;
    matches.forEach(match => {
      const [start, end] = match;
      if (start > lastIndex) {
        element.appendText(text.slice(lastIndex, start));
      }
      const highlightedSpan = element.createSpan({
        text: text.slice(start, end),
        cls: 'fuzzy-match',
      });
      lastIndex = end;
    });
    if (lastIndex < text.length) {
      element.appendText(text.slice(lastIndex));
    }
  }
}
