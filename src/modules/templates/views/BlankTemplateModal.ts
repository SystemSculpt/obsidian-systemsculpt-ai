import { Modal } from 'obsidian';
import { TemplatesModule } from '../TemplatesModule';
import { handleStreamingResponse } from '../functions/handleStreamingResponse';
import { showCustomNotice } from '../../../modals';
import { MarkdownView } from 'obsidian';
import { BrainModule } from '../../brain/BrainModule';

export class BlankTemplateModal extends Modal {
  private userPromptInput: HTMLTextAreaElement;
  private preContextArea: HTMLTextAreaElement;
  private postContextArea: HTMLTextAreaElement;
  private plugin: TemplatesModule;
  private preContextToggle: HTMLInputElement;
  private postContextToggle: HTMLInputElement;

  constructor(plugin: TemplatesModule) {
    super(plugin.plugin.app);
    this.plugin = plugin;
    this.userPromptInput = document.createElement('textarea');
    this.preContextArea = document.createElement('textarea');
    this.postContextArea = document.createElement('textarea');
    this.preContextToggle = document.createElement('input');
    this.postContextToggle = document.createElement('input');
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('blank-template-modal');

    const modalContent = contentEl.createDiv('modal-content');
    modalContent.createEl('h2', { text: 'Blank Template' });

    const infoBox = modalContent.createDiv('info-box');
    infoBox.createEl('p', {
      text: 'The Blank Template allows you to generate content based on your custom prompt. Simply enter your prompt, and the AI will generate relevant content for you. This is useful for creating generic content, brainstorming ideas, or getting inspiration for your writing.',
    });

    const contextContainer = modalContent.createDiv('context-container');

    this.preContextArea = contextContainer.createEl('textarea', {
      cls: 'context-area pre-context-area',
    });

    this.preContextToggle = this.createToggle(
      contextContainer,
      'Include pre-context',
      'Include the context before the cursor position'
    );

    this.userPromptInput = contextContainer.createEl('textarea', {
      cls: 'user-prompt-input',
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
      'Include post-context',
      'Include the context after the cursor position'
    );

    this.postContextArea = contextContainer.createEl('textarea', {
      cls: 'context-area post-context-area',
    });

    this.preContextToggle.addEventListener('change', () => {
      this.updateContextAreas();
    });
    this.postContextToggle.addEventListener('change', () => {
      this.updateContextAreas();
    });

    const buttonContainer = modalContent.createDiv('button-container');
    const generateButton = buttonContainer.createEl('button', {
      text: 'Generate',
    });
    generateButton.addEventListener('click', this.handleGenerate.bind(this));

    this.scope.register(['Mod'], 'Enter', this.handleGenerate.bind(this));
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
        ? 'block'
        : 'none';
      this.postContextArea.style.display = this.postContextToggle.checked
        ? 'block'
        : 'none';

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
    const toggleContainer = container.createDiv('toggle-container');
    const toggle = toggleContainer.createEl('input', {
      type: 'checkbox',
    });
    const label = toggleContainer.createEl('label', {
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

        let contextPrompt = '';
        let postSystemPrompt = 'Format:\n';

        if (preContext) {
          contextPrompt += `<PRE-CONTEXT>\n${preContext}\n</PRE-CONTEXT>\n`;
          postSystemPrompt +=
            '- The user included "pre-context", which is text that is currently present before the user\'s cursor; it\'s text that will precede it.\n';
        }
        if (preContext || postContext) {
          contextPrompt += `<YOUR RESPONSE WILL GO HERE>\n`;
        }
        if (postContext) {
          contextPrompt += `<POST-CONTEXT>\n${postContext}\n</POST-CONTEXT>\n`;
          postSystemPrompt +=
            '- The user included "post-context", which is text that is currently present after the user\'s cursor; it\'s text that will succeed it.\n';
        }
        if (preContext || postContext) {
          postSystemPrompt +=
            '- Make sure your response makes contextual sense to where it is being placed.';
        }

        editor.replaceRange('', { line, ch: 0 }, { line, ch: cursor.ch });

        showCustomNotice('Generating...');

        let modelInstance;
        try {
          const models =
            await this.plugin.plugin.brainModule.getEnabledModels();

          modelInstance = models.find(
            m => m.id === this.plugin.plugin.brainModule.settings.defaultModelId
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
              'No models available. Please check your model settings and ensure at least one provider is enabled.'
            );
            return;
          }
        } catch (error) {
          showCustomNotice(
            'Failed to fetch models. Please check your settings and try again.'
          );
          return;
        }

        const maxOutputTokens = this.plugin.plugin.brainModule.getMaxOutputTokens();

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
}
