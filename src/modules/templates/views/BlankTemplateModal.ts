import { Modal } from 'obsidian';
import { TemplatesModule } from '../TemplatesModule';
import { handleStreamingResponse } from '../functions/handleStreamingResponse';
import { showCustomNotice } from '../../../modals';
import { MarkdownView } from 'obsidian';

export class BlankTemplateModal extends Modal {
  private userPromptInput: HTMLTextAreaElement;
  private plugin: TemplatesModule;

  constructor(plugin: TemplatesModule) {
    super(plugin.plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Blank Template' });

    const promptContainer = contentEl.createDiv('prompt-container');
    promptContainer.createEl('label', { text: 'User Prompt:' });
    this.userPromptInput = promptContainer.createEl('textarea', {
      cls: 'user-prompt-input',
    });

    const buttonContainer = contentEl.createDiv('button-container');
    const generateButton = buttonContainer.createEl('button', {
      text: 'Generate',
    });
    generateButton.addEventListener('click', this.handleGenerate.bind(this));
  }

  async handleGenerate(): Promise<void> {
    this.plugin.isGenerationCompleted = false; // Reset generation completion flag
    const userPrompt = this.userPromptInput.value.trim();
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

        const noteContent = editor.getRange({ line: 0, ch: 0 }, { line, ch });

        editor.replaceRange('', { line, ch: 0 }, { line, ch: cursor.ch });

        showCustomNotice('Generating...', 5000);
        console.log('Triggering streaming completion with:');
        console.log('System prompt:', this.plugin.settings.blankTemplatePrompt);
        console.log('User message:', userPrompt);

        if (!this.plugin.abortController) {
          this.plugin.abortController = new AbortController();
        }
        const signal = this.plugin.abortController.signal;

        const model =
          this.plugin.plugin.brainModule.settings.defaultOpenAIModelId;
        const maxTokens = this.plugin.plugin.brainModule.settings.maxTokens;

        await this.plugin.openAIService.createStreamingChatCompletionWithCallback(
          this.plugin.settings.blankTemplatePrompt,
          userPrompt,
          model,
          maxTokens,
          (chunk: string) => {
            console.log('Received chunk:', chunk);
            handleStreamingResponse(chunk, editor, signal);
            console.log('Received [DONE] marker, stopping');
            showCustomNotice('Generation completed!', 5000); // Display the completion notice
            this.plugin.abortController = null; // Reset the abortController
            this.plugin.isGenerationCompleted = true; // Mark generation as completed
            return;
          },
          signal
        );

        console.log('Streaming completion finished');
      }
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
