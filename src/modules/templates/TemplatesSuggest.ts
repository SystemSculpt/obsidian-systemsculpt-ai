import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  MarkdownView,
  TFile,
  normalizePath,
} from 'obsidian';
import { TemplatesModule } from './TemplatesModule';
import { handleStreamingResponse } from './functions/handleStreamingResponse';
import { parseFrontMatter } from './functions/parseFrontMatter';
import { renderTemplateList } from './functions/renderTemplateList';
import { getTemplateFiles } from './functions/getTemplateFiles';
import { searchAndOrderTemplates } from './functions/searchAndOrderTemplates';
import { showCustomNotice } from '../../modals';
import { BlankTemplateModal } from './views/BlankTemplateModal';

export class TemplatesSuggest extends EditorSuggest<string> {
  plugin: TemplatesModule;

  constructor(plugin: TemplatesModule) {
    super(plugin.plugin.app);
    this.plugin = plugin;
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    file: TFile
  ): EditorSuggestTriggerInfo | null {
    const line = editor.getLine(cursor.line);
    const sub = line.substring(0, cursor.ch);

    if (sub.startsWith(this.plugin.settings.triggerKey)) {
      const selectedText = editor.getSelection();
      if (selectedText) {
        new BlankTemplateModal(this.plugin).open();
        return null;
      }

      return {
        start: { line: cursor.line, ch: 0 },
        end: { line: cursor.line, ch: sub.length },
        query: sub.substring(this.plugin.settings.triggerKey.length),
      };
    }

    return null;
  }

  async getSuggestions(context: EditorSuggestContext): Promise<string[]> {
    const templateFiles = await getTemplateFiles(
      this.app,
      this.plugin.settings.templatesPath
    );
    const filteredTemplateFiles = templateFiles.filter(file =>
      this.shouldIncludeTemplate(file)
    );
    const searchResults = await searchAndOrderTemplates(
      this.app,
      filteredTemplateFiles,
      context.query
    );
    return context.query
      ? searchResults.map(file => file.basename)
      : ['Blank Template', ...searchResults.map(file => file.basename)];
  }

  private shouldIncludeTemplate(file: TFile): boolean {
    if (this.plugin.settings.showSSSyncTemplates) {
      return true;
    }
    const ssSyncFolderPath = normalizePath(
      `${this.plugin.settings.templatesPath}/SS-Sync`
    );
    return !file.path.startsWith(ssSyncFolderPath);
  }

  async renderSuggestion(value: string, el: HTMLElement): Promise<void> {
    if (value === 'Blank Template') {
      el.createEl('div', { text: 'Blank Template' });
    } else {
      const templateFiles = await getTemplateFiles(
        this.app,
        this.plugin.settings.templatesPath
      );
      const templateFile = templateFiles.find(file => file.basename === value);
      if (templateFile) {
        await renderTemplateList(this.app, value, templateFile, el);
      }
    }
  }

  async selectSuggestion(
    value: string,
    evt: MouseEvent | KeyboardEvent
  ): Promise<void> {
    if (value === 'Blank Template') {
      new BlankTemplateModal(this.plugin).open();
      this.plugin.isGenerationCompleted = false; // Reset generation completion flag
    } else {
      if (!this.plugin.abortController) {
        this.plugin.abortController = new AbortController();
      }
      const signal = this.plugin.abortController.signal;

      const templateFiles = await getTemplateFiles(
        this.app,
        this.plugin.settings.templatesPath
      );
      const templateFile = templateFiles.find(file => file.basename === value);
      if (templateFile) {
        const { model, maxTokens, prompt } = await parseFrontMatter(
          this.app,
          templateFile
        );

        let modelInstance;

        if (model === 'local') {
          const localModels = await this.plugin.openAIService.getModels(
            false,
            false
          );
          if (localModels.length > 0) {
            modelInstance = localModels.find(
              m =>
                m.id === this.plugin.plugin.brainModule.settings.defaultModelId
            );
            if (!modelInstance) {
              modelInstance = localModels[0];
            }
          } else {
            showCustomNotice(
              'No local models found; please check your model settings.'
            );
            return;
          }
        } else {
          try {
            modelInstance = await this.plugin.openAIService.getModelById(model);
          } catch (error) {
            console.error('Error fetching model:', error);
            showCustomNotice(
              `The model "${model}" is not available. Please check your template settings.`
            );
            return;
          }
        }

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          const editor = activeView.editor;
          const cursor = editor.getCursor();
          const line = cursor.line;
          const ch = cursor.ch;

          // Remove the trigger and user input before sending the final note state
          editor.replaceRange('', { line, ch: 0 }, { line, ch: cursor.ch });

          const noteContent = editor.getRange({ line: 0, ch: 0 }, { line, ch });

          // Remove only the initial frontmatter from the prompt
          const parts = prompt.split('---');
          let promptWithoutFrontmatter;
          if (parts.length > 2) {
            // Rejoin all parts beyond the first frontmatter block
            promptWithoutFrontmatter = parts.slice(2).join('---').trim();
          } else {
            // If no frontmatter is detected, use the original prompt
            promptWithoutFrontmatter = prompt.trim();
          }

          showCustomNotice('Generating...', 5000);

          try {
            await this.plugin.openAIService.createStreamingChatCompletionWithCallback(
              promptWithoutFrontmatter,
              noteContent,
              modelInstance.id,
              maxTokens,
              (chunk: string) => {
                if (signal.aborted) {
                  console.log('Request was aborted successfully.');
                  return;
                }
                handleStreamingResponse(chunk, editor, this.plugin);
              },
              signal
            );
          } catch (error) {
            if (error.name === 'AbortError') {
              console.log('Request was aborted as expected.');
            } else {
              console.error('Error during streaming chat completion:', error);
            }
          } finally {
            this.plugin.abortController = null;
            this.plugin.isGenerationCompleted = true;
          }
        }
      }
    }
  }
}
