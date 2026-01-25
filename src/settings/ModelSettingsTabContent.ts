
import { Setting, Notice } from "obsidian";
import { SystemSculptSettingTab } from "./SystemSculptSettingTab";
import { StandardModelSelectionModal } from "../modals/StandardModelSelectionModal";
import type { ModelSelectionResult } from "../modals/StandardModelSelectionModal";

export async function displayModelSettingsTabContent(containerEl: HTMLElement, tabInstance: SystemSculptSettingTab) {
  containerEl.empty();
  if (containerEl.classList.contains('systemsculpt-tab-content')) {
    containerEl.dataset.tab = "model-settings";
  }

  const { app, plugin } = tabInstance;

  containerEl.createEl("h3", { text: "Model settings" });
  containerEl.createEl("p", {
    text: "Configure how AI models are chosen across SystemSculpt.",
    cls: "setting-item-description",
  });

  const isAdvancedMode = plugin.settings.settingsMode === 'advanced';
  const useLatestEverywhere = plugin.settings.useLatestModelEverywhere ?? true;

  const globalToggle = new Setting(containerEl).setName("Use your latest choices");
  if (isAdvancedMode) {
    globalToggle
      .setDesc("New chats, title generation, and post-processing use the most recent model you selected. Turn off to pick fixed defaults.")
      .addToggle((toggle) => {
        toggle
          .setValue(useLatestEverywhere)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({ useLatestModelEverywhere: value });
            tabInstance.display();
          });
      });
  } else {
    globalToggle
      .setDesc("Standard mode always uses the most recent model you selected.")
      .addToggle((toggle) => toggle.setValue(true).setDisabled(true));
  }

  const availableModels = await plugin.modelService.getModels();
  const { ensureCanonicalId, findModelById, getModelLabelWithProvider } = await import("../utils/modelUtils");

  const createSummary = (modelId: string | undefined, emptyFallback: string) => {
    if (!modelId) {
      return emptyFallback;
    }
    const canonical = ensureCanonicalId(modelId);
    const label = getModelLabelWithProvider(canonical);
    const stored = findModelById(availableModels, canonical);
    return stored ? label : `${label} (unavailable)`;
  };

  const renderModelSetting = ({
    name,
    description,
    getModelId,
    defaultMessage,
    modalTitle,
    modalDescription,
    applySelection,
    successMessage,
  }: {
    name: string;
    description: string;
    getModelId: () => string | undefined;
    defaultMessage: string;
    modalTitle: string;
    modalDescription: string;
    applySelection: (providerId: string, canonicalId: string) => Promise<void>;
    successMessage: string;
  }) => {
    const setting = new Setting(containerEl).setName(name).setDesc(description);
    const detail = setting.descEl.createDiv({ cls: "ss-setting-subtext" });

    const updateSummary = () => {
      if (!isAdvancedMode || useLatestEverywhere) {
        detail.setText(defaultMessage);
        return;
      }
      if (availableModels.length === 0) {
        detail.setText('No models available — set up providers in Overview & Setup.');
        return;
      }
      detail.setText(createSummary(getModelId(), 'Click "Change..." to pick a model.'));
    };

    updateSummary();

    if (!isAdvancedMode || useLatestEverywhere) {
      setting.addExtraButton((button) => {
        button.setIcon('lock').setTooltip('Controlled by "Use your latest choices".');
        button.setDisabled(true);
      });
      return;
    }

    if (availableModels.length === 0) {
      setting.addExtraButton((button) => {
        button.setIcon('info').setTooltip('No models available');
        button.setDisabled(true);
      });
      return;
    }

    setting.addButton((button) => {
      button
        .setButtonText('Change...')
        .onClick(async () => {
          const modal = new StandardModelSelectionModal({
            app,
            plugin,
            currentModelId: getModelId() || '',
            title: modalTitle,
            description: modalDescription,
            onSelect: async (result: ModelSelectionResult) => {
              try {
                const canonicalId = ensureCanonicalId(result.modelId);
                const parsed = parseCanonicalId(canonicalId);
                if (!parsed) {
                  throw new Error('Invalid model identifier');
                }
                await applySelection(parsed.providerId, canonicalId);
                plugin.emitter?.emit?.('settingsChanged');
                updateSummary();
                new Notice(successMessage, 3000);
              } catch (error) {
                new Notice('Failed to update model. Please try again.', 5000);
              }
            },
          });
          modal.open();
        });
    });
  };

  renderModelSetting({
    name: 'Default chat model',
    description: 'Used for new chat conversations.',
    getModelId: () => plugin.settings.selectedModelId,
    defaultMessage: 'Follows your latest selection',
    modalTitle: 'Select default chat model',
    modalDescription: 'Choose the model used for all new chats.',
    applySelection: async (_providerId, canonicalId) => {
      await plugin.getSettingsManager().updateSettings({ selectedModelId: canonicalId });
    },
    successMessage: 'Default chat model updated successfully.',
  });

  renderModelSetting({
    name: 'Title generation model',
    description: 'Generates chat titles when automatic titles are enabled.',
    getModelId: () => plugin.settings.titleGenerationModelId,
    defaultMessage: 'Same as current chat model',
    modalTitle: 'Select title generation model',
    modalDescription: 'Choose the model used for generating chat titles.',
    applySelection: async (providerId, canonicalId) => {
      await plugin.getSettingsManager().updateSettings({
        titleGenerationProviderId: providerId,
        titleGenerationModelId: canonicalId,
      });
    },
    successMessage: 'Title generation model updated successfully.',
  });

  renderModelSetting({
    name: 'Post-processing model',
    description: 'Optional model used to refine audio transcription output.',
    getModelId: () => plugin.settings.postProcessingModelId,
    defaultMessage: 'Same as current chat model',
    modalTitle: 'Select post-processing model',
    modalDescription: 'Choose the model used for post-processing transcriptions.',
    applySelection: async (providerId, canonicalId) => {
      await plugin.getSettingsManager().updateSettings({
        postProcessingProviderId: providerId,
        postProcessingModelId: canonicalId,
      });
    },
    successMessage: 'Post-processing model updated successfully.',
  });

  if (availableModels.length === 0) {
    containerEl.createEl('p', {
      text: '💡 Set up at least one AI provider in the "Overview & Setup" tab to start choosing models.',
      cls: 'setting-item-description ss-inline-note',
    });
  }

  if (!isAdvancedMode) {
    containerEl.createEl('h3', { text: 'Chat basics' });
    new Setting(containerEl)
      .setName('Default chat font size')
      .setDesc('Select the default text size for new chat messages.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('small', 'Small')
          .addOption('medium', 'Medium')
          .addOption('large', 'Large')
          .setValue(plugin.settings.chatFontSize || 'medium')
          .onChange(async (value: string) => {
            await plugin.getSettingsManager().updateSettings({ chatFontSize: value as any });
            new Notice(`Default chat font size set to ${value}.`);
          });
      });
  }

  if (isAdvancedMode) {
    containerEl.createEl('h3', { text: 'Model preferences' });

    new Setting(containerEl)
      .setName('Model list sort order')
      .setDesc('Choose how models are sorted in selection lists.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('default', 'Default (natural order)')
          .addOption('alphabetical', 'Alphabetical (provider/name)')
          .setValue(plugin.settings.favoritesFilterSettings.modelSortOrder)
          .onChange(async (value: 'default' | 'alphabetical') => {
            await plugin.getSettingsManager().updateSettings({
              favoritesFilterSettings: {
                ...plugin.settings.favoritesFilterSettings,
                modelSortOrder: value,
              },
            });
            new Notice(`Model sort order set to ${value === 'default' ? 'default' : 'alphabetical'}.`);
          });
      });

    new Setting(containerEl)
      .setName('Always show favorites first')
      .setDesc('Pinned models stay at the top of selectors when enabled.')
      .addToggle((toggle) => {
        toggle
          .setValue(!!plugin.settings.favoritesFilterSettings.favoritesFirst)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({
              favoritesFilterSettings: {
                ...plugin.settings.favoritesFilterSettings,
                favoritesFirst: value,
              },
            });
            new Notice(`Favorites first ${value ? 'enabled' : 'disabled'}.`);
          });
      });

    new Setting(containerEl)
      .setName('Default to "Favorites only" filter')
      .setDesc('When enabled, the model selector opens with only favorites shown.')
      .addToggle((toggle) => {
        toggle
          .setValue(!!plugin.settings.favoritesFilterSettings.showFavoritesOnly)
          .onChange(async (value) => {
            await plugin.getSettingsManager().updateSettings({
              favoritesFilterSettings: {
                ...plugin.settings.favoritesFilterSettings,
                showFavoritesOnly: value,
              },
            });
            new Notice(`Favorites-only default ${value ? 'enabled' : 'disabled'}.`);
          });
      });
  }

  if (isAdvancedMode && plugin.settings.transcriptionProvider === 'custom') {
    containerEl.createEl('h3', { text: 'Transcription model settings' });
    const transcriptionSetting = new Setting(containerEl)
      .setName('Transcription model')
      .setDesc('Used when the custom transcription provider is active.');
    transcriptionSetting.descEl.createDiv({
      cls: 'ss-setting-subtext',
      text: plugin.settings.customTranscriptionModel || 'Not configured',
    });
    containerEl.createEl('p', {
      text: 'Configure custom transcription providers in the Audio & Transcription tab.',
      cls: 'setting-item-description',
    });
  }
}

function parseCanonicalId(canonicalId: string): { providerId: string; modelId: string } | null {
  const parts = canonicalId.split('@@');
  if (parts.length === 2) {
    return { providerId: parts[0], modelId: parts[1] };
  }
  return null;
}
