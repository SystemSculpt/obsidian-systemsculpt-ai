import {
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  MarkdownView,
  TFile,
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

    if (sub.startsWith('/')) {
      return {
        start: { line: cursor.line, ch: 0 },
        end: { line: cursor.line, ch: sub.length },
        query: sub.substring(1),
      };
    }

    return null;
  }

  async getSuggestions(context: EditorSuggestContext): Promise<string[]> {
    const templateFiles = await getTemplateFiles(
      this.app,
      this.plugin.settings.templatesPath
    );
    const searchResults = await searchAndOrderTemplates(
      this.app,
      templateFiles,
      context.query
    );
    return context.query
      ? searchResults.map(file => file.basename)
      : ['Blank Template', ...searchResults.map(file => file.basename)];
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

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          const editor = activeView.editor;
          const cursor = editor.getCursor();
          const line = cursor.line;
          const ch = cursor.ch;

          const noteContent = editor.getRange({ line: 0, ch: 0 }, { line, ch });

          editor.replaceRange('', { line, ch: 0 }, { line, ch: cursor.ch });

          showCustomNotice('Generating...', 5000);

          await this.plugin.openAIService.createStreamingChatCompletionWithCallback(
            prompt,
            noteContent,
            model,
            maxTokens,
            (chunk: string) => {
              handleStreamingResponse(chunk, editor, signal);
              showCustomNotice('Generation completed!', 5000); // Display the completion notice
              this.plugin.abortController = null; // Reset the abortController
              this.plugin.isGenerationCompleted = true; // Mark generation as completed
            },
            signal
          );
        }
      }
    }
  }
}
