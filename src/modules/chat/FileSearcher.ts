import {
  App,
  FuzzySuggestModal,
  TFile,
  FuzzyMatch,
  TFolder,
  SearchMatchPart,
} from "obsidian";
import { Vault } from "obsidian";
import { TAbstractFile } from "obsidian";

export class FileSearcher extends FuzzySuggestModal<TFile | TFolder> {
  chatsPath?: string;
  private selectedItems: Set<string> = new Set();
  private selectedDirectories: Set<string> = new Set();
  private noticeEl: HTMLElement | null = null;
  private includeFiles: boolean = true;
  private includeFolders: boolean = true;
  private confirmButton: HTMLButtonElement | null = null;
  private vault: Vault;

  constructor(app: App, chatsPath?: string) {
    super(app);
    this.chatsPath = chatsPath;
    this.vault = app.vault;
  }

  onOpen() {
    console.log("FileSearcher: Modal opened");
    super.onOpen();
    this.addFilters();
    this.addNotice();
    this.addConfirmButton();

    // Adjust the layout to accommodate the button
    // const contentEl = this.modalEl.querySelector('.modal-content');
    // if (contentEl) {
    //   console.log('FileSearcher: Modal content padding adjusted');
    // }
  }

  onClose() {
    console.log("FileSearcher: onClose called");
    super.onClose();
  }

  private addFilters() {
    const inputEl = this.modalEl.querySelector(
      ".prompt-input",
    ) as HTMLInputElement;
    if (inputEl) {
      const filtersContainer = createEl("div", {
        cls: "file-searcher-filters",
      });

      const includeFilesLabel = filtersContainer.createEl("label", {
        cls: "file-searcher-filter",
      });
      const includeFilesCheckbox = includeFilesLabel.createEl("input", {
        type: "checkbox",
        cls: "file-searcher-filter-checkbox",
      });
      includeFilesCheckbox.checked = this.includeFiles;
      includeFilesLabel.appendText("Include Files");

      const includeFoldersLabel = filtersContainer.createEl("label", {
        cls: "file-searcher-filter",
      });
      const includeFoldersCheckbox = includeFoldersLabel.createEl("input", {
        type: "checkbox",
        cls: "file-searcher-filter-checkbox",
      });
      includeFoldersCheckbox.checked = this.includeFolders;
      includeFoldersLabel.appendText("Include Folders");

      inputEl.parentElement?.parentElement?.insertBefore(
        filtersContainer,
        inputEl.parentElement.nextSibling,
      );

      includeFilesCheckbox.addEventListener("change", () => {
        this.includeFiles = includeFilesCheckbox.checked;
        this.updateSuggestions();
      });

      includeFoldersCheckbox.addEventListener("change", () => {
        this.includeFolders = includeFoldersCheckbox.checked;
        this.updateSuggestions();
      });
    }
  }

  private addNotice() {
    const inputEl = this.modalEl.querySelector(
      ".prompt-input",
    ) as HTMLInputElement;
    if (inputEl && !this.noticeEl) {
      this.noticeEl = createEl("div", { cls: "file-searcher-notice" });
      this.noticeEl.innerHTML =
        "You can select multiple files and folders. <strong>Press Enter when done selecting</strong> to add them to the context files.";
      const filtersContainer = this.modalEl.querySelector(
        ".file-searcher-filters",
      );
      if (filtersContainer) {
        filtersContainer.insertAdjacentElement("afterend", this.noticeEl);
      } else {
        inputEl.parentElement?.parentElement?.insertBefore(
          this.noticeEl,
          inputEl.parentElement.nextSibling,
        );
      }
    }
  }

  private addConfirmButton() {
    if (!this.confirmButton) {
      this.confirmButton = createEl("button", {
        cls: "file-searcher-confirm-button",
        text: "Select Which Files to Add",
      });

      this.confirmButton.addEventListener("click", () => {
        this.addSelectedItems();
      });

      // Create a container for the button at the bottom of the modal
      const buttonContainer = createEl("div", {
        cls: "file-searcher-button-container",
      });
      buttonContainer.appendChild(this.confirmButton);
      this.modalEl.appendChild(buttonContainer);
    }

    this.updateConfirmButtonState();
  }

  private updateConfirmButtonState() {
    if (this.confirmButton) {
      if (this.selectedItems.size === 0) {
        this.confirmButton.disabled = true;
        this.confirmButton.classList.remove("active");
        this.confirmButton.textContent = "Select Which Files to Add";
      } else {
        this.confirmButton.disabled = false;
        this.confirmButton.classList.add("active");
        const fileCount = this.countSelectedFiles();
        this.confirmButton.textContent = `Add ${fileCount} File${fileCount !== 1 ? "s" : ""} (Enter)`;
      }
    }
  }

  private countSelectedFiles(): number {
    let count = 0;
    for (const path of this.selectedItems) {
      const item = this.vault.getAbstractFileByPath(path);
      if (item instanceof TFile) {
        count++;
      } else if (item instanceof TFolder) {
        count += this.countFilesInFolder(item);
      }
    }
    return count;
  }

  private countFilesInFolder(folder: TFolder): number {
    let count = 0;
    for (const child of folder.children) {
      if (child instanceof TFile) {
        count++;
      } else if (child instanceof TFolder) {
        count += this.countFilesInFolder(child);
      }
    }
    return count;
  }

  getItems(): (TFile | TFolder)[] {
    const supportedExtensions = [
      "md",
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "mp3",
      "wav",
      "m4a",
      "ogg",
    ];
    const allFiles = this.app.vault.getAllLoadedFiles();

    return allFiles.filter(
      (file) =>
        (this.includeFolders && file instanceof TFolder) ||
        (this.includeFiles &&
          file instanceof TFile &&
          file.extension &&
          supportedExtensions.includes(file.extension.toLowerCase())),
    ) as (TFile | TFolder)[];
  }

  onInputChanged(): void {
    this.updateSuggestions();
  }

  updateSuggestions() {
    const inputEl = this.modalEl.querySelector(
      ".prompt-input",
    ) as HTMLInputElement;
    if (inputEl) {
      const value = inputEl.value;
      //@ts-ignore
      super.updateSuggestions();
      inputEl.value = value;
      inputEl.focus();
    }
  }

  getItemText(item: TFile | TFolder): string {
    return item instanceof TFolder
      ? item.path
      : `${item.basename}\n${item.parent?.path || ""}`;
  }

  renderSuggestion(item: FuzzyMatch<TFile | TFolder>, el: HTMLElement) {
    const content = el.createEl("div", { cls: "suggestion-content" });

    const checkboxContainer = content.createEl("div", {
      cls: "suggestion-checkbox-container",
    });
    const checkbox = checkboxContainer.createEl("input", {
      type: "checkbox",
      cls: "suggestion-checkbox",
    });
    const isSelected =
      this.selectedItems.has(item.item.path) ||
      (item.item instanceof TFolder &&
        this.selectedDirectories.has(item.item.path));
    checkbox.checked = isSelected;
    if (item.item instanceof TFolder) {
      const folderState = this.getFolderState(item.item);
      if (folderState.partiallySelected) {
        checkbox.indeterminate = true;
      }
    }

    const textContainer = content.createEl("div", { cls: "suggestion-text" });
    const titleEl = textContainer.createEl("span", { cls: "suggestion-title" });
    const noteEl = textContainer.createEl("span", { cls: "suggestion-note" });

    if (item.item instanceof TFolder) {
      titleEl.setText("📁 ");
      this.highlightMatches(titleEl, item.item.name, item.match.matches);
      this.highlightMatches(noteEl, item.item.path, item.match.matches);
    } else {
      switch (item.item.extension) {
        case "md":
          titleEl.setText("📄 ");
          break;
        case "pdf":
          titleEl.setText("📕 ");
          break;
        case "png":
        case "jpg":
        case "jpeg":
        case "gif":
          titleEl.setText("🖼️ ");
          break;
        case "mp3":
        case "wav":
        case "m4a":
        case "ogg":
          titleEl.setText("🎵 ");
          break;
        default:
          titleEl.setText("📎 ");
      }
      this.highlightMatches(titleEl, item.item.basename, item.match.matches);
      titleEl.createSpan({
        text: `.${item.item.extension}`,
        cls: "suggestion-file-extension",
      });
      this.highlightMatches(
        noteEl,
        item.item.parent?.path || "",
        item.match.matches,
      );
    }

    // Add click listener to the checkbox
    checkbox.addEventListener("click", (e) => {
      console.log("FileSearcher: Checkbox clicked");
      e.stopPropagation();
      this.toggleSelection(item.item.path);
    });

    // Add click listener to the entire suggestion content (except checkbox)
    content.addEventListener("click", (e) => {
      console.log("FileSearcher: Suggestion clicked");
      if (e.target !== checkbox) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSelection(item.item.path);
        checkbox.checked = this.selectedItems.has(item.item.path);
      }
    });
  }

  private toggleSelection(path: string) {
    const item = this.vault.getAbstractFileByPath(path);
    if (item instanceof TFolder) {
      this.toggleDirectorySelection(item);
    } else {
      this.toggleFileSelection(path);
    }
    this.updateConfirmButtonState();
    this.updateSuggestions();
  }

  private toggleDirectorySelection(folder: TFolder) {
    if (this.selectedDirectories.has(folder.path)) {
      this.selectedDirectories.delete(folder.path);
      this.removeFilesInDirectory(folder);
    } else {
      this.selectedDirectories.add(folder.path);
      this.addFilesInDirectory(folder);
    }
  }

  private toggleFileSelection(path: string) {
    if (this.selectedItems.has(path)) {
      this.selectedItems.delete(path);
    } else {
      this.selectedItems.add(path);
    }
  }

  private addFilesInDirectory(folder: TFolder) {
    folder.children.forEach((child) => {
      if (child instanceof TFile) {
        this.selectedItems.add(child.path);
      } else if (child instanceof TFolder) {
        this.addFilesInDirectory(child);
      }
    });
  }

  private removeFilesInDirectory(folder: TFolder) {
    folder.children.forEach((child) => {
      if (child instanceof TFile) {
        this.selectedItems.delete(child.path);
      } else if (child instanceof TFolder) {
        this.removeFilesInDirectory(child);
      }
    });
  }

  private getFolderState(folder: TFolder): {
    icon: string;
    partiallySelected: boolean;
  } {
    const allFiles = this.getAllFilesInFolder(folder);
    const selectedFiles = allFiles.filter((file) =>
      this.selectedItems.has(file.path),
    );

    if (selectedFiles.length === 0) {
      return { icon: "📁", partiallySelected: false };
    } else if (selectedFiles.length === allFiles.length) {
      return { icon: "📂", partiallySelected: false };
    } else {
      return { icon: "📂", partiallySelected: true };
    }
  }

  private getAllFilesInFolder(folder: TFolder): TFile[] {
    let files: TFile[] = [];
    folder.children.forEach((child) => {
      if (child instanceof TFile) {
        files.push(child);
      } else if (child instanceof TFolder) {
        files = files.concat(this.getAllFilesInFolder(child));
      }
    });
    return files;
  }

  onChooseItem(item: TFile | TFolder, evt: MouseEvent | KeyboardEvent): void {
    console.log("FileSearcher: onChooseItem called", { eventType: evt.type });
    evt.preventDefault();
    evt.stopPropagation();

    if (evt instanceof KeyboardEvent) {
      if (evt.key === "Enter") {
        console.log("FileSearcher: Enter key pressed");
        this.addSelectedItems();
      } else if (evt.key === "Escape") {
        console.log("FileSearcher: Escape key pressed");
        this.close();
      }
    } else if (evt instanceof MouseEvent) {
      console.log("FileSearcher: Mouse event in onChooseItem");
      // Do nothing on mouse click, as it's handled in renderSuggestion
    }
  }

  // Override the chooseItem method to prevent default behavior
  chooseItem(item: TFile | TFolder, evt: MouseEvent | KeyboardEvent): void {
    console.log("FileSearcher: chooseItem called", { eventType: evt.type });
    evt.preventDefault();
    evt.stopPropagation();
    // Do nothing here, let onChooseItem handle the logic
  }

  // Override selectSuggestion to handle keyboard navigation
  selectSuggestion(
    value: FuzzyMatch<TFile | TFolder>,
    evt: MouseEvent | KeyboardEvent,
  ): void {
    console.log("FileSearcher: selectSuggestion called", {
      eventType: evt.type,
    });
    if (evt instanceof KeyboardEvent) {
      if (evt.key === "Enter") {
        this.addSelectedItems();
      } else {
        // Allow default keyboard navigation
        super.selectSuggestion(value, evt);
      }
    } else {
      evt.preventDefault();
      evt.stopPropagation();
    }
  }

  // Override the close method to add additional logging
  close() {
    console.log("FileSearcher: close method called");
    super.close();
  }

  private addSelectedItems() {
    console.log("FileSearcher: Adding selected items");
    const selectedFiles = this.getItems().filter((item) =>
      this.selectedItems.has(item.path),
    );
    if (this.onChooseItems) {
      this.onChooseItems(selectedFiles);
    }
    this.close();
  }

  onChooseItems: ((items: (TFile | TFolder)[]) => void) | null = null;

  private highlightMatches(
    element: HTMLElement,
    text: string,
    matches: SearchMatchPart[],
  ) {
    let lastIndex = 0;
    for (const match of matches) {
      const [start, end] = match;
      if (start >= text.length) continue; // Skip matches outside the current text
      const matchStart = Math.max(start, lastIndex);
      if (matchStart > lastIndex) {
        element.appendText(text.slice(lastIndex, matchStart));
      }
      const matchEnd = Math.min(end, text.length);
      const matchedText = text.slice(matchStart, matchEnd);
      const span = element.createSpan({ cls: "fuzzy-match" });
      span.setText(matchedText);
      lastIndex = matchEnd;
    }
    if (lastIndex < text.length) {
      element.appendText(text.slice(lastIndex));
    }
  }
}
