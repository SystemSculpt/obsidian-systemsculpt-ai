import { Setting, DropdownComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { OpenAIService } from '../../../api/OpenAIService';
import { Model } from '../../../api/Model';

let populateModelOptionsTimeout: NodeJS.Timeout | undefined;

export async function renderModelDropdown(
  containerEl: HTMLElement,
  plugin: BrainModule
): Promise<void> {
  let dropdownRef: DropdownComponent | null = null; // Declare a variable to hold the dropdown reference

  new Setting(containerEl)
    .setName('Default Model')
    .setDesc('Select the default model for generating tasks')
    .addDropdown(async (dropdown: DropdownComponent) => {
      dropdownRef = dropdown; // Assign the dropdown to the external variable
      const models = await populateModelOptions(
        plugin,
        dropdown,
        plugin.settings.defaultOpenAIModelId,
        OpenAIService.getInstance(plugin.settings.openAIApiKey, plugin.settings)
      );

      dropdown.onChange(async (value: string) => {
        plugin.settings.defaultOpenAIModelId = value;
        await plugin.saveSettings();
        // Update the status bar text to reflect the new model
        plugin.plugin.modelToggleStatusBarItem.setText(
          `GPT-${plugin.getCurrentModelShortName()}`
        );
      });
    });
}

async function populateModelOptions(
  plugin: BrainModule,
  dropdown: DropdownComponent,
  selectedModelId: string,
  apiService: OpenAIService
): Promise<Model[]> {
  const selectEl = dropdown.selectEl;
  if (selectEl) {
    selectEl.empty();
    selectEl.createEl('option', { text: 'Loading models...', value: '' });
  }

  clearTimeout(populateModelOptionsTimeout);

  return new Promise((resolve, reject) => {
    populateModelOptionsTimeout = setTimeout(async () => {
      try {
        const models = await apiService.getModels();
        if (selectEl) {
          selectEl.empty();

          models.forEach((model: Model) => {
            const option = selectEl.createEl('option', {
              text:
                model.id === 'gpt-3.5-turbo'
                  ? 'GPT 3.5 Turbo ($0.001 per 1K tokens)'
                  : model.id === 'gpt-4-turbo-preview'
                  ? 'GPT 4 Turbo ($0.02 per 1K tokens)'
                  : model.name,
              value: model.id,
            });
          });

          dropdown.setValue(selectedModelId || models[0]?.id || '');
        }
        resolve(models);
      } catch (error) {
        console.error('Error loading models:', error);
        if (selectEl) {
          selectEl.empty();
          selectEl.createEl('option', {
            text: 'Failed - check your API key.',
            value: '',
          });
        }
        reject(error);
      }
    }, 500);
  });
}
