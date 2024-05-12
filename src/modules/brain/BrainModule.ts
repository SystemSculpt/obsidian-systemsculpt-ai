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
import { stopGeneration } from './functions/stopGeneration'; // Import the new stopGeneration function

export class BrainModule implements IGenerationModule {
  plugin: SystemSculptPlugin;
  settings: BrainSettings;
  openAIService: AIService;
  abortController: AbortController | null = null;
  isGenerating: boolean = false;
  isGenerationCompleted: boolean = false;

  constructor(plugin: SystemSculptPlugin, openAIService: AIService) {
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
    if (this.settings.showDefaultModelOnStatusBar) {
      this.getCurrentModelShortName().then(modelName => {
        //@ts-ignore
        this.plugin.modelToggleStatusBarItem.setText(`Model: ${modelName}`);
      });
    } else {
      this.plugin.modelToggleStatusBarItem.setText('');
    }

    this.plugin.modelToggleStatusBarItem.onClickEvent(async () => {
      await this.cycleModels();
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
    this.refreshAIService(); // Refresh AIService with new settings
    if (this.settings.showMaxTokensOnStatusBar) {
      updateMaxTokensStatusBar(this); // Update the status bar when settings are saved
    }
  }

  refreshAIService() {
    // Use getInstance to either get the existing instance or update it
    this.openAIService = AIService.getInstance(
      this.settings.openAIApiKey,
      this.settings.groqAPIKey,
      {
        openAIApiKey: this.settings.openAIApiKey,
        groqAPIKey: this.settings.groqAPIKey,
        apiEndpoint: 'https://api.openai.com', // Assuming this is your default API endpoint
        localEndpoint: this.settings.localEndpoint,
      }
    );
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
    if (
      this.plugin.modelToggleStatusBarItem &&
      this.settings.showDefaultModelOnStatusBar
    ) {
      this.plugin.modelToggleStatusBarItem.setText('Cycling...');
    }

    const models = await this.openAIService.getModels();
    const enabledModels = models.filter(model =>
      this.settings.enabledModels.includes(model.id)
    );

    let currentIndex = enabledModels.findIndex(
      model => model.id === this.settings.defaultModelId
    );
    let nextIndex = (currentIndex + 1) % enabledModels.length;
    this.settings.defaultModelId = enabledModels[nextIndex].id;
    await this.saveSettings();

    if (
      this.plugin.modelToggleStatusBarItem &&
      this.settings.showDefaultModelOnStatusBar
    ) {
      this.plugin.modelToggleStatusBarItem.setText(
        `Model: ${enabledModels[nextIndex].name}`
      );
    }
  }

  async getCurrentModelShortName(): Promise<string> {
    // Introduce a delay to ensure models have adequate time to load
    await new Promise(resolve => setTimeout(resolve, 5000));
    const models = await this.openAIService.getModels();
    let currentModel = models.find(
      model => model.id === this.settings.defaultModelId
    );

    // Ensure currentModel is defined, otherwise set to the first model
    if (!currentModel) {
      if (models.length > 0) {
        currentModel = models[0];
        this.settings.defaultModelId = currentModel.id;
        await this.saveSettings();
      } else {
        throw new Error('No models available.');
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
    const localModels = await this.openAIService.getModels(false, false);
    const onlineModels = await this.openAIService.getModels(true, true);
    const allModels = [...localModels, ...onlineModels];
    return allModels.find(model => model.id === modelId);
  }
}
