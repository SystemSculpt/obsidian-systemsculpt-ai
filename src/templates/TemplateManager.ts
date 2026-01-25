import { App, TFile, Editor, Notice, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, MarkdownView, Plugin } from "obsidian";
import type SystemSculptPlugin from "../main";

/**
 * Template suggestion provider that appears when the user types the template hotkey
 * This works similar to Obsidian's [[ link suggestion feature
 */
class TemplateSuggestProvider extends EditorSuggest<TFile> {
  plugin: SystemSculptPlugin;
  templateFiles: TFile[] = [];
  private listeners: Array<{ element: HTMLElement; type: string; listener: EventListener }> = [];

  constructor(app: App, plugin: SystemSculptPlugin) {
    super(app);
    this.plugin = plugin;

    // Set limit to show more suggestions
    this.limit = 50;

    // Preload templates - make this more aggressive
    this.preloadTemplates();
  }

  // Preload templates with multiple attempts
  private async preloadTemplates() {
    // First attempt - immediate
    await this.loadTemplateFiles();

    // If no templates were found, try again after a short delay
    if (this.templateFiles.length === 0 ||
        (this.templateFiles.length === 1 && this.templateFiles[0].path === "no-templates")) {
      setTimeout(async () => {
        await this.loadTemplateFiles();
      }, 500);
    }
  }

  // Determine when to trigger the suggestion popup
  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    if (!this.plugin.settings.enableTemplateHotkey) return null;

    // Get the current line up to the cursor
    const line = editor.getLine(cursor.line);
    const textBeforeCursor = line.slice(0, cursor.ch);

    // Check if the text contains the template hotkey
    const hotkey = this.plugin.settings.templateHotkey;
    const hotkeyIndex = textBeforeCursor.lastIndexOf(hotkey);

    // Only trigger if the hotkey is at the beginning of the line (possibly with whitespace)
    if (hotkeyIndex >= 0) {
      // Check if there's any text before the hotkey (excluding whitespace)
      const textBeforeHotkey = textBeforeCursor.slice(0, hotkeyIndex);
      const hasTextBeforeHotkey = textBeforeHotkey.trim().length > 0;

      // If there's text before the hotkey, don't trigger
      if (hasTextBeforeHotkey) {
        return null;
      }

      // Check if there's any closing character after the hotkey
      const textAfterHotkey = textBeforeCursor.slice(hotkeyIndex + hotkey.length);
      const hasClosingChar = /[\]\}\)>]/.test(textAfterHotkey);

      // If there's a closing character, don't trigger
      if (hasClosingChar) {
        return null;
      }

      // Always try to refresh template files when triggered
      this.loadTemplateFiles();

      // Extract the query text after the hotkey
      const query = textBeforeCursor.slice(hotkeyIndex + hotkey.length);

      // Return trigger info
      return {
        start: {
          line: cursor.line,
          ch: hotkeyIndex
        },
        end: cursor,
        query: query
      };
    }

    return null;
  }

  // Create a temporary file object to show while loading
  private createTemporaryLoadingFile(): TFile {
    // Create a minimal TFile-like object
    return {
      basename: "Loading templates...",
      extension: "md",
      path: "loading",
      name: "Loading templates...",
      parent: null,
      vault: this.app.vault,
      stat: null,
    } as unknown as TFile;
  }

  // Load template files from the system prompts directory
  private async loadTemplateFiles(): Promise<void> {
    const systemPromptsDir = this.plugin.settings.systemPromptsDirectory;

    if (!systemPromptsDir || systemPromptsDir.trim() === '') {
      this.templateFiles = [this.createNoTemplatesFoundFile()];
      return;
    }

    try {
      // Ensure the directory manager exists before trying to use it
      if (!this.plugin.directoryManager) {
        this.templateFiles = [this.createNoTemplatesFoundFile()];
        return;
      }

      // Ensure the system prompts directory exists using DirectoryManager
      await this.plugin.directoryManager.ensureDirectoryByKey("systemPromptsDirectory");

      // Get all markdown files in the system prompts directory
      const files = this.app.vault.getMarkdownFiles().filter(file =>
        file.path.startsWith(systemPromptsDir)
      );

      // Only update if we found actual templates
      if (files.length > 0) {
        this.templateFiles = files;
      } else if (this.templateFiles.length === 0 ||
                (this.templateFiles.length === 1 &&
                (this.templateFiles[0].path === "loading" || this.templateFiles[0].path === "no-templates"))) {
        // If we still don't have templates, create a helpful message template
        this.templateFiles = [this.createNoTemplatesFoundFile()];
      }
    } catch (error) {
      this.templateFiles = [this.createNoTemplatesFoundFile()];
    }
  }

  // Create a file object to show when no templates are found
  private createNoTemplatesFoundFile(): TFile {
    // Create a minimal TFile-like object
    return {
      basename: "No templates found - Click to create one",
      extension: "md",
      path: "no-templates",
      name: "No templates found - Click to create one",
      parent: null,
      vault: this.app.vault,
      stat: null,
    } as unknown as TFile;
  }

  // Get suggestions based on the query
  getSuggestions(context: EditorSuggestContext): TFile[] {
    const query = context.query.toLowerCase();

    if (!query) {
      // If no query, return all templates
      return this.templateFiles;
    }

    // Split query into words for more flexible matching
    const queryParts = query.split(/\s+/).filter(part => part.length > 0);

    // Score and sort templates based on match quality
    const scoredResults = this.templateFiles.map(file => {
      const basename = file.basename.toLowerCase();
      const path = file.path.toLowerCase();

      // Calculate match score
      let score = 0;

      // Exact match gets highest score
      if (basename === query) {
        score += 100;
      }

      // Basename starts with query (highest priority after exact match)
      if (basename.startsWith(query)) {
        score += 80;
      }

      // Check for word boundary matches (start of words)
      const wordBoundaryMatches = basename.split(/[-_\s]/).filter(word =>
        word.startsWith(query)
      ).length;

      if (wordBoundaryMatches > 0) {
        score += 60 * wordBoundaryMatches;
      }

      // Path contains query
      if (path.includes(query)) {
        score += 30;
      }

      // Check if all query parts are in the basename (grep-like)
      const allPartsMatch = queryParts.every(part => basename.includes(part));
      if (allPartsMatch) {
        score += 40;
      }

      // Check for word boundary matches for each query part
      let wordBoundaryPartMatches = 0;
      for (const part of queryParts) {
        const words = basename.split(/[-_\s]/);
        for (const word of words) {
          if (word.startsWith(part)) {
            wordBoundaryPartMatches++;
            break;
          }
        }
      }

      if (wordBoundaryPartMatches > 0) {
        score += 50 * (wordBoundaryPartMatches / queryParts.length);
      }

      // Check for consecutive character matches (fuzzy search)
      let lastIndex = -1;
      let consecutiveMatches = 0;
      for (const char of query) {
        const index = basename.indexOf(char, lastIndex + 1);
        if (index > lastIndex) {
          lastIndex = index;
          consecutiveMatches++;
        }
      }

      // Add score based on consecutive matches
      if (consecutiveMatches === query.length) {
        score += 20 * (consecutiveMatches / basename.length); // Higher score for denser matches
      }

      return { file, score };
    });

    // Filter out non-matches and sort by score
    const suggestions = scoredResults
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(result => result.file);

    return suggestions;
  }

  // Render each suggestion item
  renderSuggestion(file: TFile, el: HTMLElement): void {
    // Create container for better styling
    const suggestionEl = el.createEl("div", {
      cls: "suggestion-content"
    });

    // Add icon
    const iconEl = suggestionEl.createEl("div", {
      cls: "suggestion-icon"
    });
    iconEl.innerHTML = `<svg viewBox="0 0 100 100" class="document" width="17" height="17"><path fill="currentColor" stroke="currentColor" d="M14,4v92h72V29.2l-0.6-0.6l-24-24L60.8,4H14z M18,8h40v24h24v60H18V8z M62,10.9L79.1,28H62V10.9z"></path></svg>`;

    // Create content container
    const contentEl = suggestionEl.createEl("div", {
      cls: "suggestion-content-inner"
    });

    // Get the current query for highlighting
    const query = this.context?.query?.toLowerCase() || "";
    const basename = file.basename;

    // Add title with highlighted matches
    const titleEl = contentEl.createEl("div", {
      cls: "suggestion-title"
    });

    if (query) {
      // Highlight matching parts
      this.renderHighlightedText(titleEl, basename, query);
    } else {
      // No query, just show the basename
      titleEl.setText(basename);
    }

    // Get the beginning of the template content instead of showing the path
    this.getTemplatePreview(file).then(preview => {
      // Add preview as note
      contentEl.createEl("div", {
        text: preview,
        cls: "suggestion-note"
      });
    }).catch(error => {
      // Fallback to path if there's an error
      contentEl.createEl("div", {
        text: file.path,
        cls: "suggestion-note"
      });
    });

    // Style the container
    suggestionEl.style.display = "flex";
    suggestionEl.style.alignItems = "center";
    suggestionEl.style.gap = "8px";

    // Add hover effect using tracked event listeners
    const mouseEnterHandler = () => {
      el.addClass("is-selected");
    };

    const mouseLeaveHandler = () => {
      if (!el.hasClass("mod-complex-selected")) {
        el.removeClass("is-selected");
      }
    };

    this.registerListener(el, "mouseenter", mouseEnterHandler);
    this.registerListener(el, "mouseleave", mouseLeaveHandler);
  }

  // Helper method to highlight matching text
  private renderHighlightedText(element: HTMLElement, text: string, query: string): void {
    // If query is empty, just set the text
    if (!query) {
      element.setText(text);
      return;
    }

    const lowerText = text.toLowerCase();
    const queryParts = query.split(/\s+/).filter(part => part.length > 0);

    // Create a map of which characters should be highlighted
    const highlightMap = new Array(text.length).fill(false);

    // Mark characters that match the query parts
    for (const part of queryParts) {
      let index = lowerText.indexOf(part);
      while (index !== -1) {
        for (let i = 0; i < part.length; i++) {
          highlightMap[index + i] = true;
        }
        index = lowerText.indexOf(part, index + 1);
      }
    }

    // If no direct matches found, try to highlight individual characters
    if (!highlightMap.some(h => h) && query.length > 0) {
      let lastIndex = -1;
      for (const char of query.toLowerCase()) {
        const index = lowerText.indexOf(char, lastIndex + 1);
        if (index > lastIndex) {
          highlightMap[index] = true;
          lastIndex = index;
        }
      }
    }

    // Create spans with appropriate highlighting
    let currentSpan: HTMLSpanElement | null = null;
    let isHighlighted = false;

    for (let i = 0; i < text.length; i++) {
      // If highlighting state changes, create a new span
      if (highlightMap[i] !== isHighlighted || currentSpan === null) {
        isHighlighted = highlightMap[i];
        currentSpan = element.createEl("span");

        if (isHighlighted) {
          currentSpan.addClass("suggestion-highlight");
        }
      }

      // Add the current character to the span
      currentSpan.textContent += text[i];
    }
  }

  // Helper method to get a preview of the template content
  private async getTemplatePreview(file: TFile): Promise<string> {
    try {
      // Special handling for our placeholder files
      if (file.path === "loading") {
        return "Loading your templates, please wait...";
      }

      if (file.path === "no-templates") {
        return `Create templates in ${this.plugin.settings.systemPromptsDirectory}`;
      }

      // Read the file content
      const content = await this.app.vault.read(file);

      // Get the first non-empty line
      const lines = content.split('\n');
      let preview = '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          // Get the first 50 characters of the first non-empty line
          preview = trimmed.substring(0, 50);
          if (trimmed.length > 50) {
            preview += '...';
          }
          break;
        }
      }

      return preview || 'Empty template';
    } catch (error) {
      return "Error reading template";
    }
  }

  // Handle selection of a template
  async selectSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent): Promise<void> {
    try {
      // Special handling for our placeholder files
      if (file.path === "loading") {
        new Notice("Templates are still loading, please try again in a moment.");
        return;
      }

      if (file.path === "no-templates") {
        // Offer to create a template
        const systemPromptsDir = this.plugin.settings.systemPromptsDirectory;
        new Notice(`Create template files in ${systemPromptsDir} to use this feature.`);

        // Try to open the folder in Obsidian
        const folderExists = await this.app.vault.adapter.exists(systemPromptsDir);
        if (!folderExists) {
          // Use DirectoryManager if available
          if (this.plugin.directoryManager) {
            await this.plugin.directoryManager.ensureDirectoryByPath(systemPromptsDir);
          } else {
            // Fallback to direct creation
            try {
              await this.app.vault.createFolder(systemPromptsDir);
            } catch (error) {
              // Handle directory creation errors
              // Only throw if it's not a "folder exists" error
              if (!(error instanceof Error) || !error.message.includes("already exists")) {
                throw error;
              }
            }
          }
        }

        // Try to open the folder in Obsidian's file explorer
        // This is a best-effort approach as there's no direct API to open folders
        try {
          const folder = this.app.vault.getAbstractFileByPath(systemPromptsDir);
          if (folder) {
            // Try to focus on the folder in the file explorer
            const fileExplorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
            if (fileExplorer) {
              this.app.workspace.revealLeaf(fileExplorer);
              // There's no direct API to select a folder in the file explorer
              // so we'll just let the user know where to find it
              new Notice(`Look for the "${systemPromptsDir}" folder in your file explorer.`);
            }
          }
        } catch (e) {
        }

        return;
      }

      // Get the active editor
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!activeView) return;

      const editor = activeView.editor;

      // Get the content of the selected template
      const content = await this.app.vault.read(file);

      // Open the template modal instead of directly inserting
      if (this.context) {
        // Get the command text that triggered the suggestion
        const commandText = editor.getRange(this.context.start, this.context.end);

        // Import is done dynamically to avoid circular dependencies
        const { showStandardTemplateModal } = await import("../modals/StandardTemplateModal");
        const result = await showStandardTemplateModal(this.app, file.basename, content, {
          plugin: this.plugin,
          commandText: commandText
        });

        // If user confirmed in the modal, insert the content
        if (result) {
          editor.replaceRange(
            result,
            this.context.start,
            this.context.end
          );

        }
      }
    } catch (error) {
      new Notice("Failed to process template content.");
    }
  }

  // Add method to register and track event listeners
  private registerListener(element: HTMLElement, type: string, listener: EventListener): void {
    element.addEventListener(type, listener);
    this.listeners.push({ element, type, listener });
  }

  // Add method to clean up all event listeners - making this public so it can be called from TemplateManager
  public removeAllListeners(): void {
    this.listeners.forEach(({ element, type, listener }) => {
      element.removeEventListener(type, listener);
    });
    this.listeners = [];
  }
}

/**
 * Manages template functionality for the Obsidian plugin
 */
export class TemplateManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  private templateSuggestProvider: TemplateSuggestProvider | null = null;

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;

    try {
      // Verify that the directory manager is initialized
      if (!plugin.directoryManager || !plugin.directoryManager.isInitialized()) {

        // Try to initialize it just in case
        plugin.directoryManager?.initialize().catch(e => {
        });
      }

      // Create and register the template suggest provider
      this.templateSuggestProvider = new TemplateSuggestProvider(app, plugin);

      // Register the provider with the plugin
      plugin.registerEditorSuggest(this.templateSuggestProvider);


    } catch (error) {
      // Create an empty templateSuggestProvider so unload doesn't fail
      this.templateSuggestProvider = null;
    }
  }

  public unload() {
    // Clean up registered event listeners in the suggest provider
    if (this.templateSuggestProvider) {
      this.templateSuggestProvider.removeAllListeners();
    }


  }
}