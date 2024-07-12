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
import { showCustomNotice, hideCustomNotice } from '../../modals';
import { BlankTemplateModal } from './views/BlankTemplateModal';
import { logger } from '../../utils/logger';

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
    this.plugin.abortController = new AbortController();
    const signal = this.plugin.abortController.signal;

    if (value === 'Blank Template') {
      new BlankTemplateModal(this.plugin).open();
      this.plugin.isGenerationCompleted = false;
    } else {
      const templateFiles = await getTemplateFiles(
        this.app,
        this.plugin.settings.templatesPath
      );
      const templateFile = templateFiles.find(file => file.basename === value);
      if (templateFile) {
        let { model, maxTokens, prompt } = await parseFrontMatter(
          this.app,
          templateFile
        );

        if (model === 'default') {
          model = this.plugin.plugin.brainModule.settings.defaultModelId;
        }

        let modelInstance;

        try {
          const models = await this.plugin.openAIService.getModels(
            this.plugin.plugin.brainModule.settings.showopenAISetting,
            this.plugin.plugin.brainModule.settings.showgroqSetting,
            this.plugin.plugin.brainModule.settings.showlocalEndpointSetting,
            this.plugin.plugin.brainModule.settings.showopenRouterSetting
          );

          modelInstance = models.find(m => m.id === model);

          if (!modelInstance && models.length > 0) {
            modelInstance = models[0];
            logger.warn(
              `Model "${model}" not found. Using ${modelInstance.id} instead.`
            );
          }
        } catch (error) {
          logger.error('Error fetching models:', error);
          showCustomNotice(
            'Failed to fetch models. Please check your settings and try again.'
          );
          return;
        }

        if (!modelInstance) {
          showCustomNotice(
            'No models available. Please check your model settings and ensure at least one provider is enabled.'
          );
          return;
        }

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          const editor = activeView.editor;
          const cursor = editor.getCursor();
          const line = cursor.line;
          const ch = cursor.ch;

          editor.replaceRange('', { line, ch: 0 }, { line, ch: cursor.ch });

          const noteContent = editor.getRange({ line: 0, ch: 0 }, { line, ch });

          const parts = prompt.split('---');
          let promptWithoutFrontmatter =
            parts.length > 2
              ? parts.slice(2).join('---').trim()
              : prompt.trim();

          showCustomNotice('Generating...', 5000, true);

          try {
            await this.plugin.openAIService.createStreamingChatCompletionWithCallback(
              promptWithoutFrontmatter,
              noteContent,
              modelInstance.id,
              maxTokens,
              (chunk: string) => {
                if (signal.aborted) {
                  logger.log('Request was aborted successfully.');
                  return;
                }
                handleStreamingResponse(chunk, editor, this.plugin);
              },
              signal
            );
          } catch (error) {
            if (error.name === 'AbortError') {
              logger.log('Request was aborted as expected.');
            } else {
              logger.error('Error during streaming chat completion:', error);
            }
          } finally {
            hideCustomNotice();
            this.plugin.abortController = null;
            this.plugin.isGenerationCompleted = true;
          }
        }
      }
    }
  }
}
