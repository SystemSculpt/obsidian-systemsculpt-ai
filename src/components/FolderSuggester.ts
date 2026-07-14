import { AbstractInputSuggest, App, TFolder } from "obsidian";

class FolderSuggester extends AbstractInputSuggest<string> {
  private readonly input: HTMLInputElement;

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onSelectPath: (value: string) => void,
  ) {
    super(app, inputEl);
    this.input = inputEl;
  }

  getSuggestions(inputStr: string): string[] {
    const folders = getFolderSuggestions(this.app);
    const lowerCaseInputStr = inputStr.toLowerCase();
    return [...folders].filter((content) =>
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

function getFolderSuggestions(app: App): Set<string> {
  const folders = app.vault
    .getAllLoadedFiles()
    .filter((file) => file instanceof TFolder) as TFolder[];
  return new Set(folders.map((folder) => folder.path));
}

export function attachFolderSuggester(
  inputEl: HTMLInputElement,
  onSelect: (selectedPath: string) => void,
  app: App
): void {
  new FolderSuggester(app, inputEl, onSelect);
}
