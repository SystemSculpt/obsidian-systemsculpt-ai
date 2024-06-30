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

export class BrainModule implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings: BrainSettings;
  openAIService: AIService;
  abortController: AbortController | null = null;
  isGenerating: boolean = false;
  isGenerationCompleted: boolean = false;

  constructor(plugin: SystemSculptPlugin) {
    this.plugin = plugin;
    this.openAIService = AIService.getInstance('', '', '', {
      openAIApiKey: '',
      groqAPIKey: '',
      openRouterAPIKey: '',
      apiEndpoint: '',
      localEndpoint: '',
      temperature: 0.5,
    });
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
      id: 'cycle-through-models',
      name: 'Cycle through available models',
      callback: async () => {
        await this.cycleModels();
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

    this.plugin.addCommand({
      id: 'stop-all-generation-processes',
      name: 'Stop all generation processes',
      callback: async () => {
        await stopGeneration(this);
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

    await this.updateModelStatusBar();

    this.plugin.modelToggleStatusBarItem.onClickEvent(async () => {
      await this.cycleModels();
    });

    // Add click listener to open the Max Tokens modal

    if (!this.plugin.maxTokensToggleStatusBarItem) {
      this.plugin.maxTokensToggleStatusBarItem = this.plugin.addStatusBarItem();
    }
    this.plugin.maxTokensToggleStatusBarItem.onClickEvent(() => {
      new MaxTokensModal(this.plugin.app, this).open();
    });

    // Register the ChatView
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
    this.refreshAIService(); // Refresh AIService with new settings
    if (this.settings.showMaxTokensOnStatusBar) {
      updateMaxTokensStatusBar(this); // Update the status bar when settings are saved
    }
  }

  async refreshAIService(keepLocalModels = false) {
    this.openAIService = AIService.getInstance(
      this.settings.openAIApiKey,
      this.settings.groqAPIKey,
      this.settings.openRouterAPIKey,
      {
        openAIApiKey: this.settings.openAIApiKey,
        groqAPIKey: this.settings.groqAPIKey,
        openRouterAPIKey: this.settings.openRouterAPIKey,
        apiEndpoint: this.settings.apiEndpoint,
        localEndpoint: this.settings.localEndpoint,
        temperature: this.settings.temperature,
      }
    );

    if (keepLocalModels) {
      this.openAIService.clearModelCache();
      this.updateDefaultModelAfterEndpointToggle();
    }
  }

  settingsDisplay(containerEl: HTMLElement): void {
    const animationContainer = containerEl.createDiv('animation-container');

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
    if (
      !this.settings.showopenAISetting &&
      !this.settings.showgroqSetting &&
      !this.settings.showlocalEndpointSetting &&
      !this.settings.showOpenRouterSetting
    ) {
      return 'No Models Detected';
    }

    const models = await this.openAIService.getModels(
      this.settings.showopenAISetting,
      this.settings.showgroqSetting,
      this.settings.showlocalEndpointSetting,
      this.settings.showOpenRouterSetting
    );

    if (models.length === 0) {
      return 'No Models Detected';
    }

    let currentModel = models.find(
      model => model.id === this.settings.defaultModelId
    );

    if (!currentModel) {
      if (models.length > 0) {
        currentModel = models[0];
        this.settings.defaultModelId = currentModel.id;
        await this.saveSettings();
      } else {
        return 'No Models Detected';
      }
    }

    return currentModel.name;
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
    if (modelId === 'default') {
      modelId = this.settings.defaultModelId;
    }
    const localModels = await this.openAIService.getModels(false, false);
    const onlineModels = await this.openAIService.getModels(true, true);
    const allModels = [...localModels, ...onlineModels];
    return allModels.find(model => model.id === modelId);
  }

  async updateDefaultModelAfterEndpointToggle(): Promise<void> {
    const { showopenAISetting, showgroqSetting, showlocalEndpointSetting } =
      this.settings;

    if (!showopenAISetting && !showgroqSetting && !showlocalEndpointSetting) {
      this.settings.defaultModelId = '';
      await this.saveSettings();
      if (this.plugin.modelToggleStatusBarItem) {
        this.plugin.modelToggleStatusBarItem.setText('No Models Detected');
      }
      return;
    }

    const models = await this.openAIService.getModels(
      showopenAISetting,
      showgroqSetting,
      showlocalEndpointSetting
    );

    if (models.length === 0) {
      this.settings.defaultModelId = '';
      await this.saveSettings();
      if (this.plugin.modelToggleStatusBarItem) {
        this.plugin.modelToggleStatusBarItem.setText('No Models Detected');
      }
      return;
    }

    const currentModel = models.find(
      model => model.id === this.settings.defaultModelId
    );

    if (!currentModel) {
      this.settings.defaultModelId = models[0].id;
      await this.saveSettings();
    }

    if (this.plugin.modelToggleStatusBarItem) {
      const modelName = this.settings.defaultModelId
        ? models.find(m => m.id === this.settings.defaultModelId)?.name ||
          'Unknown Model'
        : 'No Models Detected';
      this.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
    }
  }

  async updateModelStatusBar() {
    const { showopenAISetting, showgroqSetting, showlocalEndpointSetting } =
      this.settings;

    if (!showopenAISetting && !showgroqSetting && !showlocalEndpointSetting) {
      if (this.plugin.modelToggleStatusBarItem) {
        this.plugin.modelToggleStatusBarItem.setText('No Models Detected');
      }
      return;
    }

    if (this.settings.showDefaultModelOnStatusBar) {
      const modelName = await this.getCurrentModelShortName();
      if (this.plugin.modelToggleStatusBarItem) {
        this.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
      }
    } else {
      if (this.plugin.modelToggleStatusBarItem) {
        this.plugin.modelToggleStatusBarItem.setText('');
      }
    }
  }
}
