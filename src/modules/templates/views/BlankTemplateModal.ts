import { Modal, TFile, TFolder } from "obsidian";
import { TemplatesModule, TemplatesSettings } from "../TemplatesModule";
import { handleStreamingResponse } from "../functions/handleStreamingResponse";
import { showCustomNotice } from "../../../modals";
import { MarkdownView } from "obsidian";
import { BrainModule } from "../../brain/BrainModule";
import { MultiSuggest } from "../../../utils/MultiSuggest";

export class BlankTemplateModal extends Modal {
  private userPromptInput: HTMLTextAreaElement;
  private preContextArea: HTMLTextAreaElement;
  private postContextArea: HTMLTextAreaElement;
  private plugin: TemplatesModule;
  private preContextToggle: HTMLInputElement;
  private postContextToggle: HTMLInputElement;
  private systemTemplateInput: HTMLInputElement;
  private copyToClipboardToggle: HTMLInputElement;
  private rememberTemplateToggle: HTMLInputElement;

  constructor(plugin: TemplatesModule) {
    super(plugin.plugin.app);
    this.plugin = plugin;
    this.userPromptInput = document.createElement("textarea");
    this.preContextArea = document.createElement("textarea");
    this.postContextArea = document.createElement("textarea");
    this.preContextToggle = document.createElement("input");
    this.postContextToggle = document.createElement("input");
    this.systemTemplateInput = document.createElement("input");
    this.copyToClipboardToggle = document.createElement("input");
    this.rememberTemplateToggle = document.createElement("input");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("blank-template-modal");

    const modalContent = contentEl.createDiv("modal-content");
    modalContent.createEl("h2", { text: "Blank Template" });

    const infoBox = modalContent.createDiv("info-box");
    infoBox.createEl("p", {
      text: "The Blank Template allows you to generate content based on your custom prompt. Simply enter your prompt, and the AI will generate relevant content for you. This is useful for creating generic content, brainstorming ideas, or getting inspiration for your writing.",
    });

    const contextContainer = modalContent.createDiv("context-container");

    // Add Remember Template toggle
    const rememberTemplateContainer = contextContainer.createDiv(
      "remember-template-container"
    );
    this.rememberTemplateToggle = this.createToggle(
      rememberTemplateContainer,
      "Remember selected template",
      "Automatically use the last selected template for future generations"
    );
    this.rememberTemplateToggle.checked =
      this.plugin.settings.rememberSelectedTemplate;
    this.rememberTemplateToggle.addEventListener("change", async () => {
      this.plugin.settings.rememberSelectedTemplate =
        this.rememberTemplateToggle.checked;
      await this.plugin.saveSettings();
    });

    // Add Copy to Clipboard toggle
    const copyToClipboardContainer = contextContainer.createDiv(
      "copy-to-clipboard-container"
    );
    this.copyToClipboardToggle = this.createToggle(
      copyToClipboardContainer,
      "Copy response to clipboard",
      "Automatically copy the generated response to the clipboard"
    );
    this.copyToClipboardToggle.checked =
      this.plugin.settings.copyResponseToClipboard;
    this.copyToClipboardToggle.addEventListener("change", async () => {
      this.plugin.settings.copyResponseToClipboard =
        this.copyToClipboardToggle.checked;
      await this.plugin.saveSettings();
    });

    // Add system template input
    const systemTemplateContainer = contextContainer.createDiv(
      "system-template-container"
    );
    systemTemplateContainer.createEl("label", {
      text: "System Template:",
      attr: { for: "system-template-input" },
    });
    this.systemTemplateInput = systemTemplateContainer.createEl("input", {
      type: "text",
      placeholder:
        "Enter system template name (LEAVE BLANK FOR NO SYSTEM TEMPLATE)",
      cls: "system-template-input",
    });

    // Set the last selected template if the setting is enabled
    if (
      this.plugin.settings.rememberSelectedTemplate &&
      this.plugin.settings.lastSelectedTemplate
    ) {
      this.systemTemplateInput.value =
        this.plugin.settings.lastSelectedTemplate;
    }

    // Add directory suggestions for system template input
    this.addDirectorySuggestions(this.systemTemplateInput);

    this.preContextArea = contextContainer.createEl("textarea", {
      cls: "context-area pre-context-area",
    });

    this.preContextToggle = this.createToggle(
      contextContainer,
      "Include pre-context",
      "Include the context before the cursor position"
    );

    this.userPromptInput = contextContainer.createEl("textarea", {
      cls: "user-prompt-input",
    });

    const activeView =
      this.plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const editor = activeView.editor;
      const selectedText = editor.getSelection();
      if (selectedText) {
        this.userPromptInput.value = `\n\n<SELECTED TEXT>\n${selectedText}\n</SELECTED TEXT>`;
        setTimeout(() => {
          this.userPromptInput.setSelectionRange(0, 0);
          this.userPromptInput.focus();
        }, 0);
      }
    }

    this.postContextToggle = this.createToggle(
      contextContainer,
      "Include post-context",
      "Include the context after the cursor position"
    );

    this.postContextArea = contextContainer.createEl("textarea", {
      cls: "context-area post-context-area",
    });

    this.preContextToggle.addEventListener("change", () => {
      this.updateContextAreas();
    });
    this.postContextToggle.addEventListener("change", () => {
      this.updateContextAreas();
    });

    const buttonContainer = modalContent.createDiv("button-container");
    const generateButton = buttonContainer.createEl("button", {
      text: "Generate",
    });
    generateButton.addEventListener("click", this.handleGenerate.bind(this));

    this.scope.register(["Mod"], "Enter", this.handleGenerate.bind(this));

    // Set focus based on the "Remember selected template" setting
    setTimeout(() => {
      if (
        this.plugin.settings.rememberSelectedTemplate &&
        this.plugin.settings.lastSelectedTemplate
      ) {
        this.userPromptInput.focus();
      } else {
        this.systemTemplateInput.focus();
      }
    }, 0);
  }

  private updateContextAreas(): void {
    const activeView =
      this.plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const editor = activeView.editor;
      const cursor = editor.getCursor();
      const noteContent = editor.getValue();
      const triggerKey = this.plugin.settings.triggerKey;

      const cursorOffset = editor.posToOffset(cursor);

      const triggerKeyPosition = noteContent.lastIndexOf(
        triggerKey,
        cursorOffset - 1
      );

      const isTriggerKeyDirectlyBeforeCursor =
        triggerKeyPosition + triggerKey.length === cursorOffset;

      const adjustment = isTriggerKeyDirectlyBeforeCursor
        ? triggerKey.length
        : 0;
      const preContextStart = cursorOffset - adjustment;
      const preContext = noteContent.substring(0, preContextStart);
      const postContext = noteContent.substring(cursorOffset);

      this.preContextArea.style.display = this.preContextToggle.checked
        ? "block"
        : "none";
      this.postContextArea.style.display = this.postContextToggle.checked
        ? "block"
        : "none";

      if (this.preContextToggle.checked) {
        this.preContextArea.value = preContext;
      }
      if (this.postContextToggle.checked) {
        this.postContextArea.value = postContext;
      }
    }
  }

  private createToggle(
    container: HTMLElement,
    labelText: string,
    description: string
  ): HTMLInputElement {
    const toggleContainer = container.createDiv("toggle-container");
    const toggle = toggleContainer.createEl("input", {
      type: "checkbox",
    });
    const label = toggleContainer.createEl("label", {
      text: labelText,
    });
    label.title = description;
    return toggle;
  }

  async handleGenerate(): Promise<void> {
    if (!this.plugin.abortController) {
      this.plugin.abortController = new AbortController();
    }
    const signal = this.plugin.abortController.signal;

    const preContext = this.preContextArea.value;
    const postContext = this.postContextArea.value;
    const userPrompt = this.userPromptInput.value.trim();
    const systemTemplate = this.systemTemplateInput.value.trim();

    // Save the selected template if the setting is enabled
    if (this.plugin.settings.rememberSelectedTemplate) {
      this.plugin.settings.lastSelectedTemplate = systemTemplate;
      await this.plugin.saveSettings();
    }

    console.log("Selected system template:", systemTemplate);
    console.log("Templates path:", this.plugin.settings.templatesPath);

    if (userPrompt) {
      this.close();
      const { vault } = this.plugin.plugin.app;
      const activeView =
        this.plugin.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView) {
        const editor = activeView.editor;
        const cursor = editor.getCursor();
        const line = cursor.line;
        const ch = cursor.ch;

        let contextPrompt = "";
        let postSystemPrompt = "Format:\n";

        if (systemTemplate) {
          console.log("Attempting to get system template content");
          const templateContent = await this.getSystemTemplateContent(
            systemTemplate
          );
          console.log("Template content:", templateContent);
          if (templateContent) {
            postSystemPrompt = templateContent + "\n" + postSystemPrompt;
          } else {
            console.error(`System template "${systemTemplate}" not found.`);
            showCustomNotice(
              `System template "${systemTemplate}" not found.`,
              5000
            );
            return;
          }
        }

        if (preContext) {
          contextPrompt += `<PRE-CONTEXT>\n${preContext}\n</PRE-CONTEXT>\n`;
          postSystemPrompt +=
            "- The user included \"pre-context\", which is text that is currently present before the user's cursor; it's text that will precede it.\n";
        }
        if (preContext || postContext) {
          contextPrompt += `<YOUR RESPONSE WILL GO HERE>\n`;
        }
        if (postContext) {
          contextPrompt += `<POST-CONTEXT>\n${postContext}\n</POST-CONTEXT>\n`;
          postSystemPrompt +=
            "- The user included \"post-context\", which is text that is currently present after the user's cursor; it's text that will succeed it.\n";
        }
        if (preContext || postContext) {
          postSystemPrompt +=
            "- Make sure your response makes contextual sense to where it is being placed.";
        }

        editor.replaceRange("", { line, ch: 0 }, { line, ch: cursor.ch });

        showCustomNotice("Generating...");

        let modelInstance;
        try {
          const models =
            await this.plugin.plugin.brainModule.getEnabledModels();

          modelInstance = models.find(
            (m) =>
              m.id === this.plugin.plugin.brainModule.settings.defaultModelId
          );

          if (!modelInstance && models.length > 0) {
            modelInstance = models[0];
          }

          if (modelInstance) {
            this.updateStatusBar(
              this.plugin.plugin.brainModule,
              modelInstance.name
            );
          } else {
            showCustomNotice(
              "No models available. Please check your model settings and ensure at least one provider is enabled."
            );
            return;
          }
        } catch (error) {
          showCustomNotice(
            "Failed to fetch models. Please check your settings and try again."
          );
          return;
        }

        const maxOutputTokens =
          this.plugin.plugin.brainModule.getMaxOutputTokens();

        try {
          await this.plugin.AIService.createStreamingChatCompletionWithCallback(
            this.plugin.settings.blankTemplatePrompt + postSystemPrompt,
            `${userPrompt}\n\n${contextPrompt}`,
            modelInstance.id,
            maxOutputTokens,
            (chunk: string) => {
              if (signal.aborted) {
                return;
              }
              handleStreamingResponse(chunk, editor, this.plugin);
            },
            signal
          );
        } catch (error) {
        } finally {
          this.plugin.abortController = null;
          this.plugin.isGenerationCompleted = true;
        }

        if (this.plugin.settings.copyResponseToClipboard) {
          const generatedContent = editor.getRange(cursor, editor.getCursor());
          await navigator.clipboard.writeText(generatedContent);
        }
      }
    }
  }

  private updateStatusBar(plugin: BrainModule, modelName: string): void {
    if (plugin.plugin.modelToggleStatusBarItem) {
      plugin.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private async getSystemTemplateContent(
    templateName: string
  ): Promise<string | null> {
    const templatesPath = this.plugin.settings.templatesPath;
    console.log("Templates path:", templatesPath);

    const templateFile = this.plugin.plugin.app.vault
      .getFiles()
      .find(
        (file) =>
          file.path.startsWith(templatesPath) && file.basename === templateName
      );

    console.log(
      "Template file found:",
      templateFile ? templateFile.path : "Not found"
    );

    if (templateFile) {
      const content = await this.plugin.plugin.app.vault.read(templateFile);
      const frontMatter =
        this.plugin.plugin.app.metadataCache.getFileCache(
          templateFile
        )?.frontmatter;

      if (frontMatter && frontMatter.prompt) {
        console.log("Using frontmatter prompt");
        return frontMatter.prompt;
      }

      console.log("Using full file content");
      return content;
    }

    console.log("Template file not found");
    return null;
  }

  private addDirectorySuggestions(inputEl: HTMLInputElement): void {
    const templatesPath = this.plugin.settings.templatesPath;
    const templateFolder =
      this.plugin.plugin.app.vault.getAbstractFileByPath(templatesPath);

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
          inputEl.value = selectedTemplate;
          // Save the selected template if the setting is enabled
          if (this.plugin.settings.rememberSelectedTemplate) {
            this.plugin.settings.lastSelectedTemplate = selectedTemplate;
            this.plugin.saveSettings();
          }
          // Focus on the userPromptInput textarea after selecting a template
          setTimeout(() => {
            this.userPromptInput.focus();
          }, 0);
        },
        this.plugin.plugin.app
      );
    }
  }
}
