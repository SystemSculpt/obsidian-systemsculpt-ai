import { ToggleComponent } from 'obsidian';
import { BrainModule } from '../BrainModule';

export function renderAPIEndpointToggles(
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

  const apiEndpoints = [
    { id: 'openAI', name: 'OpenAI' },
    { id: 'groq', name: 'Groq' },
    { id: 'openRouter', name: 'OpenRouter' },
    { id: 'localEndpoint', name: 'Local' },
  ];

  apiEndpoints.forEach(endpoint => {
    const apiEndpointItem = apiEndpointsGroup.createDiv('modal-item');
    const apiEndpointName = apiEndpointItem.createDiv('modal-name');
    apiEndpointName.setText(endpoint.name);

    const toggleComponent = new ToggleComponent(apiEndpointItem);
    toggleComponent.setValue(plugin.settings[`show${endpoint.id}Setting`]);
    toggleComponent.onChange(async value => {
      plugin.settings[`show${endpoint.id}Setting`] = value;
      await plugin.saveSettings();
      await plugin.updateDefaultModelAfterEndpointToggle();
      onAfterSave();
      apiEndpointItem.toggleClass('disabled', !value);
    });
  });
}
