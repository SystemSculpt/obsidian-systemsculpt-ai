import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';

export function renderOpenRouterAPIKeySetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  if (!plugin.settings.showOpenRouterSetting) {
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
        .onChange(async (value: string) => {
          plugin.settings.openRouterAPIKey = value;
          await plugin.saveSettings();

          if ((apiKeyTextComponent as any).timeoutId) {
            clearTimeout((apiKeyTextComponent as any).timeoutId);
          }

          (apiKeyTextComponent as any).timeoutId = setTimeout(async () => {
            if (value) {
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
        onAfterSave();
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

    if (plugin.settings.showOpenRouterSetting) {
      const isValid = await AIService.validateOpenRouterApiKey(apiKey);

      statusTextEl.textContent = isValid ? 'Valid' : 'Invalid';
      statusTextEl.classList.remove('validating');
      statusTextEl.classList.toggle('valid', isValid);
      statusTextEl.classList.toggle('invalid', !isValid);
    } else {
      statusTextEl.textContent = 'Disabled';
      statusTextEl.classList.remove('validating', 'valid', 'invalid');
    }

    const aiServiceInstance = AIService.getInstance(
      plugin.settings.openAIApiKey,
      plugin.settings.groqAPIKey,
      plugin.settings.openRouterAPIKey,
      {
        openAIApiKey: plugin.settings.openAIApiKey,
        groqAPIKey: plugin.settings.groqAPIKey,
        openRouterAPIKey: plugin.settings.openRouterAPIKey,
        apiEndpoint: plugin.settings.apiEndpoint,
        localEndpoint: plugin.settings.localEndpoint,
        temperature: plugin.settings.temperature,
      }
    );
  }
}
