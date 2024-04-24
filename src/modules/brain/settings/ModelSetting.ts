import { Setting, DropdownComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';
import { Model } from '../../../api/Model';

let populateModelOptionsTimeout: NodeJS.Timeout | undefined;

export async function renderModelDropdown(
  containerEl: HTMLElement,
  plugin: BrainModule
): Promise<void> {
  let dropdownRef: DropdownComponent | null = null;

  new Setting(containerEl)
    .setName('Default model')
    .setDesc('Select the default model for generating tasks')
    .addDropdown(async (dropdown: DropdownComponent) => {
      dropdownRef = dropdown;
      await populateModelOptions(plugin, dropdown);

      dropdown.onChange(async (value: string) => {
        if (value === 'Unknown') {
          const models = await getAvailableModels(plugin);
          if (models.length > 0) {
            plugin.settings.defaultOpenAIModelId = models[0].id;
          }
        } else {
          plugin.settings.defaultOpenAIModelId = value;
        }
        await plugin.saveSettings();
        plugin.refreshAIService();
        updateModelStatusBar(plugin);
      });
    });

  const infoBoxEl = containerEl.createDiv('info-box');
  infoBoxEl.createEl('p', {
    text: 'You can hotkey this (I personally hotkey it to CMD+Shift+M). This allows you to quickly switch between OpenAI models in order to heavily save costs with GPT-3.5-Turbo and/or toggle on maximum brain power with GPT-4-Turbo.',
  });
}

async function populateModelOptions(
  plugin: BrainModule,
  dropdown: DropdownComponent
): Promise<void> {
  const selectEl = dropdown.selectEl;
  if (selectEl) {
    selectEl.empty();
    selectEl.createEl('option', { text: 'Loading models...', value: '' });
  }

  clearTimeout(populateModelOptionsTimeout);

  populateModelOptionsTimeout = setTimeout(async () => {
    try {
      const models = await getAvailableModels(plugin);

      if (selectEl) {
        selectEl.empty();

        if (models.length === 0) {
          selectEl.createEl('option', {
            text: 'No models available. Check your local endpoint and OpenAI API key.',
            value: '',
          });
          // Ensure the status bar is updated when no models are available
          updateModelStatusBar(plugin, 'No Models Available');
        } else {
          models.forEach((model: Model) => {
            const option = selectEl.createEl('option', {
              text: getModelDisplayName(model),
              value: model.id,
            });
          });

          const selectedModelId = await setDefaultModel(plugin, models);
          dropdown.setValue(selectedModelId);
          updateModelStatusBar(plugin); // Update status bar with the selected model
        }
      }
    } catch (error) {
      console.error('Error loading models:', error);
      if (selectEl) {
        selectEl.empty();
        selectEl.createEl('option', {
          text: 'Failed - check your local endpoint and OpenAI API key.',
          value: '',
        });
      }
      updateModelStatusBar(plugin, 'Model not configured');
    }
  }, 500);
}

async function getAvailableModels(plugin: BrainModule): Promise<Model[]> {
  const localEndpointOnline = await AIService.validateLocalEndpoint(
    plugin.settings.localEndpoint
  );
  const openAIApiKeyValid = await AIService.validateApiKey(
    plugin.settings.openAIApiKey
  );

  const models: Model[] = [];

  if (localEndpointOnline) {
    const localResponse = await fetch(
      `${plugin.settings.localEndpoint}/v1/models`
    );
    if (localResponse.ok) {
      const localModels = await localResponse.json();
      models.push(
        ...localModels.data.map((model: any) => ({
          id: model.id,
          name: model.id.split('/').pop(),
          isLocal: true,
        }))
      );
    }
  }

  if (openAIApiKeyValid) {
    const response = await plugin.openAIService.getModels();
    models.push(
      ...response
        .filter(
          (model: any) =>
            model.id === 'gpt-3.5-turbo' || model.id === 'gpt-4-turbo'
        )
        .map((model: any) => ({
          id: model.id,
          name: model.id.replace(/-turbo$/, ' turbo'),
          isLocal: false,
        }))
    );
  }

  return models;
}

async function setDefaultModel(
  plugin: BrainModule,
  models: Model[]
): Promise<string> {
  const selectedModelId = plugin.settings.defaultOpenAIModelId;
  const selectedModel = models.find(model => model.id === selectedModelId);

  if (!selectedModel || selectedModelId === 'Unknown') {
    // If the previously selected model is no longer available or is "Unknown", select the first available model
    const defaultModel = models[0];
    plugin.settings.defaultOpenAIModelId = defaultModel.id;
    await plugin.saveSettings();
    return defaultModel.id;
  }

  return selectedModelId;
}

function getModelDisplayName(model: Model): string {
  if (model.id === 'gpt-3.5-turbo') {
    return 'GPT 3.5 Turbo ($0.001 per 1K tokens)';
  } else if (model.id === 'gpt-4-turbo') {
    return 'GPT 4 Turbo ($0.02 per 1K tokens)';
  } else if (model.isLocal) {
    return model.name;
  } else {
    return model.name;
  }
}

function updateModelStatusBar(plugin: BrainModule, text?: string): void {
  if (plugin.plugin.modelToggleStatusBarItem) {
    if (text) {
      plugin.plugin.modelToggleStatusBarItem.setText(text);
    } else {
      const modelName = plugin.settings.defaultOpenAIModelId.split('/').pop();
      plugin.plugin.modelToggleStatusBarItem.setText(
        modelName ? `Model: ${modelName}` : 'Model not configured'
      );
    }
  }
}
