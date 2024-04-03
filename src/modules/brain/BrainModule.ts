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

export class BrainModule {
  plugin: SystemSculptPlugin;
  settings: BrainSettings;
  openAIService: OpenAIService;

  constructor(plugin: SystemSculptPlugin, openAIService: OpenAIService) {
    this.plugin = plugin;
    this.openAIService = openAIService;
  }

  async load() {
    await this.loadSettings();

    this.plugin.addCommand({
      id: 'generate-note-title',
      name: 'Generate Title for Current Note',
      callback: async () => {
        await this.generateTitleForCurrentNote();
      },
    });

    // Add a status bar item for the model toggle
    if (!this.plugin.modelToggleStatusBarItem) {
      this.plugin.modelToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.modelToggleStatusBarItem.addClass('model-toggle-button');
      this.plugin.modelToggleStatusBarItem.setText(
        `GPT-${this.getCurrentModelShortName()}`
      );
    }

    // Add click listener to toggle the model and update the status bar text
    this.plugin.modelToggleStatusBarItem.onClickEvent(() => {
      this.switchModel();
      this.plugin.modelToggleStatusBarItem.setText(
        `GPT-${this.getCurrentModelShortName()}`
      );
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

  // Method to switch between GPT-3.5 Turbo and GPT-4 Turbo
  switchModel(): void {
    const newModelId =
      this.settings.defaultOpenAIModelId === 'gpt-3.5-turbo'
        ? 'gpt-4-turbo-preview'
        : 'gpt-3.5-turbo';
    this.settings.defaultOpenAIModelId = newModelId;
    this.saveSettings();
  }

  // Method to get the current model's short name for the status bar
  getCurrentModelShortName(): string {
    return this.settings.defaultOpenAIModelId === 'gpt-3.5-turbo'
      ? '3.5 Turbo'
      : '4 Turbo';
  }
}
