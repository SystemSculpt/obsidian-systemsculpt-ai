import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';

export function renderOpenRouterAPIKeySetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  let debounceTimer: NodeJS.Timeout | null = null;
  const debouncedSaveAndReinitialize = (value: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      plugin.settings.openRouterAPIKey = value;
      await plugin.saveSettings();
      await validateApiKeyAndUpdateStatus(value, apiKeyTextComponent);
      await plugin.reInitiateAIService();
      console.log('AI Service has been reinitialized');
      onAfterSave();
    }, 3000);
  };
  if (!plugin.settings.showopenRouterSetting) {
    return;
  }

  let apiKeyTextComponent: TextComponent;

  function createSpan(className: string): HTMLElement {
    const span = document.createElement('span');
    span.className = className;
    return span;
  }

  new Setting(containerEl)
    .setName('OpenRouter API key')
    .setDesc('Enter your OpenRouter API key')
    .addText(text => {
      apiKeyTextComponent = text;
      text
        .setPlaceholder('API Key')
        .setValue(plugin.settings.openRouterAPIKey)
        .onChange((value: string) => {
          debouncedSaveAndReinitialize(value);
        });

      text.inputEl.type = 'password';
      text.inputEl.addEventListener('focus', () => {
        text.inputEl.type = 'text';
      });
      text.inputEl.addEventListener('blur', () => {
        text.inputEl.type = 'password';
      });

      validateApiKeyAndUpdateStatus(
        plugin.settings.openRouterAPIKey,
        apiKeyTextComponent
      );
    })
    .addExtraButton(button => {
      button.setIcon('reset');
      button.onClick(async () => {
        await validateApiKeyAndUpdateStatus(
          plugin.settings.openRouterAPIKey,
          apiKeyTextComponent
        );
        await plugin.reInitiateAIService();
        console.log('AI Service has been reinitialized');
        onAfterSave();
      });
      button.setTooltip('Re-check API Key and Reinitialize AI Service');
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

    if (plugin.settings.showopenRouterSetting) {
      const isValid = await AIService.validateOpenRouterApiKey(apiKey);

      statusTextEl.textContent = isValid ? 'Valid' : 'Invalid';
      statusTextEl.classList.remove('validating');
      statusTextEl.classList.toggle('valid', isValid);
      statusTextEl.classList.toggle('invalid', !isValid);
    } else {
      statusTextEl.textContent = 'Disabled';
      statusTextEl.classList.remove('validating', 'valid', 'invalid');
    }
  }
}
