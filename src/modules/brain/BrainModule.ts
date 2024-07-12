import SystemSculptPlugin from '../../main';
import {
  BrainSettings,
  DEFAULT_BRAIN_SETTINGS,
} from './settings/BrainSettings';
import { AIService } from '../../api/AIService';
import { BrainSettingTab } from './settings/BrainSettingTab';
import { generateTitle } from './functions/generateTitle';
import { generateTitleForCurrentNote } from './functions/generateTitleForCurrentNote';
import { toggleGeneration } from './functions/toggleGeneration';
import { MaxTokensModal } from './views/MaxTokensModal';
import { updateMaxTokensStatusBar } from './functions/updateMaxTokensStatusBar';
import { MarkdownView } from 'obsidian';
import { IGenerationModule } from '../../interfaces/IGenerationModule';
import { showCustomNotice } from '../../modals';
import { Model } from '../../api/Model';
import { stopGeneration } from './functions/stopGeneration';
import { ChatView, VIEW_TYPE_CHAT } from '../chat/ChatView';
import { ModelSelectionModal } from './views/ModelSelectionModal';
import { debounce } from 'obsidian';

import { EventEmitter } from 'events';

export class BrainModule extends EventEmitter implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings: BrainSettings;
  openAIService: AIService;
  abortController: AbortController | null = null;
  isGenerating: boolean = false;
  isGenerationCompleted: boolean = false;
  favoritedModels: string[] = [];
  private isUpdatingDefaultModel: boolean = false;
  private _isReinitializing: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    super();
    this.plugin = plugin;
    this.initializeAIService();
  }

  get isReinitializing(): boolean {
    return this._isReinitializing;
  }

  set isReinitializing(value: boolean) {
    if (this._isReinitializing !== value) {
      this._isReinitializing = value;
      this.emit('reinitialization-status-changed');
    }
  }

  private initializeAIService() {
    const {
      openAIApiKey,
      groqAPIKey,
      openRouterAPIKey,
      apiEndpoint,
      localEndpoint,
      temperature,
    } = this.plugin.settings;
    this.openAIService = AIService.getInstance(
      openAIApiKey,
      groqAPIKey,
      openRouterAPIKey,
      {
        openAIApiKey,
        groqAPIKey,
        openRouterAPIKey,
        apiEndpoint,
        localEndpoint,
        temperature,
      }
    );
  }

  async load() {
    await this.loadSettings();
    this.registerCommands();
    this.initializeStatusBars();
    this.registerViews();
    await this.openAIService.ensureModelCacheInitialized();
    await this.updateDefaultModelAndStatusBar();
  }

  private registerCommands() {
    this.plugin.addCommand({
      id: 'generate-note-title',
      name: 'Generate title for current note',
      callback: async () => await this.generateTitleForCurrentNote(),
    });

    this.plugin.addCommand({
      id: 'toggle-general-generation',
      name: 'Toggle general generation',
      callback: async () => await this.toggleGeneration(),
    });

    this.plugin.addCommand({
      id: 'cycle-through-models',
      name: 'Cycle through available models',
      callback: async () => {
        await this.cycleModels();
        this.focusActiveMarkdownView();
      },
    });

    this.plugin.addCommand({
      id: 'change-max-tokens',
      name: 'Change max tokens',
      callback: () => new MaxTokensModal(this.plugin.app, this).open(),
    });

    this.plugin.addCommand({
      id: 'stop-all-generation-processes',
      name: 'Stop all generation processes',
      callback: async () => await stopGeneration(this),
    });
  }

  private initializeStatusBars() {
    this.initializeMaxTokensStatusBar();
    this.initializeModelStatusBar();
  }

  private initializeMaxTokensStatusBar() {
    if (!this.plugin.maxTokensToggleStatusBarItem) {
      this.plugin.maxTokensToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.maxTokensToggleStatusBarItem.addClass(
        'max-tokens-toggle-button'
      );
    }
    this.updateMaxTokensStatusBar();
    this.plugin.maxTokensToggleStatusBarItem.onClickEvent(() => {
      new MaxTokensModal(this.plugin.app, this).open();
    });
  }

  private initializeModelStatusBar() {
    if (!this.plugin.modelToggleStatusBarItem) {
      this.plugin.modelToggleStatusBarItem = this.plugin.addStatusBarItem();
      this.plugin.modelToggleStatusBarItem.addClass('model-toggle-button');
    }
    this.plugin.modelToggleStatusBarItem.onClickEvent(async () => {
      if (!this.isReinitializing) {
        await this.cycleModels();
      }
    });
  }

  private registerViews() {
    this.plugin.registerView(
      VIEW_TYPE_CHAT,
      leaf => new ChatView(leaf, this, this.plugin.chatModule)
    );
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
    this.refreshAIService();
    this.updateMaxTokensStatusBar();
  }

  async refreshAIService() {
    this.initializeAIService();
    await this.updateDefaultModelAndStatusBar();
  }

  async reInitiateAIService() {
    this.isReinitializing = true;
    this.updateModelStatusBarText('Reinitializing...');
    const {
      openAIApiKey,
      groqAPIKey,
      openRouterAPIKey,
      apiEndpoint,
      localEndpoint,
      temperature,
    } = this.settings;
    this.openAIService = AIService.getInstance(
      openAIApiKey,
      groqAPIKey,
      openRouterAPIKey,
      {
        openAIApiKey,
        groqAPIKey,
        openRouterAPIKey,
        apiEndpoint,
        localEndpoint,
        temperature,
      },
      true
    );
    await this.openAIService.clearModelCache();
    await this.openAIService.initializeModelCache();
    await this.updateDefaultModelAndStatusBar();
    this.isReinitializing = false;
  }

  settingsDisplay(containerEl: HTMLElement): void {
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

  async cycleModels(): Promise<void> {
    new ModelSelectionModal(this.plugin.app, this).open();
  }

  async getCurrentModelShortName(): Promise<string> {
    const enabledModels = await this.getEnabledModelSettings();
    if (Object.values(enabledModels).every(setting => !setting)) {
      return 'No Models Detected';
    }

    const models = await this.openAIService.getModels(
      enabledModels.showopenAISetting,
      enabledModels.showgroqSetting,
      enabledModels.showlocalEndpointSetting,
      enabledModels.showopenRouterSetting
    );

    if (models.length === 0) {
      return 'No Models Detected';
    }

    let currentModel = models.find(
      model => model.id === this.settings.defaultModelId
    );
    if (!currentModel && models.length > 0) {
      currentModel = models[0];
      this.settings.defaultModelId = currentModel.id;
      await this.saveSettings();
    }

    return currentModel ? currentModel.name : 'No Models Detected';
  }

  stopGeneration(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.isGenerationCompleted = false;
      showCustomNotice('Generation stopped by user', 5000);
    }
  }

  async getModelById(modelId: string): Promise<Model | undefined> {
    const actualModelId =
      modelId === 'default' ? this.settings.defaultModelId : modelId;
    const enabledModels = await this.getEnabledModelSettings();
    const models = await this.openAIService.getModels(
      enabledModels.showopenAISetting,
      enabledModels.showgroqSetting,
      enabledModels.showlocalEndpointSetting,
      enabledModels.showopenRouterSetting
    );
    return models.find(model => model.id === actualModelId);
  }

  async updateDefaultModelAndStatusBar(): Promise<void> {
    if (this.isUpdatingDefaultModel) return;
    this.isUpdatingDefaultModel = true;

    try {
      this.updateModelStatusBarText('Loading Models...');

      const enabledModels = await this.getEnabledModelSettings();
      const models = await this.openAIService.getModels(
        enabledModels.showopenAISetting,
        enabledModels.showgroqSetting,
        enabledModels.showlocalEndpointSetting,
        enabledModels.showopenRouterSetting
      );

      if (!models.length) {
        this.settings.defaultModelId = '';
        await this.saveSettings();
        this.updateModelStatusBarText('No Models Detected');
      } else {
        if (!models.find(model => model.id === this.settings.defaultModelId)) {
          this.settings.defaultModelId = models[0].id;
          await this.saveSettings();
        }

        this.updateModelStatusBarText(
          this.settings.showDefaultModelOnStatusBar
            ? `Model: ${await this.getCurrentModelShortName()}`
            : ''
        );
      }
    } catch (error) {
      console.error('Error updating default model:', error);
      this.updateModelStatusBarText('Error Detecting Models');
    } finally {
      this.isUpdatingDefaultModel = false;
    }
  }

  private async getEnabledModelSettings() {
    return {
      showopenAISetting: this.settings.showopenAISetting,
      showgroqSetting: this.settings.showgroqSetting,
      showlocalEndpointSetting: this.settings.showlocalEndpointSetting,
      showopenRouterSetting: this.settings.showopenRouterSetting,
    };
  }

  private updateModelStatusBarText(text: string) {
    if (this.plugin.modelToggleStatusBarItem) {
      this.plugin.modelToggleStatusBarItem.setText(text);
    }
  }

  private updateMaxTokensStatusBar() {
    if (this.settings.showMaxTokensOnStatusBar) {
      updateMaxTokensStatusBar(this);
    } else if (this.plugin.maxTokensToggleStatusBarItem) {
      this.plugin.maxTokensToggleStatusBarItem.setText('');
    }
  }

  private focusActiveMarkdownView() {
    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    if (activeLeaf && activeLeaf.view instanceof MarkdownView) {
      activeLeaf.view.editor.focus();
    }
  }
}
