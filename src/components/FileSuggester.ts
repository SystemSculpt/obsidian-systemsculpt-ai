import { App, TFile, AbstractInputSuggest } from "obsidian";

export class FileSuggester extends AbstractInputSuggest<string> {
  private content: Set<string>;

  constructor(
    private inputEl: HTMLInputElement,
    private onSelectCb: (value: string) => void,
    app: App,
    private directory?: string
  ) {
    super(app, inputEl);
    this.content = getFileSuggestions(app, directory);
  }

  getSuggestions(inputStr: string): string[] {
    const lowerCaseInputStr = inputStr.toLowerCase();
    return [...this.content].filter((content) =>
      content.toLowerCase().includes(lowerCaseInputStr)
    );
  }

  renderSuggestion(content: string, el: HTMLElement): void {
    // Show full path for files
    el.setText(content);
  }

  selectSuggestion(content: string, evt: MouseEvent | KeyboardEvent): void {
    this.onSelectCb(content);
    this.inputEl.value = content;
    this.inputEl.blur();
    this.close();
  }
}

export function getFileSuggestions(app: App, directory?: string): Set<string> {
  const files = app.vault.getAllLoadedFiles().filter((file): file is TFile => {
    if (!(file instanceof TFile)) return false;

    if (directory) {
      // Include .md files in the specified directory and all subdirectories
      const normalizedDir = directory.replace(/\/$/, "");
      const inDirOrSubdir = file.parent?.path === normalizedDir || file.path.startsWith(`${normalizedDir}/`);
      return inDirOrSubdir && file.extension === "md";
    } else {
      // Include all files in the vault
      return true;
    }
  });
  return new Set(files.map((file) => file.path));
}

export function attachFileSuggester(
  inputEl: HTMLInputElement,
  onSelect: (selectedPath: string) => void,
  app: App,
  directory?: string
): FileSuggester {
  return new FileSuggester(inputEl, onSelect, app, directory);
}
