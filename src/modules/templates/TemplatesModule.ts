import {
  App,
  PluginSettingTab,
  TFile,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  MarkdownView,
} from 'obsidian';
import SystemSculptPlugin from '../../main';
import { renderTemplatesPathSetting } from './settings/TemplatesPathSetting';
import { OpenAIService } from '../../api/OpenAIService';
import { handleStreamingResponse } from './functions/handleStreamingResponse';
import { parseFrontMatter } from './functions/parseFrontMatter';
import { renderTemplateList } from './functions/renderTemplateList';
import { getTemplateFiles } from './functions/getTemplateFiles';
import { searchAndOrderTemplates } from './functions/searchAndOrderTemplates';
import { showCustomNotice } from '../../modals';
import { BlankTemplateModal } from './views/BlankTemplateModal';
import { renderBlankTemplatePromptSetting } from './settings/BlankTemplatePromptSetting';

export interface TemplatesSettings {
  templatesPath: string;
  blankTemplatePrompt: string;
}

export const DEFAULT_TEMPLATES_SETTINGS: TemplatesSettings = {
  templatesPath: 'SystemSculpt/Templates',
  blankTemplatePrompt: `You are an AI assistant tasked with generating concise and specific content based on the user's prompt. Your role is to provide a focused and useful response without unnecessary prose.

Rules:
- Carefully analyze the user's prompt to understand their intent and desired output.
- Generate content that directly addresses the prompt, avoiding tangents or filler text.
- Aim to provide a succinct and actionable response that meets the user's needs.
- Ensure your output is well-structured, clear, and easy to follow.
- Do not introduce any new formatting or markdown syntax unless specifically requested in the prompt.
- Your generation response should be purely the requested content, without any additional labels or explanations.
`,
};

export class TemplatesModule {
  plugin: SystemSculptPlugin;
  settings: TemplatesSettings;
  openAIService: OpenAIService;
  abortController: AbortController | null = null;
  isGenerationCompleted: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.openAIService = plugin.brainModule.openAIService;
  }

  async load() {
    await this.loadSettings();
    this.registerCodeMirror();
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_TEMPLATES_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    new TemplatesSettingTab(this.plugin.app, this, containerEl).display();
  }

  registerCodeMirror() {
    this.plugin.registerEditorSuggest(new TemplatesSuggest(this));
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      console.log('Template generation stopped by user');
      showCustomNotice('Template generation stopped', 5000);
    }
  }
}

class TemplatesSettingTab extends PluginSettingTab {
  plugin: TemplatesModule;

  constructor(app: App, plugin: TemplatesModule, containerEl: HTMLElement) {
    super(app, plugin.plugin);
    this.plugin = plugin;
    this.containerEl = containerEl;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();
    const templatesSettingsH3 = containerEl.createEl('h3', {
      text: 'Templates Settings',
    });
    templatesSettingsH3.addClass('ss-h3');

    renderTemplatesPathSetting(containerEl, this.plugin);
    renderBlankTemplatePromptSetting(containerEl, this.plugin);
  }
}

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
    const templateFiles = getTemplateFiles(
      this.app,
      this.plugin.settings.templatesPath
    );
    const searchResults = await searchAndOrderTemplates(
      this.app,
      templateFiles,
      context.query
    );
    return ['Blank Template', ...searchResults.map(file => file.basename)];
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    if (value === 'Blank Template') {
      el.createEl('div', { text: 'Blank Template' });
    } else {
      const templateFiles = getTemplateFiles(
        this.app,
        this.plugin.settings.templatesPath
      );
      const templateFile = templateFiles.find(file => file.basename === value);
      if (templateFile) {
        renderTemplateList(this.app, value, templateFile, el);
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

      const templateFiles = getTemplateFiles(
        this.app,
        this.plugin.settings.templatesPath
      );
      const templateFile = templateFiles.find(file => file.basename === value);
      if (templateFile) {
        const { vault } = this.app;
        const templateContent = await vault.read(templateFile);
        const { model, maxTokens, prompt } = parseFrontMatter(templateContent);

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          const editor = activeView.editor;
          const cursor = editor.getCursor();
          const line = cursor.line;
          const ch = cursor.ch;

          const noteContent = editor.getRange({ line: 0, ch: 0 }, { line, ch });

          editor.replaceRange('', { line, ch: 0 }, { line, ch: cursor.ch });

          showCustomNotice('Generating...', 5000);
          console.log('Triggering streaming completion with:');
          console.log('System prompt:', prompt);
          console.log('User message:', noteContent);
          console.log('Model:', model);
          console.log('Max tokens:', maxTokens);

          await this.plugin.openAIService.createStreamingChatCompletionWithCallback(
            prompt,
            noteContent,
            model,
            maxTokens,
            (chunk: string) => {
              console.log('Received chunk:', chunk);
              handleStreamingResponse(chunk, editor, signal);
              console.log('Received [DONE] marker, stopping');
              showCustomNotice('Generation completed!', 5000); // Display the completion notice
              this.plugin.abortController = null; // Reset the abortController
              this.plugin.isGenerationCompleted = true; // Mark generation as completed
            },
            signal
          );

          console.log('Streaming completion finished');
        }
      }
    }
  }
}
