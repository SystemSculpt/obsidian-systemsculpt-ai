import { App, TFolder, AbstractInputSuggest } from "obsidian";

// Create a custom class that doesn't extend AbstractInputSuggest
// but uses it internally instead
export class FolderSuggester {
  private content: Set<string>;
  private app: App;
  private suggestEl: HTMLInputElement;
  private suggest: InternalSuggester;

  constructor(
    inputEl: HTMLInputElement,
    private onSelectCb: (value: string) => void,
    app: App
  ) {
    this.app = app;
    this.suggestEl = inputEl;
    this.content = getFolderSuggestions(app);

    // Create the internal suggester that properly extends AbstractInputSuggest
    this.suggest = new InternalSuggester(app, inputEl);

    // Set up the callback
    this.suggest.onSelect((value: string) => {
      this.onSelectCb(value);
    });
  }

  // Refresh suggestions when the input is focused
  public refreshSuggestions(): void {
    this.content = getFolderSuggestions(this.app);
  }

  // Method to close the suggester
  public close(): void {
    this.suggest.close();
  }
}

// Internal class that properly extends AbstractInputSuggest
class InternalSuggester extends AbstractInputSuggest<string> {
  // Make the inputEl property accessible
  protected inputEl: HTMLInputElement;

  constructor(app: App, inputEl: HTMLInputElement) {
    super(app, inputEl);
    this.inputEl = inputEl;
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
    this.inputEl.value = content;
    this.inputEl.blur();
    this.close();
    super.selectSuggestion(content, evt);
  }
}

export function getFolderSuggestions(app: App): Set<string> {
  const folders = app.vault
    .getAllLoadedFiles()
    .filter((file) => file instanceof TFolder) as TFolder[];
  return new Set(folders.map((folder) => folder.path));
}

export function attachFolderSuggester(
  inputEl: HTMLInputElement,
  onSelect: (selectedPath: string) => void,
  app: App
): FolderSuggester {
  const suggester = new FolderSuggester(inputEl, onSelect, app);

  // Refresh suggestions when the input is focused
  inputEl.addEventListener('focus', () => {
    suggester.refreshSuggestions();
  });

  return suggester;
}
