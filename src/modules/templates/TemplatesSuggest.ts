import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  MarkdownView,
  TFile,
  TFolder,
  normalizePath,
} from 'obsidian';
import { TemplatesModule } from './TemplatesModule';
import { handleStreamingResponse } from './functions/handleStreamingResponse';
import { showCustomNotice } from '../../modals';
import { BlankTemplateModal } from './views/BlankTemplateModal';

export interface FrontMatter {
  name: string;
  description: string;
  model: string;
  maxOutputTokens?: number;
  tags: string[];
  prompt: string;
}

interface TemplateItem {
  file: TFile | null;
  frontMatter: FrontMatter;
  modelName: string;
}

export class TemplatesSuggest extends EditorSuggest<TemplateItem> {
  plugin: TemplatesModule;
  private lastQuery: string = '';

  constructor(plugin: TemplatesModule) {
    super(plugin.plugin.app);
    this.plugin = plugin;
  }

  async parseFrontMatter(file: TFile): Promise<FrontMatter> {
    const fileCache = this.app.metadataCache.getFileCache(file);
    const frontMatter = fileCache?.frontmatter;

    if (frontMatter) {
      return {
        name: frontMatter.name || '',
        description: frontMatter.description || '',
        model: frontMatter.model || 'default',
        maxOutputTokens:
          frontMatter['max tokens'] ||
          frontMatter['max_tokens'] ||
          frontMatter['max output tokens'] ||
          frontMatter['max_output_tokens'] ||
          undefined,
        tags:
          typeof frontMatter.tags === 'string'
            ? frontMatter.tags.split(',').map((tag: string) => tag.trim())
            : Array.isArray(frontMatter.tags)
            ? frontMatter.tags
            : [],
        prompt: await this.app.vault.read(file),
      };
    }

    return {
      name: '',
      description: '',
      model: '',
      maxOutputTokens: 0,
      tags: [],
      prompt: '',
    };
  }

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    file: TFile
  ): EditorSuggestTriggerInfo | null {
    if (!this.plugin.settings.triggerKey) {
      return null;
    }

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

  async getSuggestions(context: EditorSuggestContext): Promise<TemplateItem[]> {
    const templateFiles = await this.getTemplateFiles(
      this.app,
      this.plugin.settings.templatesPath
    );
    const filteredTemplateFiles = templateFiles.filter(file =>
      this.shouldIncludeTemplate(file)
    );
    const templateItems: TemplateItem[] = await Promise.all(
      filteredTemplateFiles.map(async file => {
        const frontMatter = await this.parseFrontMatter(file);
        const modelName = this.getModelName(frontMatter.model);
        return {
          file,
          frontMatter,
          modelName,
        };
      })
    );

    const blankTemplate = {
      file: null,
      frontMatter: {
        name: 'Blank Template',
        description: 'Create a custom prompt',
        model: '',
        tags: [],
        prompt: '',
      },
      modelName: 'current',
    };

    if (!context.query) {
      return [blankTemplate, ...templateItems];
    }

    this.lastQuery = context.query;
    const fuzzySearchResults = this.fuzzySearch(templateItems, context.query);
    
    if ('blank template'.includes(context.query.toLowerCase())) {
      return [blankTemplate, ...fuzzySearchResults];
    }

    return fuzzySearchResults;
  }

  private getModelName(model: string): string {
    if (model === 'default') {
      return 'current';
    } else if (model === 'local') {
      return 'local';
    } else {
      return model;
    }
  }

  private fuzzySearch(items: TemplateItem[], query: string): TemplateItem[] {
    const lowercaseQuery = query.toLowerCase();
    return items
      .map(item => ({
        item,
        score: Math.max(
          this.fuzzyScore(item.frontMatter.name.toLowerCase(), lowercaseQuery),
          this.fuzzyScore(item.modelName.toLowerCase(), lowercaseQuery),
          this.fuzzyScoreTags(item.frontMatter.tags, lowercaseQuery)
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => item);
  }

  private fuzzyScoreTags(tags: string[], query: string): number {
    return Math.max(...tags.map(tag => this.fuzzyScore(tag.toLowerCase(), query)), 0);
  }

  private fuzzyScore(str: string, query: string): number {
    let score = 0;
    let strIndex = 0;
    let prevMatchIndex = -1;

    for (let i = 0; i < query.length; i++) {
      const queryChar = query[i];
      let found = false;

      for (let j = strIndex; j < str.length; j++) {
        if (str[j] === queryChar) {
          strIndex = j + 1;
          found = true;

          if (j === prevMatchIndex + 1) {
            score += 3;
          } else {
            score += 2;
          }

          if (j === 0 || str[j - 1] === ' ') {
            score += 2;
          }

          prevMatchIndex = j;
          break;
        }
      }

      if (!found) return 0;
    }

    return score;
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

  renderSuggestion(item: TemplateItem, el: HTMLElement): void {
    const { name, description } = item.frontMatter;

    el.addClass('template-suggestion');
    el.empty();

    const contentEl = el.createDiv({ cls: 'template-content' });
    const nameEl = contentEl.createEl('div', { cls: 'template-name' });
    const descEl = contentEl.createEl('div', { cls: 'template-description' });
    
    const metaEl = el.createDiv({ cls: 'template-meta' });
    const modelEl = metaEl.createEl('div', { cls: 'template-model' });
    const tagsEl = metaEl.createEl('div', { cls: 'template-tags' });

    if (item.file === null) {
      nameEl.setText('Blank Template');
      descEl.setText('Create a custom prompt');
      modelEl.setText('Model: current');
    } else {
      this.highlightMatches(nameEl, name);
      this.highlightMatches(descEl, description);
      modelEl.setText(`Model: ${item.modelName}`);
      
      if (item.frontMatter.tags && item.frontMatter.tags.length > 0) {
        item.frontMatter.tags.forEach(tag => {
          tagsEl.createEl('span', { text: tag, cls: 'template-tag' });
        });
      }
    }
  }

  private highlightMatches(el: HTMLElement, text: string): void {
    const lowercaseText = text.toLowerCase();
    const lowercaseQuery = this.lastQuery.toLowerCase();
    let lastIndex = 0;
    let index = 0;

    for (const char of lowercaseQuery) {
      index = lowercaseText.indexOf(char, lastIndex);
      if (index === -1) break;

      if (index > lastIndex) {
        el.appendText(text.slice(lastIndex, index));
      }
      el.createSpan({ text: text[index], cls: 'fuzzy-match' });
      lastIndex = index + 1;
    }

    if (lastIndex < text.length) {
      el.appendText(text.slice(lastIndex));
    }
  }

  async selectSuggestion(
    item: TemplateItem,
    evt: MouseEvent | KeyboardEvent
  ): Promise<void> {
    this.plugin.abortController = new AbortController();
    const signal = this.plugin.abortController.signal;

    if (item.file === null) {
      new BlankTemplateModal(this.plugin).open();
      this.plugin.isGenerationCompleted = false;
    } else {
      let { model, maxOutputTokens, prompt } = item.frontMatter;

      if (model === 'default') {
        model = this.plugin.plugin.brainModule.settings.defaultModelId;
      }

      let modelInstance;

      try {
        const models = await this.plugin.plugin.brainModule.getEnabledModels();

        modelInstance = models.find(m => m.id === model);

        if (!modelInstance && models.length > 0) {
          modelInstance = models[0];
        }
      } catch (error) {
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
          parts.length > 2 ? parts.slice(2).join('---').trim() : prompt.trim();

        showCustomNotice('Generating...');

        try {
          await this.plugin.AIService.createStreamingChatCompletionWithCallback(
            promptWithoutFrontmatter,
            noteContent,
            modelInstance.id,
            maxOutputTokens || 0,
            (chunk: string) => {
              if (signal.aborted) {
                return;
              }
              handleStreamingResponse(chunk, editor, this.plugin);
            },
            signal
          );
        } catch (error) {
          // @ts-ignore
          if (error.name === 'AbortError') {
          } else {
          }
        } finally {
          this.plugin.abortController = null;
          this.plugin.isGenerationCompleted = true;
        }
      }
    }
  }

  async getTemplateFiles(app: App, templatesPath: string): Promise<TFile[]> {
    const { vault } = app;
    const templateFolder = vault.getAbstractFileByPath(templatesPath);

    const recursivelyCollectTemplates = async (
      folder: TFolder
    ): Promise<TFile[]> => {
      let templates: TFile[] = [];
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          templates = templates.concat(
            await recursivelyCollectTemplates(child)
          );
        } else if (child instanceof TFile) {
          const frontMatter = await this.parseFrontMatter(child);
          if (
            frontMatter.name &&
            frontMatter.description &&
            frontMatter.model
          ) {
            templates.push(child);
          }
        }
      }
      return templates;
    };

    if (templateFolder instanceof TFolder) {
      return await recursivelyCollectTemplates(templateFolder);
    }

    return [];
  }

  async renderTemplateList(
    app: App,
    value: string,
    templateFile: TFile,
    el: HTMLElement
  ): Promise<void> {
    const frontMatter = await this.parseFrontMatter(templateFile);
    const { name, description, model, maxOutputTokens, tags } = frontMatter;

    el.empty();

    const nameEl = el.createEl('h2');
    nameEl.textContent = name;
    nameEl.addClass('template-name');

    const descriptionEl = el.createEl('p');
    const truncatedDescription =
      description.length > 125
        ? `${description.substring(0, 125)}...`
        : description;
    descriptionEl.textContent = truncatedDescription;
    descriptionEl.addClass('template-description');

    const metaEl = el.createEl('div', { cls: 'template-meta' });

    const modelEl = metaEl.createEl('span', { cls: 'template-meta-item' });
    modelEl.textContent = model === 'default' ? 'current' : model;

    const maxOutputTokensEl = metaEl.createEl('span', {
      cls: 'template-meta-item',
    });
    maxOutputTokensEl.textContent = `${maxOutputTokens} max`;

    const tagsContainer = metaEl.createEl('div', { cls: 'template-tags' });
    tags.forEach((tag: string, index: number) => {
      const tagEl = tagsContainer.createEl('span', { cls: 'template-tag' });
      tagEl.textContent = tag.trim();
    });
  }

  async searchAndOrderTemplates(
    app: App,
    templateFiles: TFile[],
    query: string
  ): Promise<TFile[]> {
    if (!query) {
      return templateFiles;
    }

    const lowerCaseQuery = query.toLowerCase();
    const scoredTemplates = await Promise.all(
      templateFiles.map(async file => {
        const { name, description } = await this.parseFrontMatter(file);
        const nameScore = name.toLowerCase().includes(lowerCaseQuery) ? 1 : 0;
        const descriptionScore = description
          .toLowerCase()
          .includes(lowerCaseQuery)
          ? 1
          : 0;
        return {
          file,
          score: nameScore + descriptionScore,
        };
      })
    );

    return scoredTemplates
      .sort((a, b) => b.score - a.score)
      .map(({ file }) => file);
  }
}
