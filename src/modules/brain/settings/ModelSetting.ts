import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { Model } from '../../../api/Model';
import { ModelSelectionModal } from '../views/ModelSelectionModal';

let populateModelOptionsTimeout: NodeJS.Timeout | undefined;

export function renderModelSelectionButton(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  const currentModel = plugin.settings.defaultModelId || 'No model selected';
  new Setting(containerEl)
    .setName('Default model')
    .setDesc('Select the default model for generating tasks')
    .addButton(button => {
      button
        .setButtonText(`Choose Default Model (Currently ${currentModel})`)
        .onClick(() => {
          new ModelSelectionModal(plugin.plugin.app, plugin).open();
        });
    });
}

async function getAvailableModels(plugin: BrainModule): Promise<Model[]> {
  const includeOpenAI = plugin.settings.showopenAISetting;
  const includeGroq = plugin.settings.showgroqSetting;
  const includeLocal = plugin.settings.showlocalEndpointSetting;
  const includeOpenRouter = plugin.settings.showOpenRouterSetting;
  return plugin.openAIService.getModels(
    includeOpenAI,
    includeGroq,
    includeLocal,
    includeOpenRouter
  );
}

async function setDefaultModel(
  plugin: BrainModule,
  models: Model[]
): Promise<string> {
  let selectedModelId = plugin.settings.defaultModelId;
  const enabledModels = models;
  const selectedModel = enabledModels.find(
    model => model.id === selectedModelId
  );

  if (!selectedModel || selectedModelId === 'Unknown') {
    // If the previously selected model is no longer available or is "Unknown", select the first available enabled model
    if (enabledModels.length > 0) {
      const defaultModel = enabledModels[0];
      plugin.settings.defaultModelId = defaultModel.id;
      await plugin.saveSettings();
      return defaultModel.id;
    } else {
      // No enabled models available
      plugin.settings.defaultModelId = '';
      await plugin.saveSettings();
      return '';
    }
  }

  return selectedModelId;
}

function getModelDisplayName(model: Model): string {
  if (model.id === 'gpt-3.5-turbo') {
    return 'gpt-3.5-turbo';
  } else if (model.id === 'gpt-4o') {
    return 'gpt-4o (most advanced)';
  } else if (model.isLocal) {
    return model.name;
  } else {
    return model.name;
  }
}

function updateModelStatusBar(plugin: BrainModule, text?: string): void {
  const {
    showopenAISetting,
    showgroqSetting,
    showlocalEndpointSetting,
    showOpenRouterSetting,
  } = plugin.settings;
  if (plugin.plugin.modelToggleStatusBarItem) {
    if (
      !showopenAISetting &&
      !showgroqSetting &&
      !showlocalEndpointSetting &&
      !showOpenRouterSetting
    ) {
      plugin.plugin.modelToggleStatusBarItem.setText('No Models Detected');
      return;
    }
    if (text) {
      plugin.plugin.modelToggleStatusBarItem.setText(text);
    } else {
      const modelName = plugin.settings.defaultModelId
        ? plugin.settings.defaultModelId.split('/').pop()
        : 'No Models Detected';
      plugin.plugin.modelToggleStatusBarItem.setText(
        modelName ? `Model: ${modelName}` : 'No Models Detected'
      );
    }
  }
}
