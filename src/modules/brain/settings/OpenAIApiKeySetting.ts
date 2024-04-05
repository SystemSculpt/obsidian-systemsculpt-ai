import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { OpenAIService } from '../../../api/OpenAIService';

export function renderOpenAIApiKeySetting(
  containerEl: HTMLElement,
  plugin: BrainModule
): void {
  let textComponent: TextComponent;

  new Setting(containerEl)
    .setName('OpenAI API Key')
    .setDesc('Enter your OpenAI API key')
    .addText(text => {
      textComponent = text;
      text
        .setPlaceholder('API Key')
        .setValue(plugin.settings.openAIApiKey)
        .onChange(async (value: string) => {
          plugin.settings.openAIApiKey = value;
          await plugin.saveSettings();

          OpenAIService.updateApiKey(value);
          await validateApiKeyAndUpdateStatus(
            value,
            OpenAIService.getInstance(value, plugin.settings),
            textComponent
          );
        });

      textComponent.inputEl.type = 'password';

      textComponent.inputEl.addEventListener('focus', () => {
        textComponent.inputEl.type = 'text';
      });

      textComponent.inputEl.addEventListener('blur', () => {
        textComponent.inputEl.type = 'password';
      });
    })
    .addExtraButton(button => {
      button.setIcon('reset');
      button.onClick(async () => {
        await validateApiKeyAndUpdateStatus(
          plugin.settings.openAIApiKey,
          OpenAIService.getInstance(
            plugin.settings.openAIApiKey,
            plugin.settings
          ),
          textComponent
        );
      });
      button.extraSettingsEl.classList.add('reset-label');
      button.extraSettingsEl.textContent = 'Re-check';
    })
    .then(setting => {
      const text = setting.components[0] as TextComponent;
      validateApiKeyAndUpdateStatus(
        plugin.settings.openAIApiKey,
        OpenAIService.getInstance(
          plugin.settings.openAIApiKey,
          plugin.settings
        ),
        text
      );
    });
}

async function validateApiKeyAndUpdateStatus(
  apiKey: string,
  apiService: OpenAIService,
  textComponent: TextComponent
): Promise<void> {
  const statusTextEl = textComponent.inputEl.nextElementSibling;
  if (!statusTextEl) {
    const newStatusTextEl = createSpan('api-key-status');
    textComponent.inputEl.insertAdjacentElement('afterend', newStatusTextEl);
  }

  const statusText = statusTextEl as HTMLElement;
  statusText.textContent = 'Validating...';
  statusText.classList.remove('valid', 'invalid');
  statusText.classList.add('validating');

  const isValid = await validateApiKey(apiKey, apiService);

  statusText.textContent = isValid ? 'Valid' : 'Invalid';
  statusText.classList.remove('validating');
  statusText.classList.toggle('valid', isValid);
  statusText.classList.toggle('invalid', !isValid);
}

function createSpan(className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  return span;
}

export async function validateApiKey(
  apiKey: string,
  apiService: OpenAIService
): Promise<boolean> {
  return await apiService.validateApiKeyInternal();
}
