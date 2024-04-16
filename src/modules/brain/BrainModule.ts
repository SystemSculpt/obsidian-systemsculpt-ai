import SystemSculptPlugin from '../../main';
import {
  BrainSettings,
  DEFAULT_BRAIN_SETTINGS,
} from './settings/BrainSettings';
import { OpenAIService } from '../../api/OpenAIService';
import { BrainSettingTab } from './settings/BrainSettingTab';
import { generateTitle } from './functions/generateTitle';
import { generateTitleForCurrentNote } from './functions/generateTitleForCurrentNote';
import { renderBrainAnimation } from './views/BrainAnimation';
import { toggleGeneration } from './functions/toggleGeneration';
import { MaxTokensModal } from './views/MaxTokensModal';
import { updateMaxTokensStatusBar } from './functions/updateMaxTokensStatusBar';
import { MarkdownView } from 'obsidian';
import { IGenerationModule } from '../../interfaces/IGenerationModule';
import { showCustomNotice } from '../../modals';

export class BrainModule implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings: BrainSettings;
  openAIService: OpenAIService;
  abortController: AbortController | null = null;
  isGenerating: boolean = false;
  isGenerationCompleted: boolean = false;

  constructor(plugin: SystemSculptPlugin, openAIService: OpenAIService) {
    this.plugin = plugin;
    this.openAIService = openAIService;
  }

  async load() {
    await this.loadSettings();

    this.plugin.addCommand({
      id: 'generate-note-title',
      name: 'Generate title for current note',
      callback: async () => {
        await this.generateTitleForCurrentNote();
      },
    });

    this.plugin.addCommand({
      id: 'toggle-general-generation',
      name: 'Toggle general generation',
      callback: async () => {
        await this.toggleGeneration();
      },
    });

    this.plugin.addCommand({
      id: 'toggle-model',
      name: 'Toggle model',
      callback: () => {
        this.switchModel();
        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        if (activeLeaf && activeLeaf.view.getViewType() === 'markdown') {
          const markdownView = activeLeaf.view as MarkdownView;
          markdownView.editor.focus();
        }
      },
    });

    this.plugin.addCommand({
      id: 'change-max-tokens',
      name: 'Change max tokens',
      callback: () => {
        new MaxTokensModal(this.plugin.app, this).open();
      },
    });

    // Initialize status bar for Max Tokens
    if (!this.plugin.maxTokensToggleStatusBarItem) {
      this.plugin.maxTokensToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.maxTokensToggleStatusBarItem.addClass(
        'max-tokens-toggle-button'
      );
    }
    if (this.settings.showMaxTokensOnStatusBar) {
      updateMaxTokensStatusBar(this);
    } else {
      this.plugin.maxTokensToggleStatusBarItem.setText('');
    }

    // Initialize status bar for Default Model
    if (!this.plugin.modelToggleStatusBarItem) {
      this.plugin.modelToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.modelToggleStatusBarItem.addClass('model-toggle-button');
    }
    if (this.settings.showDefaultModelOnStatusBar) {
      this.plugin.modelToggleStatusBarItem.setText(
        `GPT-${this.getCurrentModelShortName()}`
      );
    } else {
      this.plugin.modelToggleStatusBarItem.setText('');
    }

    this.plugin.modelToggleStatusBarItem.onClickEvent(() => {
      this.switchModel();
      if (
        this.plugin.modelToggleStatusBarItem &&
        this.settings.showDefaultModelOnStatusBar
      ) {
        this.plugin.modelToggleStatusBarItem.setText(
          `GPT-${this.getCurrentModelShortName()}`
        );
      }
    });

    // Add click listener to open the Max Tokens modal
    this.plugin.maxTokensToggleStatusBarItem.onClickEvent(() => {
      new MaxTokensModal(this.plugin.app, this).open();
    });
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_BRAIN_SETTINGS,
      await this.plugin.loadData()
    );
  }

  async saveSettings() {
    await this.plugin.saveData(this.settings);
    if (this.settings.showMaxTokensOnStatusBar) {
      updateMaxTokensStatusBar(this); // Update the status bar when settings are saved
    }
    this.openAIService.updateApiKey(this.settings.openAIApiKey);
  }

  settingsDisplay(containerEl: HTMLElement): void {
    const animationContainer = containerEl.createDiv('animation-container');
    renderBrainAnimation(animationContainer);

    new BrainSettingTab(this.plugin.app, this, containerEl).display();
  }

  async generateTitle(noteContent: string): Promise<string> {
    return generateTitle(this, noteContent);
  }

  async generateTitleForCurrentNote(): Promise<void> {
    return generateTitleForCurrentNote(this);
  }

  async toggleGeneration(): Promise<void> {
    return toggleGeneration(this);
  }

  switchModel(): void {
    const newModelId =
      this.settings.defaultOpenAIModelId === 'gpt-3.5-turbo'
        ? 'gpt-4-turbo'
        : 'gpt-3.5-turbo';
    this.settings.defaultOpenAIModelId = newModelId;
    this.saveSettings().then(() => {
      if (
        this.plugin.modelToggleStatusBarItem &&
        this.settings.showDefaultModelOnStatusBar
      ) {
        this.plugin.modelToggleStatusBarItem.setText(
          `GPT-${this.getCurrentModelShortName()}`
        );
      }
      const activeLeaf = this.plugin.app.workspace.activeLeaf;
      if (activeLeaf && activeLeaf.view.getViewType() === 'markdown') {
        const markdownView = activeLeaf.view as MarkdownView;
        markdownView.editor.focus();
      }
    });
  }

  getCurrentModelShortName(): string {
    return this.settings.defaultOpenAIModelId === 'gpt-3.5-turbo'
      ? '3.5 Turbo'
      : '4 Turbo';
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.isGenerationCompleted = false;
      showCustomNotice('Generation stopped by user', 5000);
    }
  }
}
