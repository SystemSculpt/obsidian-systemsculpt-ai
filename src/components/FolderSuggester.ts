import { AbstractInputSuggest, App } from "obsidian";

class FolderSuggester extends AbstractInputSuggest<string> {
  private readonly input: HTMLInputElement;
  private folderPaths: string[] | null = null;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onSelectPath: (value: string) => void,
  ) {
    super(app, inputEl);
    this.input = inputEl;
    inputEl.addEventListener("blur", () => { this.folderPaths = null; });
  }

  getSuggestions(inputStr: string): string[] {
    this.folderPaths ??= this.app.vault.getAllFolders(true).map((folder) => folder.path);
    const lowerCaseInputStr = inputStr.toLowerCase();
    return this.folderPaths.filter((content) =>
      content.toLowerCase().includes(lowerCaseInputStr)
    );
  }

  renderSuggestion(content: string, el: HTMLElement): void {
    el.setText(content);
  }

  selectSuggestion(content: string, evt: MouseEvent | KeyboardEvent): void {
    this.input.value = content;
    this.onSelectPath(content);
    this.input.blur();
    this.close();
    super.selectSuggestion(content, evt);
  }
}

export function attachFolderSuggester(
  inputEl: HTMLInputElement,
  onSelect: (selectedPath: string) => void,
  app: App
): void {
  new FolderSuggester(app, inputEl, onSelect);
}
