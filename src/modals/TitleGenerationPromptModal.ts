import { App, TFile, Setting, Notice, ButtonComponent } from "obsidian";
import { showPopup } from "../core/ui";
import { attachFileSuggester } from "../components/FileSuggester";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { DEFAULT_TITLE_GENERATION_PROMPT } from "../types";

export interface TitleGenerationPromptResult {
  content: string;
  source: "preset" | "file";
  filePath?: string;
  presetId?: string;
}

/**
 * Simplified title generation prompt modal using chat settings modal styling approach
 */
export class TitleGenerationPromptModal extends StandardModal {
  private result: TitleGenerationPromptResult | null = null;
  private resolvePromise: (value: TitleGenerationPromptResult | null) => void;
  private plugin: SystemSculptPlugin;
  private contentPreview: string;
  private isDocument: boolean;
  private onSubmit: (result: string) => void;

  private promptTextarea: HTMLTextAreaElement;
  private selectedPresetId: string | null;
  private filePath: string;
  private settingsChanged: boolean = false;
  private fileInputEl: HTMLInputElement;
  
  private presets: { id: string; name: string; content: string }[] = [
    {
      id: "precise",
      name: "Precise",
      content: DEFAULT_TITLE_GENERATION_PROMPT
    },
    {
      id: "movie-style", 
      name: "Movie-Style",
      content: `You are a creative title generation assistant focused on creating engaging, movie-style titles.

Your task is to analyze the provided conversation and generate a single, attention-grabbing title that:
- Has a cinematic, dramatic quality similar to movie titles
- Uses creative, evocative language that captures the essence of the conversation
- Is between 2-6 words long
- May use metaphors, wordplay, or allusions when appropriate
- Maintains proper capitalization (typically capitalize all major words)
- NEVER includes characters that are invalid in filenames: \\ / : * ? " < > |
- Uses proper spacing between all words

The title should be memorable and distinctive while still reflecting the actual content of the conversation.
Respond with ONLY the title, nothing else.`
    }
  ];

  constructor(
    app: App,
    plugin: SystemSculptPlugin,
    contentPreview: string,
    isDocument: boolean,
    onSubmit: (result: string) => void
  ) {
    super(app);
    this.modalEl.addClass("ss-chat-settings-modal");
    this.setSize("medium");
    this.plugin = plugin;
    this.contentPreview = contentPreview;
    this.isDocument = isDocument;
    this.onSubmit = onSubmit;

    // Initialize state based on settings
    this.selectedPresetId = plugin.settings.titleGenerationPromptType === "precise" ? "precise" :
                           plugin.settings.titleGenerationPromptType === "movie-style" ? "movie-style" : null;
    this.filePath = plugin.settings.titleGenerationPromptPath || "";
  }

  async onOpen() {
    super.onOpen();

    this.addTitle("Title Generation Prompt", "Configure how your titles should be generated");

    this.createPresetSection();
    this.createFileSection();
    this.createPromptEditorSection();

    this.addActionButton("Close", () => {
      this.close();
    }, true);

    // Initialize content based on current settings
    await this.initializeContent();
  }

  private createPresetSection() {
    const section = this.contentEl.createDiv("ss-chat-settings-modal__section");
    
    section.createEl("h3", {
      text: "Preset Prompts",
      cls: "ss-chat-settings-modal__section-title"
    });

    section.createEl("div", {
      text: "Choose from predefined title generation styles.",
      cls: "ss-chat-settings-modal__prompt-type-details"
    });

    const buttonContainer = section.createDiv("ss-chat-settings-modal__prompt-type-buttons");

    this.presets.forEach(preset => {
      const button = buttonContainer.createEl("button", {
        text: preset.name,
        cls: "ss-preset-button cursor-pointer"
      });

      if (preset.id === this.selectedPresetId) {
        button.addClass("is-active");
      }

      button.addEventListener("click", async () => {
        this.selectedPresetId = preset.id;
        this.promptTextarea.value = preset.content;
        
        // Update button states
        buttonContainer.querySelectorAll(".ss-preset-button").forEach(btn => {
          btn.removeClass("is-active");
        });
        button.addClass("is-active");

        await this.saveSettings("preset", preset.id);
      });
    });
  }

  private createFileSection() {
    const section = this.contentEl.createDiv("ss-chat-settings-modal__section");
    
    section.createEl("h3", {
      text: "Custom File",
      cls: "ss-chat-settings-modal__section-title"
    });

    section.createEl("div", {
      text: "Use a custom prompt from a file in your vault.",
      cls: "ss-chat-settings-modal__prompt-type-details"
    });

    new Setting(section)
      .setName("Prompt File")
      .setDesc("Select a file to use as your title generation prompt")
      .addText(text => {
        this.fileInputEl = text.inputEl;
        text.setPlaceholder("Select a file...")
          .setValue(this.filePath);

        // Attach file suggester
        attachFileSuggester(
          text.inputEl,
          async (selectedPath: string) => {
            this.filePath = selectedPath;
            await this.loadFileContent(selectedPath);
            await this.saveSettings("file", undefined, selectedPath);
          },
          this.app,
          this.plugin.settings.systemPromptsDirectory
        );
      })
      .addButton(button => {
        button.setButtonText("Browse")
          .setIcon("folder")
          .onClick(() => {
            // Trigger the file suggester by focusing the input
            this.fileInputEl.focus();
          });
      });

    new Setting(section)
      .setName("Create New")
      .setDesc("Create a new prompt file")
      .addButton(button => {
        button.setButtonText("Create New Prompt File")
          .setIcon("file-plus")
          .onClick(async () => {
            await this.createNewPromptFile();
          });
      });
  }

  private createPromptEditorSection() {
    const section = this.contentEl.createDiv("ss-chat-settings-modal__section");
    
    section.createEl("h3", {
      text: "Prompt Content",
      cls: "ss-chat-settings-modal__section-title"
    });

    section.createEl("div", {
      text: "Review and edit the prompt content below.",
      cls: "ss-chat-settings-modal__prompt-editor-note"
    });

    this.promptTextarea = section.createEl("textarea", {
      cls: "ss-chat-settings-modal__prompt-textarea",
      attr: {
        placeholder: "Enter your title generation prompt here...",
        rows: "8"
      }
    });

    this.promptTextarea.value = this.contentPreview || DEFAULT_TITLE_GENERATION_PROMPT;
  }

  private async initializeContent() {
    // Load content based on current settings
    if (this.plugin.settings.titleGenerationPromptType === "custom" && this.filePath) {
      await this.loadFileContent(this.filePath);
    } else if (this.selectedPresetId) {
      const preset = this.presets.find(p => p.id === this.selectedPresetId);
      if (preset) {
        this.promptTextarea.value = preset.content;
      }
    }
  }

  private async loadFileContent(filePath: string) {
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        const content = await this.app.vault.read(file);
        this.promptTextarea.value = content;
      }
    } catch (error) {
      this.promptTextarea.value = "Error loading file content.";
    }
  }

  private async createNewPromptFile() {
    const name = await this.showTextInputModal("Create New Prompt", "Enter a name for your prompt file:");
    if (!name) return;

    try {
      const fileName = name.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/ /g, "-");
      const filePath = `${this.plugin.settings.systemPromptsDirectory}/${fileName}.md`;

      const content = DEFAULT_TITLE_GENERATION_PROMPT;

      // Ensure directory exists
      if (this.plugin.directoryManager) {
        await this.plugin.directoryManager.ensureDirectoryByPath(
          this.plugin.settings.systemPromptsDirectory
        );
      }

      // Create the file  
      await this.app.vault.create(filePath, content);

      // Update UI
      this.filePath = filePath;
      this.promptTextarea.value = content;

      const fileInput = this.contentEl.querySelector("input[type='text']") as HTMLInputElement;
      if (fileInput) {
        fileInput.value = filePath;
      }

      await this.saveSettings("file", undefined, filePath);

      new Notice(`Created prompt file: ${fileName}.md`, 3000);
    } catch (error) {
      new Notice("Failed to create prompt file", 3000);
    }
  }

  private async showTextInputModal(title: string, placeholder: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new class extends StandardModal {
        private input: HTMLInputElement;
        private result: string | null = null;

        constructor(app: App) {
          super(app);
          this.setSize("small");
        }

        onOpen() {
          super.onOpen();
          this.addTitle(title);

          this.input = this.contentEl.createEl("input", {
            type: "text",
            placeholder: placeholder,
            cls: "ss-chat-settings-modal__title-input"
          });

          this.addActionButton("Cancel", () => {
            this.close();
          }, false);

          this.addActionButton("Create", () => {
            this.result = this.input.value.trim();
            this.close();
          }, true);

          setTimeout(() => this.input.focus(), 10);
        }

        onClose() {
          resolve(this.result);
          super.onClose();
        }
      }(this.app);

      modal.open();
    });
  }

  private async saveSettings(source: "preset" | "file", presetId?: string, filePath?: string) {
    const content = this.promptTextarea.value;

    const settingsUpdate: any = {
      titleGenerationPrompt: content
    };

    if (source === "preset" && presetId) {
      settingsUpdate.titleGenerationPromptType = presetId as "precise" | "movie-style";
    } else if (source === "file" && filePath) {
      settingsUpdate.titleGenerationPromptType = "custom";
      settingsUpdate.titleGenerationPromptPath = filePath;
    }

    await this.plugin.getSettingsManager().updateSettings(settingsUpdate);
    this.settingsChanged = true;

    this.result = {
      content,
      source,
      presetId,
      filePath
    };
  }

  onClose() {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
    super.onClose();
  }

  async openAndGetValue(): Promise<TitleGenerationPromptResult | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Show the title generation prompt modal and return the result
 */
export async function showTitleGenerationPromptModal(
  app: App,
  plugin: SystemSculptPlugin,
  currentPrompt: string,
  options?: {
    systemPromptsDirectory?: string;
  }
): Promise<TitleGenerationPromptResult | null> {
  const modal = new TitleGenerationPromptModal(
    app,
    plugin,
    currentPrompt,
    true,
    () => {}
  );
  return await modal.openAndGetValue();
}
