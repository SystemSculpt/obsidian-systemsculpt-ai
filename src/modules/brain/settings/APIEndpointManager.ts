import { Setting, TextComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';
import { AIService } from '../../../api/AIService';

interface APIEndpoint {
  id: string;
  name: string;
  apiKeySettingName: string;
  apiKeyValidationMethod: (apiKey: string) => Promise<boolean>;
}

const apiEndpoints: APIEndpoint[] = [
  {
    id: 'openAI',
    name: 'OpenAI',
    apiKeySettingName: 'openAIApiKey',
    apiKeyValidationMethod: AIService.validateOpenAIApiKey,
  },
  {
    id: 'groq',
    name: 'Groq',
    apiKeySettingName: 'groqAPIKey',
    apiKeyValidationMethod: AIService.validateGroqAPIKey,
  },
  {
    id: 'openRouter',
    name: 'OpenRouter',
    apiKeySettingName: 'openRouterAPIKey',
    apiKeyValidationMethod: AIService.validateOpenRouterApiKey,
  },
  {
    id: 'localEndpoint',
    name: 'Local',
    apiKeySettingName: 'localEndpoint',
    apiKeyValidationMethod: AIService.validateLocalEndpoint,
  },
];

export function renderAPIEndpointManager(
  containerEl: HTMLElement,
  plugin: BrainModule,
  onAfterSave: () => void
): void {
  const apiEndpointsContainer = containerEl.createDiv(
    'api-endpoints-container'
  );
  apiEndpointsContainer.createEl('h3', { text: 'API Endpoints' });

  const apiEndpointsList =
    apiEndpointsContainer.createDiv('api-endpoints-list');
  const apiEndpointsGroup = apiEndpointsList.createDiv('api-endpoints-group');

  apiEndpoints.forEach(endpoint => {
    renderAPIEndpointToggle(apiEndpointsGroup, plugin, endpoint, onAfterSave);
    renderAPIKeySetting(containerEl, plugin, endpoint, onAfterSave);
  });
}

function renderAPIEndpointToggle(
  containerEl: HTMLElement,
  plugin: BrainModule,
  endpoint: APIEndpoint,
  onAfterSave: () => void
): void {
  const apiEndpointItem = containerEl.createDiv('modal-item');
  const apiEndpointName = apiEndpointItem.createDiv('modal-name');
  apiEndpointName.setText(endpoint.name);

  const toggleComponent = new Setting(apiEndpointItem).addToggle(toggle => {
    toggle.setValue(plugin.settings[`show${endpoint.id}Setting`]);
    toggle.onChange(async value => {
      plugin.settings[`show${endpoint.id}Setting`] = value;
      await plugin.saveSettings();
      await plugin.updateDefaultModelAfterEndpointToggle();
      onAfterSave();
      apiEndpointItem.toggleClass('disabled', !value);
    });
  });
}

function renderAPIKeySetting(
  containerEl: HTMLElement,
  plugin: BrainModule,
  endpoint: APIEndpoint,
  onAfterSave: () => void
): void {
  if (!plugin.settings[`show${endpoint.id}Setting`]) {
    return;
  }

  let apiKeyTextComponent: TextComponent;

  new Setting(containerEl)
    .setName(`${endpoint.name} API Key`)
    .setDesc(`Enter your ${endpoint.name} API key`)
    .addText(text => {
      apiKeyTextComponent = text;
      text
        .setPlaceholder('API Key')
        .setValue(plugin.settings[endpoint.apiKeySettingName])
        .onChange(async (value: string) => {
          plugin.settings[endpoint.apiKeySettingName] = value;
          await plugin.saveSettings();

          if ((apiKeyTextComponent as any).timeoutId) {
            clearTimeout((apiKeyTextComponent as any).timeoutId);
          }

          (apiKeyTextComponent as any).timeoutId = setTimeout(async () => {
            if (value) {
              await validateApiKeyAndUpdateStatus(
                value,
                apiKeyTextComponent,
                endpoint
              );
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
        plugin.settings[endpoint.apiKeySettingName],
        apiKeyTextComponent,
        endpoint
      );
    })
    .addExtraButton(button => {
      button.setIcon('reset');
      button.onClick(async () => {
        await validateApiKeyAndUpdateStatus(
          plugin.settings[endpoint.apiKeySettingName],
          apiKeyTextComponent,
          endpoint
        );
        onAfterSave();
      });
      button.setTooltip('Re-check API Key');
    });
}

async function validateApiKeyAndUpdateStatus(
  apiKey: string,
  textComponent: TextComponent,
  endpoint: APIEndpoint
): Promise<void> {
  const statusTextEl =
    textComponent.inputEl.nextElementSibling || createSpan('api-key-status');
  if (!textComponent.inputEl.nextElementSibling) {
    textComponent.inputEl.insertAdjacentElement('afterend', statusTextEl);
  }

  statusTextEl.textContent = 'Validating...';
  statusTextEl.className = 'api-key-status validating';

  try {
    const isValid = await endpoint.apiKeyValidationMethod(apiKey);
    statusTextEl.textContent = isValid ? 'Valid' : 'Invalid';
    statusTextEl.classList.remove('validating');
    statusTextEl.classList.toggle('valid', isValid);
    statusTextEl.classList.toggle('invalid', !isValid);
  } catch (error) {
    console.error(`Error validating ${endpoint.name} API key:`, error);
    statusTextEl.textContent = 'Error';
    statusTextEl.classList.remove('validating');
    statusTextEl.classList.add('invalid');
  }
}

function createSpan(className: string): HTMLElement {
  const span = document.createElement('span');
  span.className = className;
  return span;
}
