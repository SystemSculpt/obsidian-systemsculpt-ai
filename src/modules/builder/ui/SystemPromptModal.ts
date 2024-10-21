import { App, Modal, TFile, TFolder } from "obsidian";
import { TemplatesModule } from "../../templates/TemplatesModule";
import { MultiSuggest } from "../../../utils/MultiSuggest";

export class SystemPromptModal extends Modal {
  private plugin: TemplatesModule;
  private onChoose: (selectedPrompt: string) => void;

  constructor(
    app: App,
    plugin: TemplatesModule,
    onChoose: (selectedPrompt: string) => void
  ) {
    super(app);
    this.plugin = plugin;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const inputEl = contentEl.createEl("input", {
      type: "text",
      placeholder: "Choose a system prompt",
    });

    this.addDirectorySuggestions(inputEl);
  }

  private addDirectorySuggestions(inputEl: HTMLInputElement): void {
    const templatesPath = this.plugin.settings.templatesPath;
    const templateFolder = this.app.vault.getAbstractFileByPath(templatesPath);

    if (templateFolder instanceof TFolder) {
      const suggestionContent = new Set<string>();

      const addTemplateFiles = (folder: TFolder) => {
        for (const child of folder.children) {
          if (child instanceof TFile && child.extension === "md") {
            suggestionContent.add(child.basename);
          } else if (child instanceof TFolder) {
            addTemplateFiles(child);
          }
        }
      };

      addTemplateFiles(templateFolder);

      new MultiSuggest(
        inputEl,
        suggestionContent,
        (selectedTemplate: string) => {
          this.onChoose(selectedTemplate);
          this.close();
        },
        this.app
      );
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
