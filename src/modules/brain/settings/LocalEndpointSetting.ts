import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';
import { logger } from '../../../utils/logger';

export function renderLocalEndpointSetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  let debounceTimer: NodeJS.Timeout | null = null;
  const debouncedSaveAndReinitialize = (value: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      plugin.settings.localEndpoint = value;
      await plugin.saveSettings();
      await validateEndpointAndUpdateStatus(value, endpointTextComponent);
      await plugin.reInitiateAIService();
      console.log('AI Service has been reinitialized');
      onAfterSave();
    }, 3000);
  };
  if (!plugin.settings.showlocalEndpointSetting) {
    return;
  }

  let endpointTextComponent: TextComponent;

  function createSpan(className: string): HTMLElement {
    const span = document.createElement('span');
    span.className = className;
    return span;
  }

  new Setting(containerEl)
    .setName('Local server endpoint')
    .setDesc('Enter the local endpoint URL')
    .addText(text => {
      endpointTextComponent = text;
      text
        .setPlaceholder('http://localhost:1234')
        .setValue(plugin.settings.localEndpoint)
        .onChange((value: string) => {
          debouncedSaveAndReinitialize(value);
        });

      validateEndpointAndUpdateStatus(
        plugin.settings.localEndpoint,
        endpointTextComponent
      );
    })
    .addExtraButton(button => {
      button.setIcon('reset');
      button.onClick(async () => {
        await validateEndpointAndUpdateStatus(
          plugin.settings.localEndpoint,
          endpointTextComponent
        );
        await plugin.reInitiateAIService();
        console.log('AI Service has been reinitialized');
        onAfterSave();
      });
      button.setTooltip('Re-check Endpoint and Reinitialize AI Service');
    });

  async function validateEndpointAndUpdateStatus(
    endpoint: string,
    textComponent: TextComponent
  ): Promise<void> {
    const statusTextEl =
      textComponent.inputEl.nextElementSibling || createSpan('api-key-status');
    if (!textComponent.inputEl.nextElementSibling) {
      textComponent.inputEl.insertAdjacentElement('afterend', statusTextEl);
    }

    statusTextEl.textContent = 'Checking...';
    statusTextEl.className = 'api-key-status validating';

    if (plugin.settings.showlocalEndpointSetting) {
      try {
        const isOnline = await AIService.validateLocalEndpoint(endpoint);
        statusTextEl.textContent = isOnline ? 'Online' : 'Offline';
        statusTextEl.classList.remove('validating');
        statusTextEl.classList.toggle('valid', isOnline);
        statusTextEl.classList.toggle('invalid', !isOnline);

        await plugin.refreshAIService();
      } catch (error) {
        logger.error('Error validating endpoint:', error);
        statusTextEl.textContent = 'Error';
        statusTextEl.classList.remove('validating');
        statusTextEl.classList.add('invalid');

        // Refresh AI service to clear local models without toggling off the setting
        await plugin.refreshAIService(true);
      }
    } else {
      statusTextEl.textContent = 'Disabled';
      statusTextEl.classList.remove('validating', 'valid', 'invalid');
    }
  }
}
