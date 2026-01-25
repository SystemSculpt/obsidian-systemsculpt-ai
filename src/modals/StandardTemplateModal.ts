import { App, Modal, Notice, Platform, TFile, MarkdownView, Setting } from "obsidian";
import { SystemSculptModel } from "../types/llm";
import { StandardModelSelectionModal } from "./StandardModelSelectionModal";
import SystemSculptPlugin from "../main";
import { ChatMessage } from "../types";
import { showAIResponseModal } from "../modals/StandardAIResponseModal";
import { StandardModal } from "../core/ui/modals/standard/StandardModal";
import { ensureCanonicalId } from "../utils/modelUtils";

export interface TemplateModalOptions {
  plugin?: SystemSculptPlugin;
  commandText?: string;
}

export class StandardTemplateModal extends StandardModal {
  private result: string | null = null;
  private resolvePromise: (value: string | null) => void;
  private plugin: SystemSculptPlugin | undefined;
  private originalFile: TFile | null = null;
  private selectedModelId: string = "";
  private currentNoteContent: string = "";
  private commandText: string = "";
  private isPreviewMode: boolean = true;
  private templateContent: string;
  private title: string;

  private modelDropdown: HTMLSelectElement | null = null;
  private templateTextArea: HTMLTextAreaElement | null = null;
  private previewContainer: HTMLElement | null = null;
  private finalPromptTextArea: HTMLTextAreaElement | null = null;

  constructor(
    app: App,
    title: string,
    initialContent: string,
    options: TemplateModalOptions = {}
  ) {
    super(app);
    this.setSize("large");
    this.title = title;
    this.templateContent = initialContent;
    this.plugin = options.plugin;
    this.commandText = options.commandText || "";

    if (this.plugin) {
      this.selectedModelId = this.plugin.settings.selectedModelId || "";
    }

    this.loadCurrentNoteContent();

    if (this.plugin) {
      const systemPromptsDir = this.plugin.settings.systemPromptsDirectory;
      const possiblePath = `${systemPromptsDir}/${this.title}.md`;
      this.originalFile = this.app.vault.getAbstractFileByPath(possiblePath) as TFile;
    }
  }

  private async loadCurrentNoteContent() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      this.currentNoteContent = activeView.getViewData();
      if (this.commandText && this.currentNoteContent.includes(this.commandText)) {
        this.currentNoteContent = this.currentNoteContent.replace(this.commandText, "");
      }
    }
  }

  async onOpen() {
    super.onOpen();

    // Attach Command+Enter shortcut immediately to ensure it works regardless of focus
    this.registerDomEvent(this.modalEl, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (this.plugin) {
          this.processWithAI();
        } else {
        }
      }
    });

    if (this.plugin) {
      try {
        await this.plugin.modelService.validateSelectedModel();
        this.selectedModelId = this.plugin.settings.selectedModelId || "";
      } catch (e) {
      }
    }

    this.addTitle(`System Prompt: ${this.title}`, "Preview and edit template for processing notes");

    this.createModelSection();
    this.createNotePreviewSection();

    // Add final system prompt preview & edit section
    const titleEl = document.createElement("h3");
    titleEl.textContent = "Final System Prompt Preview & Edit";
    titleEl.addClass("ss-modal-title--large");
    this.contentEl.appendChild(titleEl);

    const labelEl = document.createElement("div");
    labelEl.textContent = "Review and edit the final system prompt before sending to AI";
    labelEl.addClass("ss-modal-label--small");
    this.contentEl.appendChild(labelEl);

    const textarea = document.createElement("textarea");
    textarea.value = this.templateContent;
    textarea.addClass("ss-modal-textarea");
    textarea.rows = 12;
    this.contentEl.appendChild(textarea);

    // Add specific event handler to textarea to ensure Command+Enter works
    this.registerDomEvent(textarea, "keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter" && !event.isComposing && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        if (this.plugin) {
          this.processWithAI();
        }
      }
    });

    this.finalPromptTextArea = textarea;

    this.addActionButton("Cancel", () => {
      this.result = null;
      this.close();
    }, false);

    if (this.plugin) {
      const processButton = this.addActionButton("Process with AI", async () => {
        await this.processWithAI();
      }, true, "send");
      processButton.addClass("mod-cta");

      // Add direct click handler as a backup
      this.registerDomEvent(processButton, "click", async () => {
        if (this.plugin) {
          await this.processWithAI();
        }
      });

      const shortcutEl = processButton.createSpan({
        cls: "systemsculpt-shortcut-hint",
        text: Platform.isMacOS ? " (⌘+Enter)" : " (Ctrl+Enter)"
      });
    }
  }

  private createModelSection() {
    const setting = new Setting(this.contentEl)
      .setName("AI Model To Be Used");

    setting.addDropdown(async (dropdown) => {
      dropdown.selectEl.disabled = true;
      dropdown.addOption("", "Loading...");
      if (!this.plugin) return;

      try {
        const models = await this.plugin.modelService.getModels();
        dropdown.selectEl.innerHTML = "";
        for (const model of models) {
          const provider = model.provider || '';
          const prefix = provider.toLowerCase() === "systemsculpt" ? "[SS AI] " : `[${provider.toUpperCase()}] `;
          dropdown.addOption(model.id, `${prefix}${model.name}`);
        }
        dropdown.setValue(this.selectedModelId);
        dropdown.selectEl.disabled = false;
      } catch {
        dropdown.selectEl.innerHTML = "";
        dropdown.addOption("", "Failed to load models");
      }

      dropdown.onChange((value) => {
        this.selectedModelId = value;
      });

      this.modelDropdown = dropdown.selectEl;
    });

    // Add "Change Default Template Model..." button
    const changeDefaultTemplateModelButton = this.contentEl.createEl("button", {
      text: "Change Default Template Model...",
      cls: "ss-template-modal__model-change-default-btn ss-modal-button--small"
    });

    changeDefaultTemplateModelButton.addEventListener("click", async () => {
      if (!this.plugin) {
        new Notice("Cannot change default template model: plugin instance not available", 10000);
        return;
      }

      const modelSelectionOptions = {
        app: this.app,
        plugin: this.plugin,
        currentModelId: this.plugin.settings.defaultTemplateModelId || "",
        onSelect: async (result: { modelId: string }) => {
          try {
            const canonicalId = ensureCanonicalId(result.modelId);
            this.plugin!.settings.defaultTemplateModelId = canonicalId;
            this.plugin!.settings.selectedModelId = canonicalId; // update active model to new default
            await this.plugin!.saveSettings();
            this.selectedModelId = canonicalId;
            if (this.modelDropdown) {
              this.modelDropdown.value = canonicalId;
            }
            new Notice("Default template model updated and set as active model.", 3000);
          } catch (error) {
            new Notice("Failed to update default template model", 10000);
          }
        }
      };

      const modal = new StandardModelSelectionModal(modelSelectionOptions);
      modal.open();
    });
  }

  private createNotePreviewSection() {
    if (!this.currentNoteContent) return;

    const maxPreviewLength = 500;
    const displayContent = this.currentNoteContent.length > maxPreviewLength
      ? this.currentNoteContent.substring(0, maxPreviewLength) + "..."
      : this.currentNoteContent;

    new Setting(this.contentEl)
      .setName("Current Note Content")
      .setDesc(displayContent);
  }

  private async processWithAI() {
      if (!this.plugin) return;

      try {
        const finalPrompt = this.finalPromptTextArea?.value || this.templateContent;

        if (!finalPrompt.trim()) {
          new Notice("System prompt cannot be empty", 10000);
          return;
        }

        if (!this.currentNoteContent.trim()) {
          try {
            const skipWarning = this.plugin.settings.skipEmptyNoteWarning;
            if (!skipWarning) {
              const result = await new Promise<{ confirmed: boolean; checkboxChecked: boolean }>((resolve) => {
                const modal = new class extends Modal {
                  confirmed = false;
                  checkboxChecked = false;
                  constructor(app: App) {
                    super(app);
                  }
                  onOpen() {
                    const { contentEl } = this;
                    contentEl.empty();
                    contentEl.createEl("h3", { text: "Empty Note Detected" });
                    contentEl.createEl("p", { text: "The current note is empty. Are you sure you want to proceed?" });

                    const checkboxContainer = contentEl.createDiv({ cls: "empty-note-checkbox-container" });
                    const checkbox = document.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.id = "skip-empty-note-warning-checkbox";
                    const label = document.createElement("label");
                    label.htmlFor = "skip-empty-note-warning-checkbox";
                    label.textContent = "Do not show this notice again";
                    checkboxContainer.appendChild(checkbox);
                    checkboxContainer.appendChild(label);

                    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });

                    const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
                    cancelButton.addEventListener("click", () => {
                      this.close();
                    });

                    const proceedButton = buttonContainer.createEl("button", { text: "Proceed" });
                    proceedButton.addClass("mod-cta");
                    proceedButton.addEventListener("click", () => {
                      this.confirmed = true;
                      this.checkboxChecked = checkbox.checked;
                      this.close();
                    });

                    this.onClose = () => {
                      resolve({ confirmed: this.confirmed, checkboxChecked: this.checkboxChecked });
                    };
                  }
                }(this.app);
                modal.open();
              });

              if (!result || !result.confirmed) {
                // User cancelled or modal failed
                return;
              }

              if (result.checkboxChecked) {
                try {
                  await this.plugin.getSettingsManager().updateSettings({ skipEmptyNoteWarning: true });
                } catch (e) {
                  // Fail silently, proceed anyway
                }
              }
            }
            // else skipWarning true, proceed
          } catch (e) {
            new Notice("Note content is empty", 10000);
            return;
          }
        }

        if (!this.selectedModelId) {
          new Notice("Please select a model first", 10000);
          return;
        }

        this.close();

        const messages: ChatMessage[] = [
          {
            role: "system",
            content: finalPrompt,
            message_id: this.generateMessageId()
          },
          {
            role: "user",
            content: this.currentNoteContent,
            message_id: this.generateMessageId()
          }
        ];

        showAIResponseModal(this.app, {
          plugin: this.plugin,
          modelId: this.selectedModelId,
          messages: messages,
          commandText: this.commandText,
          // Fix for issue where the "Insert" button did not insert the AI response into the editor.
          // This callback now correctly inserts the AI-generated response at the current cursor position
          // in the active Obsidian editor, resolving the previous bug.
          // Expected behavior: clicking "Insert" places the AI response directly into the note at the cursor.
          onInsert: (response: string) => {
            const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView) {
              const editor = activeView.editor;
              editor.replaceRange(response, editor.getCursor());
            } else {
              new Notice("No active editor to insert AI response");
            }
            this.result = response;
            this.close();
          }
        });
      } catch (error) {
        new Notice("Failed to process note with AI. Please try again.", 10000);
      }
    }

  private generateMessageId(): string {
    return Date.now().toString() + Math.random().toString().substring(2, 8);
  }

  onClose() {
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
    super.onClose();
  }

  async openAndGetValue(): Promise<string | null> {
    return new Promise(resolve => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

export async function showStandardTemplateModal(
  app: App,
  title: string,
  content: string,
  options: TemplateModalOptions = {}
): Promise<string | null> {
  const modal = new StandardTemplateModal(app, title, content, options);
  return await modal.openAndGetValue();
}
