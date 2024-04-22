import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';

export function renderOpenAIApiKeySetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  let apiKeyTextComponent: TextComponent;

  function createSpan(className: string): HTMLElement {
    const span = document.createElement('span');
    span.className = className;
    return span;
  }

  new Setting(containerEl)
    .setName('OpenAI API key')
    .setDesc('Enter your OpenAI API key')
    .addText(text => {
      apiKeyTextComponent = text;
      text
        .setPlaceholder('API Key')
        .setValue(plugin.settings.openAIApiKey)
        .onChange(async (value: string) => {
          plugin.settings.openAIApiKey = value;
          await plugin.saveSettings();

          // Clear the existing timeout if it exists
          if ((apiKeyTextComponent as any).timeoutId) {
            clearTimeout((apiKeyTextComponent as any).timeoutId);
          }

          // Set a new timeout
          (apiKeyTextComponent as any).timeoutId = setTimeout(async () => {
            if (value) {
              // Check if the new API key is not empty
              await validateApiKeyAndUpdateStatus(value, apiKeyTextComponent);
            }
            onAfterSave();
          }, 2000);
        });

      text.inputEl.type = 'password';
      text.inputEl.addEventListener('focus', () => {
        text.inputEl.type = 'text';
      });
      text.inputEl.addEventListener('blur', () => {
        text.inputEl.type = 'password';
      });

      validateApiKeyAndUpdateStatus(
        plugin.settings.openAIApiKey,
        apiKeyTextComponent
      );
    })
    .addExtraButton(button => {
      button.setIcon('reset');
      button.onClick(async () => {
        await validateApiKeyAndUpdateStatus(
          plugin.settings.openAIApiKey,
          apiKeyTextComponent
        );
      });
      button.setTooltip('Re-check API Key');
    });

  async function validateApiKeyAndUpdateStatus(
    apiKey: string,
    textComponent: TextComponent
  ): Promise<void> {
    const statusTextEl =
      textComponent.inputEl.nextElementSibling || createSpan('api-key-status');
    if (!textComponent.inputEl.nextElementSibling) {
      textComponent.inputEl.insertAdjacentElement('afterend', statusTextEl);
    }

    statusTextEl.textContent = 'Validating...';
    statusTextEl.className = 'api-key-status validating';

    const isValid = await AIService.validateApiKey(apiKey);

    statusTextEl.textContent = isValid ? 'Valid' : 'Invalid';
    statusTextEl.classList.remove('validating');
    statusTextEl.classList.toggle('valid', isValid);
    statusTextEl.classList.toggle('invalid', !isValid);

    // Update the openAIApiKeyValid flag and API key in the AIService instance
    const aiServiceInstance = AIService.getInstance(
      plugin.settings.openAIApiKey,
      plugin.settings
    );
    aiServiceInstance.setOpenAIApiKeyValid(isValid);
    if (isValid) {
      aiServiceInstance.updateApiKey(apiKey);
      plugin.settings.openAIApiKey = apiKey;
      await plugin.saveSettings();
    }
  }
}
