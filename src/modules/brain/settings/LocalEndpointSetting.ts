import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';

export function renderLocalEndpointSetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  let endpointTextComponent: TextComponent;

  function createSpan(className: string): HTMLElement {
    const span = document.createElement('span');
    span.className = className;
    return span;
  }

  new Setting(containerEl)
    .setName('Local server endpoint')
    .setDesc(
      'Enter the local endpoint URL (currently LM Studio compatible only)'
    )
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

    const isOnline = await AIService.validateLocalEndpoint(endpoint);

    statusTextEl.textContent = isOnline ? 'Online' : 'Offline';
    statusTextEl.classList.remove('validating');
    statusTextEl.classList.toggle('valid', isOnline);
    statusTextEl.classList.toggle('invalid', !isOnline);

    // Update the localEndpointOnline flag in the AIService instance
    AIService.getInstance(
      plugin.settings.openAIApiKey,
      plugin.settings
    ).setLocalEndpointOnline(isOnline);
  }
}
