import { Setting, DropdownComponent, ToggleComponent } from 'obsidian';
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
            plugin.settings.defaultModelId = models[0].id;
          }
        } else {
          plugin.settings.defaultModelId = value;
        }
        await plugin.saveSettings();
        plugin.refreshAIService();
        updateModelStatusBar(plugin);
      });
    });

  const modelListSetting = new Setting(containerEl)
    .setName('Available models')
    .setDesc('Select which models to include when cycling through models')
    .setClass('model-list-setting');

  const modelListEl = containerEl.createDiv('model-list');
  const loadingTextEl = modelListEl.createDiv('info-box');
  loadingTextEl.textContent = 'Loading available models list...';
  let dots = 0;
  const loadingInterval = setInterval(() => {
    dots = (dots + 1) % 4;
    loadingTextEl.textContent = `Loading available models list${'.'.repeat(
      dots
    )}`;
  }, 500);

  const infoBoxEl = containerEl.createDiv('info-box');
  infoBoxEl.createEl('p', {
    text: "You can hotkey this (I personally hotkey it to CMD+M). This allows you to quickly cycle through whatever models you've enabled (example: use a local model for simple generations, a groq model for speedy smarter ones, and gpt-4-turbo for the big-brain tasks).",
  });

  const models = await getAvailableModels(plugin);
  clearInterval(loadingInterval);
  loadingTextEl.remove(); // Remove the loading text once models are loaded

  models.forEach((model: Model) => {
    const modelItemEl = modelListEl.createDiv('model-item');
    const modelNameEl = modelItemEl.createSpan('model-name');
    modelNameEl.textContent = getModelDisplayName(model);

    const isModelEnabled = plugin.settings.enabledModels.includes(model.id);
    const toggleComponent = new ToggleComponent(modelItemEl)
      .setValue(isModelEnabled) // Set the toggle based on whether the model is enabled
      .onChange(async value => {
        const index = plugin.settings.enabledModels.indexOf(model.id);
        if (value) {
          // If the toggle is on, the model should be enabled
          if (index === -1) {
            plugin.settings.enabledModels.push(model.id); // Add to enabled models if it's enabled
          }
        } else {
          // If the toggle is off, the model should be disabled
          if (index > -1) {
            plugin.settings.enabledModels.splice(index, 1); // Remove from enabled models if it's disabled
          }
        }
        await plugin.saveSettings(); // Save settings after updating
        modelItemEl.toggleClass('disabled', !value);
        //@ts-ignore
        await populateModelOptions(plugin, dropdownRef); // Refresh the dropdown options
      });
  });
}

async function populateModelOptions(
  plugin: BrainModule,
  dropdown: DropdownComponent
): Promise<void> {
  const selectEl = dropdown.selectEl;
  if (selectEl) {
    selectEl.empty();
    const loadingOption = selectEl.createEl('option', {
      text: 'Loading available models list...',
      value: '',
    });
    let loadingText = 'Loading available models list';
    let dots = 0;

    const loadingInterval = setInterval(() => {
      dots = (dots + 1) % 4;
      loadingOption.textContent = `${loadingText}${'.'.repeat(dots)}`;
    }, 500);

    try {
      const models = await getAvailableModels(plugin);
      clearInterval(loadingInterval);

      if (selectEl) {
        selectEl.empty();

        if (models.length === 0) {
          selectEl.createEl('option', {
            text: 'No models available. Check your local endpoint and API keys.',
            value: '',
          });
          updateModelStatusBar(plugin, 'No Models Available');
        } else {
          models
            .filter(model => plugin.settings.enabledModels.includes(model.id))
            .forEach((model: Model) => {
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
      clearInterval(loadingInterval);
      console.error('Error loading models:', error);
      if (selectEl) {
        selectEl.empty();
        selectEl.createEl('option', {
          text: 'Failed - check your local endpoint and API keys.',
          value: '',
        });
      }
      updateModelStatusBar(plugin, 'Model not configured');
    }
  }
}

async function getAvailableModels(plugin: BrainModule): Promise<Model[]> {
  const localEndpointOnline = plugin.settings.showlocalEndpointSetting
    ? await AIService.validateLocalEndpoint(plugin.settings.localEndpoint)
    : false;
  const openAIApiKeyValid = plugin.settings.showopenAISetting
    ? await AIService.validateOpenAIApiKey(plugin.settings.openAIApiKey)
    : false;
  const groqAPIKeyValid = plugin.settings.showgroqSetting
    ? await AIService.validateGroqAPIKey(plugin.settings.groqAPIKey)
    : false;

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
          provider: 'local' as const, // Specify the literal type
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
          name: model.id,
          isLocal: false,
          provider: 'openai' as const, // Explicitly set to 'openai'
        }))
    );
  }

  if (groqAPIKeyValid) {
    const response = await plugin.openAIService.getModels(false, true);
    models.push(
      ...response.filter((model: Model) => model.provider === 'groq')
    );
  }

  return models;
}

async function setDefaultModel(
  plugin: BrainModule,
  models: Model[]
): Promise<string> {
  const selectedModelId = plugin.settings.defaultModelId;
  const selectedModel = models.find(model => model.id === selectedModelId);

  if (!selectedModel || selectedModelId === 'Unknown') {
    // If the previously selected model is no longer available or is "Unknown", select the first available model
    const defaultModel = models[0];
    plugin.settings.defaultModelId = defaultModel.id;
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
      const modelName = plugin.settings.defaultModelId.split('/').pop();
      plugin.plugin.modelToggleStatusBarItem.setText(
        modelName ? `Model: ${modelName}` : 'Model not configured'
      );
    }
  }
}
