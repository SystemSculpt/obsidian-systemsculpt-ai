import { Setting } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { ModelSelectionModal } from '../views/ModelSelectionModal';
import { ButtonComponent } from 'obsidian';

export function renderModelSelectionButton(
  containerEl: HTMLElement,
  plugin: BrainModule
): () => void {
  const currentModel = plugin.settings.defaultModelId || 'No model selected';
  let buttonComponent: ButtonComponent;

  new Setting(containerEl)
    .setName('Default model')
    .setDesc('Select the default model for generating tasks')
    .addButton(button => {
      buttonComponent = button;
      updateButtonState();

      button.onClick(() => {
        if (!plugin.isReinitializing) {
          new ModelSelectionModal(plugin.plugin.app, plugin).open();
        }
      });
    });

  function updateButtonState() {
    if (plugin.isReinitializing) {
      buttonComponent.setButtonText('Reloading Models...');
      buttonComponent.setDisabled(true);
    } else {
      buttonComponent.setButtonText(
        `Choose Default Model (Currently ${currentModel})`
      );
      buttonComponent.setDisabled(false);
    }
  }

  plugin.on('reinitialization-status-changed', updateButtonState);

  return () => {
    plugin.off('reinitialization-status-changed', updateButtonState);
  };
}
