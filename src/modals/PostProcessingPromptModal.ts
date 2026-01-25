import { App, TFile, Setting, Notice, ButtonComponent } from "obsidian";
import { showPopup } from "../core/ui";
import { attachFileSuggester } from "../components/FileSuggester";
import type SystemSculptPlugin from "../main";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";

export interface PostProcessingPromptResult {
  content: string;
  source: "preset" | "file";
  filePath?: string;
  presetId?: string;
}

/**
 * Post-processing prompt modal - completely rewritten for clarity and reliability
 */
export class PostProcessingPromptModal extends StandardModal {
  private result: PostProcessingPromptResult | null = null;
  private resolvePromise: (value: PostProcessingPromptResult | null) => void;
  private plugin: SystemSculptPlugin;
  private systemPromptsDirectory: string;

  private promptTextarea: HTMLTextAreaElement;
  private presetButtonContainer: HTMLElement;
  private presetDescriptionEl: HTMLElement;
  private fileInputEl: HTMLInputElement;
  
  private presets: Array<{id: string, name: string, description: string, content: string}> = [
    {
      id: "transcript-cleaner",
      name: "Transcript Cleaner",
      description: "Clean up transcription errors and improve readability",
      content: `You are a transcription post-processor. Your task is to fix any transcription errors, correct grammar and punctuation, and ensure the text is properly formatted. Keep the original meaning intact while making the text more readable.

Please process the following raw transcript to:
- Fix grammar, punctuation, and capitalization
- Remove filler words (um, uh, like, you know)
- Format into clear paragraphs
- Maintain the original meaning and speaker's voice

Raw transcript:`
    },
    {
      id: "meeting-summarizer", 
      name: "Meeting Summarizer",
      description: "Summarize meeting transcripts into key points and action items",
      content: `You are a meeting transcript processor. Transform the raw transcript into a structured summary that captures the essential information.

Please process the following meeting transcript to create:
- Executive summary (2-3 sentences)
- Key discussion points
- Decisions made
- Action items with responsible parties (if mentioned)
- Follow-up items

Format the output in clear sections with appropriate headings.

Raw transcript:`
    },
    {
      id: "interview-formatter",
      name: "Interview Formatter", 
      description: "Format interview transcripts with proper speaker attribution",
      content: `You are an interview transcript formatter. Your task is to clean up and properly format interview transcripts with clear speaker attribution and improved readability.

Please process the following interview transcript to:
- Identify and label speakers consistently (Interviewer, Interviewee, etc.)
- Remove filler words and false starts
- Correct grammar and punctuation
- Break into clear question-and-answer segments
- Maintain the natural flow of conversation

Raw transcript:`
    }
  ];

  constructor(
    app: App,
    plugin: SystemSculptPlugin,
    initialPrompt: string,
    systemPromptsDirectory: string = "SystemSculpt/System Prompts"
  ) {
    super(app);
    this.modalEl.addClass("ss-chat-settings-modal");
    this.setSize("medium");
    this.plugin = plugin;
    this.systemPromptsDirectory = systemPromptsDirectory;
  }

  async onOpen() {
    super.onOpen();

    this.addTitle("Post-Processing Prompt", "Configure how your transcriptions should be processed");

    this.createPresetSection();
    this.createFileSection();
    this.createPromptEditorSection();

    this.addActionButton("Close", () => {
      this.close();
    }, true);

    // Load current state
    await this.loadCurrentState();
  }

  private createPresetSection() {
    const section = this.contentEl.createDiv("ss-chat-settings-modal__section");
    
    section.createEl("h3", {
      text: "Preset Prompts",
      cls: "ss-chat-settings-modal__section-title"
    });

    section.createEl("div", {
      text: "Choose from predefined post-processing styles.",
      cls: "ss-chat-settings-modal__prompt-type-details"
    });

    this.presetButtonContainer = section.createDiv("ss-chat-settings-modal__prompt-type-buttons");

    this.presets.forEach(preset => {
      const button = this.presetButtonContainer.createEl("button", {
        text: preset.name,
        cls: "ss-preset-button cursor-pointer"
      });
      
      button.setAttribute("data-preset-id", preset.id);

      button.addEventListener("click", async () => {
        await this.selectPreset(preset.id);
      });
    });

    this.presetDescriptionEl = section.createEl("div", {
      cls: "ss-chat-settings-modal__prompt-type-details",
      attr: { style: "display: none;" }
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
      .setDesc("Select a file to use as your post-processing prompt")
      .addText(text => {
        this.fileInputEl = text.inputEl;
        text.setPlaceholder("Select a file...");

        attachFileSuggester(
          text.inputEl,
          async (selectedPath: string) => {
            await this.selectFile(selectedPath);
          },
          this.app,
          this.systemPromptsDirectory
        );
      })
      .addButton(button => {
        button.setButtonText("Browse")
          .setIcon("folder")
          .onClick(() => {
            // Trigger the file suggester directly
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
        placeholder: "Enter your post-processing prompt here...",
        rows: "8"
      }
    });
  }

  private async loadCurrentState() {
    const settings = this.plugin.settings;
    
    if (settings.postProcessingPromptType === "preset" && settings.postProcessingPromptPresetId) {
      // Load preset
      await this.selectPreset(settings.postProcessingPromptPresetId);
    } else if (settings.postProcessingPromptType === "file" && settings.postProcessingPromptFilePath) {
      // Load file
      await this.selectFile(settings.postProcessingPromptFilePath);
    } else if (settings.postProcessingPrompt) {
      // Load saved content
      this.promptTextarea.value = settings.postProcessingPrompt;
    } else {
      // Default to first preset
      await this.selectPreset(this.presets[0].id);
    }
  }

  private async selectPreset(presetId: string) {
    const preset = this.presets.find(p => p.id === presetId);
    if (!preset) return;

    // Update UI
    this.promptTextarea.value = preset.content;
    this.updatePresetButtons(presetId);
    this.updatePresetDescription(preset);
    this.clearFileSelection();

    // Save to settings
    await this.saveToSettings("preset", preset.content, presetId, "");
  }

  private async selectFile(filePath: string) {
    try {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        throw new Error("File not found");
      }

      const content = await this.app.vault.read(file);
      
      // Update UI
      this.promptTextarea.value = content;
      this.fileInputEl.value = filePath;
      this.clearPresetSelection();

      // Save to settings
      await this.saveToSettings("file", content, "", filePath);
    } catch (error) {
      new Notice("Failed to load file. Please check the file path and try again.", 3000);
    }
  }

  private async createNewPromptFile() {
    const name = await this.showTextInputModal("Create New Prompt", "Enter a name for your prompt file:");
    if (!name) return;

    try {
      const fileName = name.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/ /g, "-");
      const filePath = `${this.systemPromptsDirectory}/${fileName}.md`;

      const content = `You are a transcription post-processor. Your task is to fix any transcription errors, correct grammar and punctuation, and ensure the text is properly formatted. Keep the original meaning intact while making the text more readable.

Please process the following raw transcript to:
- Fix grammar, punctuation, and capitalization
- Remove filler words (um, uh, like, you know)
- Format into clear paragraphs
- Maintain the original meaning and speaker's voice

Raw transcript:`;

      // Check if file already exists
      const existingFile = this.app.vault.getAbstractFileByPath(filePath);
      if (existingFile) {
        const confirmOverwrite = await showPopup(this.app, "", {
          title: "File Already Exists",
          description: `A file named "${fileName}.md" already exists. Do you want to overwrite it?`,
          primaryButton: "Overwrite",
          secondaryButton: "Cancel"
        });

        if (!confirmOverwrite) {
          return;
        }
      }

      // Ensure directory exists
      if (this.plugin.directoryManager) {
        await this.plugin.directoryManager.ensureDirectoryByPath(this.systemPromptsDirectory);
      } else {
        try {
          await this.app.vault.createFolder(this.systemPromptsDirectory);
        } catch (error) {
          if (!error.message.includes("already exists")) {
            throw error;
          }
        }
      }

      // Create or overwrite the file
      if (existingFile) {
        await this.app.vault.modify(existingFile as TFile, content);
      } else {
        await this.app.vault.create(filePath, content);
      }

      // Select the new file
      await this.selectFile(filePath);

      new Notice(`${existingFile ? "Updated" : "Created"} prompt file: ${fileName}.md`, 3000);
    } catch (error) {
      new Notice("Failed to create prompt file", 3000);
    }
  }

  private updatePresetButtons(selectedId: string) {
    this.presetButtonContainer.querySelectorAll(".ss-preset-button").forEach(btn => {
      btn.removeClass("is-active");
      if (btn.getAttribute("data-preset-id") === selectedId) {
        btn.addClass("is-active");
      }
    });
  }

  private updatePresetDescription(preset: {description: string}) {
    this.presetDescriptionEl.textContent = preset.description;
    this.presetDescriptionEl.style.display = "block";
  }

  private clearPresetSelection() {
    this.presetButtonContainer.querySelectorAll(".ss-preset-button").forEach(btn => {
      btn.removeClass("is-active");
    });
    this.presetDescriptionEl.style.display = "none";
  }

  private clearFileSelection() {
    this.fileInputEl.value = "";
  }

  private async saveToSettings(type: "preset" | "file", content: string, presetId: string, filePath: string) {
    await this.plugin.getSettingsManager().updateSettings({
      postProcessingPromptType: type,
      postProcessingPrompt: content,
      postProcessingPromptPresetId: presetId,
      postProcessingPromptFilePath: filePath
    });
    
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

  async onClose() {
    // Save current content
    if (this.promptTextarea) {
      await this.plugin.getSettingsManager().updateSettings({
        postProcessingPrompt: this.promptTextarea.value
      });
    }

    if (this.resolvePromise) {
      this.result = {
        content: this.promptTextarea.value,
        source: this.plugin.settings.postProcessingPromptType as "preset" | "file",
        presetId: this.plugin.settings.postProcessingPromptPresetId || undefined,
        filePath: this.plugin.settings.postProcessingPromptFilePath || undefined
      };

      this.resolvePromise(this.result);
    }
    super.onClose();
  }

  async openAndGetResult(): Promise<PostProcessingPromptResult | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

/**
 * Show the post-processing prompt modal and return the result
 * @deprecated Use PostProcessingPromptModal directly with openAndGetResult()
 */
export async function showPostProcessingPromptModal(
  app: App,
  plugin: SystemSculptPlugin,
  currentPrompt: string,
  options?: {
    systemPromptsDirectory?: string;
  }
): Promise<PostProcessingPromptResult | null> {
  const modal = new PostProcessingPromptModal(
    app,
    plugin,
    currentPrompt,
    options?.systemPromptsDirectory || "SystemSculpt/System Prompts"
  );
  return await modal.openAndGetResult();
}