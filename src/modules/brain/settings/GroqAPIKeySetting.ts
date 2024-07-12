import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';

export function renderGroqAPIKeySetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  let debounceTimer: NodeJS.Timeout | null = null;
  const debouncedSaveAndReinitialize = (value: string) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      plugin.settings.groqAPIKey = value;
      await plugin.saveSettings();
      await validateApiKeyAndUpdateStatus(value, apiKeyTextComponent);
      await plugin.reInitiateAIService();
      console.log('AI Service has been reinitialized');
      onAfterSave();
    }, 3000);
  };
  if (!plugin.settings.showgroqSetting) {
    return;
  }

  let apiKeyTextComponent: TextComponent;

  function createSpan(className: string): HTMLElement {
    const span = document.createElement('span');
    span.className = className;
    return span;
  }

  new Setting(containerEl)
    .setName('Groq API key')
    .setDesc('Enter your Groq API key')
    .addText(text => {
      apiKeyTextComponent = text;
      text
        .setPlaceholder('API Key')
        .setValue(plugin.settings.groqAPIKey)
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
        plugin.settings.groqAPIKey,
        apiKeyTextComponent
      );
    })
    .addExtraButton(button => {
      button.setIcon('reset');
      button.onClick(async () => {
        await validateApiKeyAndUpdateStatus(
          plugin.settings.groqAPIKey,
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
    const statusTextEl = textComponent.inputEl.nextElementSibling || createSpan('api-key-status');
    if (!textComponent.inputEl.nextElementSibling) {
      textComponent.inputEl.insertAdjacentElement('afterend', statusTextEl);
    }

    statusTextEl.textContent = 'Validating...';
    statusTextEl.className = 'api-key-status validating';

    if (plugin.settings.showgroqSetting) {
      const isValid = await AIService.validateGroqAPIKey(apiKey);
      statusTextEl.textContent = isValid ? 'Valid' : 'Invalid';
      statusTextEl.classList.remove('validating');
      statusTextEl.classList.toggle('valid', isValid);
      statusTextEl.classList.toggle('invalid', !isValid);
    } else {
      statusTextEl.textContent = 'Disabled';
      statusTextEl.classList.remove('validating', 'valid', 'invalid');
    }

    // Update the AIService instance
    AIService.getInstance(
      plugin.settings.openAIApiKey,
      plugin.settings.groqAPIKey,
      plugin.settings.openRouterAPIKey,
      plugin.settings
    );
  }
}
