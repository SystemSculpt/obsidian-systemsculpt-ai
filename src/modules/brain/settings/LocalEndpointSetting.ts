import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';

export function renderLocalEndpointSetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
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
        .onChange(async (value: string) => {
          plugin.settings.localEndpoint = value;
          await plugin.saveSettings();

          // Clear the existing timeout if it exists
          if ((endpointTextComponent as any).timeoutId) {
            clearTimeout((endpointTextComponent as any).timeoutId);
          }

          // Set a new timeout
          (endpointTextComponent as any).timeoutId = setTimeout(async () => {
            if (value) {
              // Check if the new endpoint is not empty
              await validateEndpointAndUpdateStatus(
                value,
                endpointTextComponent
              );
            }
            onAfterSave();
          }, 2000);
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
        onAfterSave();
      });
      button.setTooltip('Re-check Endpoint');
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

        if (isOnline) {
          await plugin.refreshAIService(true);
        } else {
          // Refresh AI service to clear local models without toggling off the setting
          await plugin.refreshAIService(true);
        }
      } catch (error) {
        console.error('Error validating endpoint:', error);
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
